/**
 * MemoryService — business logic layer over a MemoryAdapter.
 *
 * Pure cross-platform code. Takes its dependencies (adapter + config
 * accessor + key resolver) as constructor args so the host (Electron main,
 * future PWA service worker, etc.) wires them up however that platform
 * exposes them.
 *
 * The host is also responsible for choosing when to instantiate this:
 * lazy init at app whenReady is typical.
 */

import type { Config } from '../../shared/config.js'
import type { MemoryAdapter } from './adapter.js'
import { reflect, renderFactsBlock, type ReflectionExtractor } from './reflection.js'
import type {
  Episode,
  Fact,
  SessionSummary,
  Speaker,
  ToolCallPart,
  ToolResultPart,
} from './types.js'

/** Pluggable embedding function. Host provides; default impl is local bge. */
export type EmbedFn = (text: string) => Promise<Float32Array>

export interface MemoryService {
  /**
   * Embed + persist a single turn. Returns null on any failure — a missed
   * memory write must never break chat. Errors are logged via console.warn
   * so the host can pipe them somewhere visible.
   *
   * `toolParts` carries agent-loop structure (see MemoryAdapter.addEpisode).
   */
  addEpisode(
    speaker: Speaker,
    text: string,
    toolParts?: (ToolCallPart | ToolResultPart)[],
  ): Promise<number | null>

  /**
   * Build the context for the NEXT model call: top-K semantically relevant
   * past episodes (excluding ones already in the recent window) plus the
   * recent-N window itself.
   */
  retrieve(userMessage: string): Promise<{ recent: Episode[]; recalled: Episode[] }>

  /** Diagnostic — episode count. */
  count(): Promise<number>

  /** Most-recent N episodes for the Memory inspection UI; optionally one session only. */
  listRecent(limit: number, sessionId?: string): Promise<Episode[]>

  /** Per-session summaries with first-user-message preview for the picker. */
  listSessions(): Promise<SessionSummary[]>

  /** Wipe everything. Returns rows removed. */
  clearAll(): Promise<number>

  /** Delete a single session's episodes. */
  deleteSession(sessionId: string): Promise<number>

  /** Generate a new session id; future addEpisode calls tag with it. */
  newSession(): string

  /** Switch the active session to an existing id (continue an old chat). */
  setSession(id: string): void

  /** Current session id (what new turns are being tagged with). */
  currentSession(): string

  // ---- L3 facts ----

  /** Active facts (supersededBy IS NULL), newest first. */
  listFacts(limit?: number): Promise<Fact[]>

  /**
   * Build the system-prompt fragment that lists known user facts. Returns
   * empty string when there's nothing worth injecting (no facts above the
   * confidence threshold). Cached implicitly per-call by the caller —
   * service doesn't memo because facts can change between turns.
   */
  factsBlock(minConfidence?: number): Promise<string>

  /**
   * Drive one reflection pass: pull the last N episodes, ask the LLM to
   * distill facts, upsert what comes back. Best-effort — failures don't
   * throw, just log. Returns the number of facts upserted (0 if no
   * extractor configured or extraction failed).
   */
  reflectOnce(): Promise<number>

  /**
   * Wipe all L3 facts (history included). Returns rows removed. Use from
   * the Memory tab "clear all" action.
   */
  clearFacts(): Promise<number>
}

export interface MemoryServiceDeps {
  adapter: MemoryAdapter
  /** Called per-operation so config changes apply immediately. */
  getConfig: () => Config
  /** Pluggable embedding function. Production uses local bge-small-zh. */
  embed: EmbedFn
  /**
   * Optional sink for "addEpisode failed" / "retrieve failed" notices.
   * The host (Electron main) wires this up to broadcast to renderer
   * windows so silent storage failures become visible to the user.
   */
  onError?: (operation: string, message: string) => void
  /**
   * Optional LLM extractor for L3 fact reflection. When absent, reflectOnce
   * is a no-op (just returns 0). The host wires this to the same chat
   * provider it uses for normal turns.
   */
  reflectExtractor?: ReflectionExtractor
  /**
   * Session id to start with. Host should pass the most-recent session id
   * (looked up before construction) so chat continues across restarts.
   * When omitted, a fresh session id is minted.
   */
  initialSessionId?: string
}

/** crypto.randomUUID is on globalThis in Node 20+ and all browsers we support. */
function makeSessionId(): string {
  return globalThis.crypto.randomUUID()
}

