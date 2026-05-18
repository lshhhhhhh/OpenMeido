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
import type { Episode, SessionSummary, Speaker } from './types.js'

/** Pluggable embedding function. Host provides; default impl is local bge. */
export type EmbedFn = (text: string) => Promise<Float32Array>

export interface MemoryService {
  /**
   * Embed + persist a single turn. Returns null on any failure — a missed
   * memory write must never break chat. Errors are logged via console.warn
   * so the host can pipe them somewhere visible.
   */
  addEpisode(speaker: Speaker, text: string): Promise<number | null>

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
}

/** crypto.randomUUID is on globalThis in Node 20+ and all browsers we support. */
function makeSessionId(): string {
  return globalThis.crypto.randomUUID()
}

export function createMemoryService(deps: MemoryServiceDeps): MemoryService {
  const { adapter, embed, getConfig, onError } = deps

  let sessionId = makeSessionId()

  const reportError = (operation: string, err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[memory] ${operation} failed:`, err)
    onError?.(operation, message)
  }

  return {
    async addEpisode(speaker, text) {
      if (!text.trim()) return null
      try {
        const vec = await embed(text)
        return await adapter.addEpisode(speaker, text, vec, sessionId)
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
          const qVec = await embed(userMessage)
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
  }
}