/**
 * Wrap a promise with a hard timeout. Used to protect chat from hanging
 * on a slow embed() call (transformers.js doesn't time out network
 * fetches itself — in mainland China without a mirror, the TCP connect
 * to huggingface.co can stall for minutes).
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} (${ms}ms)`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

export function createMemoryService(deps: MemoryServiceDeps): MemoryService {
  const { adapter, embed, getConfig, onError, reflectExtractor, initialSessionId } = deps

  // Resume the previous session by default — users expect chat continuity
  // across restarts; they only get a fresh session when they explicitly
  // pick "新建会话" in the Memory tab. The host resolves the most-recent
  // session id synchronously before constructing us (see memory-host.ts);
  // if it didn't find one, we mint a brand new one here.
  let sessionId = initialSessionId ?? makeSessionId()
  // In-flight guard for reflectOnce — prevents two reflection cycles
  // overlapping when called from both a timer and a turn count threshold.
  let reflecting = false

  const reportError = (operation: string, err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[memory] ${operation} failed:`, err)
    onError?.(operation, message)
  }

  return {
    async addEpisode(speaker, text, toolParts) {
      // Tool-result rows can have empty text (the result is in toolParts)
      // and assistant tool-only steps can be empty too. Allow empty text
      // when there's at least toolParts. Reject only truly empty turns.
      if (!text.trim() && (!toolParts || toolParts.length === 0)) return null
      try {
        // Same 5s ceiling as retrieve(). addEpisode is fire-and-forget
        // from chat.ts (we void the promise), so the user isn't blocked
        // on it — but if embed() hangs forever, we leak timers and
        // eventually OOM. Bail loudly instead.
        const vec = await withTimeout(embed(text || ' '), 5_000, 'embed timed out')
        return await adapter.addEpisode(speaker, text, vec, sessionId, toolParts)
      } catch (err) {
        reportError('addEpisode', err)
        return null
      }
    },

    async retrieve(userMessage) {
      const cfg = getConfig()
      const recent = await adapter.recent(cfg.memory.recentN)
      let recalled: Episode[] = []
      if (cfg.memory.topK > 0 && userMessage.trim()) {
        try {
          // 5s timeout on the embed call. Without this, when the bge model
          // download is reachable-but-slow (e.g. huggingface.co from
          // mainland China, where TCP connect can hang for minutes), the
          // whole chat turn is blocked — user types "总结邮件" and sees
          // "思考中…" forever. Better to skip semantic recall this turn
          // than to stall the whole agent loop.
          const qVec = await withTimeout(
            embed(userMessage),
            5_000,
            'embed timed out',
          )
          const exclude = new Set(recent.map((e) => e.id))
          recalled = await adapter.searchByEmbedding(qVec, cfg.memory.topK, exclude)
        } catch (err) {
          reportError('retrieve', err)
        }
      }
      return { recent, recalled }
    },

    count() {
      return adapter.count()
    },

    listRecent(limit, sessionId) {
      return adapter.recent(limit, sessionId)
    },

    listSessions() {
      return adapter.listSessions()
    },

    clearAll() {
      return adapter.clear()
    },

    deleteSession(id) {
      return adapter.deleteSession(id)
    },

    newSession() {
      sessionId = makeSessionId()
      return sessionId
    },

    setSession(id) {
      sessionId = id
    },

    currentSession() {
      return sessionId
    },

    async listFacts(limit = 200) {
      return adapter.listActiveFacts(limit)
    },

    async factsBlock(minConfidence) {
      try {
        const facts = await adapter.listActiveFacts(200)
        return renderFactsBlock(facts, minConfidence)
      } catch (err) {
        reportError('factsBlock', err)
        return ''
      }
    },

    async reflectOnce() {
      if (!reflectExtractor) return 0
      if (reflecting) return 0
      reflecting = true
      try {
        const cfg = getConfig()
        // Use the same window size as recent-context retrieval — keeps
        // the cost predictable and ensures we don't replay episodes the
        // model has already seen as L1 context.
        const window = Math.max(cfg.memory.recentN, 12)
        const recent = await adapter.recent(window)
        const facts = await reflect(recent, reflectExtractor)
        if (!facts || facts.length === 0) return 0
        let upserted = 0
        for (const f of facts) {
          try {
            await adapter.upsertFact(f)
            upserted += 1
          } catch (err) {
            reportError('upsertFact', err)
          }
        }
        return upserted
      } catch (err) {
        reportError('reflectOnce', err)
        return 0
      } finally {
        reflecting = false
      }
    },

    async clearFacts() {
      return adapter.clearFacts()
    },
  }
}
