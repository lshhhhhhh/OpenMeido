/**
 * MemoryService — business logic layer over a MemoryAdapter.
 *
 * Pure cross-platform code. Takes its dependencies (adapter + config
 * accessor + key resolver) as constructor args so the host (Electron main,
 * future PWA service worker, etc.) wires them up however that platform
 * exposes them.
 *
 * Persona scope: the service reads the active persona from config on every
 * operation. Callers don't pass it in — that keeps the agent loop /
 * greeting / proactive code free of plumbing, and a config change
 * propagates to the very next memory call. The adapter handles persona
 * isolation in storage; the service is the place that picks "which
 * persona's bucket should this read/write touch."
 *
 * The host is also responsible for choosing when to instantiate this:
 * lazy init at app whenReady is typical.
 */

import type { Config } from '../../shared/config.js'
import type { AffinityRecord, MemoryAdapter } from './adapter.js'
import { reflect, renderFactsBlock, type ReflectionExtractor } from './reflection.js'
import type {
  Episode,
  EpisodeImage,
  Fact,
  SessionSummary,
  Speaker,
  ToolCallPart,
  ToolResultPart,
} from './types.js'

/** Pluggable embedding function. Host provides; default impl is local bge. */
export type EmbedFn = (text: string) => Promise<Float32Array>

export interface MemoryService {
  /** Embed + persist a single turn (under active persona). */
  addEpisode(
    speaker: Speaker,
    text: string,
    toolParts?: (ToolCallPart | ToolResultPart)[],
    images?: EpisodeImage[],
  ): Promise<number | null>

  /** Build retrieval context for the active persona. */
  retrieve(userMessage: string): Promise<{ recent: Episode[]; recalled: Episode[] }>

  count(): Promise<number>
  listRecent(limit: number, sessionId?: string): Promise<Episode[]>
  listSessions(): Promise<SessionSummary[]>
  clearAll(): Promise<number>
  deleteSession(sessionId: string): Promise<number>
  newSession(): string
  setSession(id: string): void
  currentSession(): string

  // ---- L3 facts (active persona) ----
  listFacts(limit?: number): Promise<Fact[]>
  getUserName(): Promise<string | null>
  factsBlock(minConfidence?: number): Promise<string>
  reflectOnce(): Promise<number>
  clearFacts(): Promise<number>
  /** Manual override for a single fact — used by the Settings UI 🗑.
   *  Deletes the row and its full supersession chain for the same key. */
  deleteFact(factId: number): Promise<boolean>

  // ---- Persona-scoped helpers exposed for UI / migration ----
  /** Active persona id at call time (read from config). */
  activePersona(): string
  /** Affinity record for the active persona (auto-creates zero row). */
  getAffinity(): Promise<AffinityRecord>
  /** Direct affinity write (post-guardrail score). For internal use by
   *  the affinity engine; UI should not call this directly. */
  setAffinity(score: number, reason: string | null): Promise<void>
  /** Drop everything (episodes, facts, affinity) for a given persona. */
  deletePersona(personaId: string): Promise<number>
  /** Read facts for a SPECIFIC persona (UI uses this in the 人物 panel
   *  to show "she knows: …" for personas the user is not currently active). */
  listFactsFor(personaId: string, limit?: number): Promise<Fact[]>
  /** Count episodes for a specific persona — used by the Settings 人物 tab
   *  to show "213 条 episode" per persona without switching. */
  countFor(personaId: string): Promise<number>
  /** Read recent episodes for a SPECIFIC persona (regardless of which is
   *  currently active). The Settings 人物 tab uses this so clicking a
   *  chip immediately previews that persona's history without requiring
   *  a save-and-switch. */
  listRecentFor(personaId: string, limit: number): Promise<Episode[]>
}

export interface MemoryServiceDeps {
  adapter: MemoryAdapter
  /** Called per-operation so config changes apply immediately. */
  getConfig: () => Config
  embed: EmbedFn
  isNaiveMode?: () => boolean
  onError?: (operation: string, message: string) => void
  reflectExtractor?: ReflectionExtractor
  initialSessionId?: string
}

function makeSessionId(): string {
  return globalThis.crypto.randomUUID()
}

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
  const { adapter, embed, getConfig, onError, reflectExtractor, initialSessionId, isNaiveMode } = deps
  const naive = (): boolean => isNaiveMode?.() ?? false
  /** Always read the persona at the moment of the operation, never cache.
   *  Config changes mid-session must take effect on the next memory call. */
  const persona = (): string => getConfig().persona.preset

  let sessionId = initialSessionId ?? makeSessionId()
  let reflecting = false

  const reportError = (operation: string, err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[memory] ${operation} failed:`, err)
    onError?.(operation, message)
  }

  return {
    activePersona() {
      return persona()
    },

    async addEpisode(speaker, text, toolParts, images) {
      const hasTool = !!(toolParts && toolParts.length > 0)
      const hasImages = !!(images && images.length > 0)
      if (!text.trim() && !hasTool && !hasImages) return null
      try {
        if (naive()) {
          const zeros = new Float32Array(0)
          return await adapter.addEpisode(
            persona(),
            speaker,
            text,
            zeros,
            sessionId,
            toolParts,
            images,
          )
        }
        const vec = await withTimeout(embed(text || ' '), 5_000, 'embed timed out')
        return await adapter.addEpisode(
          persona(),
          speaker,
          text,
          vec,
          sessionId,
          toolParts,
          images,
        )
      } catch (err) {
        reportError('addEpisode', err)
        return null
      }
    },

    async retrieve(userMessage) {
      const cfg = getConfig()
      const recent = await adapter.recent(persona(), cfg.memory.recentN)
      let recalled: Episode[] = []
      if (!naive() && cfg.memory.topK > 0 && userMessage.trim()) {
        try {
          const qVec = await withTimeout(embed(userMessage), 5_000, 'embed timed out')
          const exclude = new Set(recent.map((e) => e.id))
          recalled = await adapter.searchByEmbedding(persona(), qVec, cfg.memory.topK, exclude)
        } catch (err) {
          reportError('retrieve', err)
        }
      }
      return { recent, recalled }
    },

    count() {
      return adapter.count(persona())
    },

    listRecent(limit, sessionIdArg) {
      return adapter.recent(persona(), limit, sessionIdArg)
    },

    listSessions() {
      return adapter.listSessions(persona())
    },

    clearAll() {
      return adapter.clear(persona())
    },

    deleteSession(id) {
      return adapter.deleteSession(persona(), id)
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
      return adapter.listActiveFacts(persona(), limit)
    },

    async listFactsFor(personaId, limit = 200) {
      return adapter.listActiveFacts(personaId, limit)
    },

    async countFor(personaId) {
      return adapter.count(personaId)
    },

    async listRecentFor(personaId, limit) {
      return adapter.recent(personaId, limit)
    },

    async getUserName() {
      try {
        const facts = await adapter.listActiveFacts(persona(), 200)
        const aliases = ['user.profile.name', 'user.name', 'name', 'username']
        for (const key of aliases) {
          const f = facts.find((x) => x.key === key)
          if (f && f.value.trim()) return f.value.trim()
        }
        return null
      } catch (err) {
        reportError('getUserName', err)
        return null
      }
    },

    async factsBlock(minConfidence) {
      try {
        const facts = await adapter.listActiveFacts(persona(), 200)
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
        const window = Math.max(cfg.memory.recentN, 12)
        const recent = await adapter.recent(persona(), window)
        const facts = await reflect(recent, reflectExtractor)
        if (!facts || facts.length === 0) return 0
        let upserted = 0
        for (const f of facts) {
          try {
            await adapter.upsertFact(persona(), f)
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
      return adapter.clearFacts(persona())
    },

    async deleteFact(factId) {
      return adapter.deleteFact(persona(), factId)
    },

    async getAffinity() {
      return adapter.getAffinity(persona())
    },

    async setAffinity(score, reason) {
      return adapter.setAffinity(persona(), score, reason)
    },

    async deletePersona(personaId) {
      return adapter.deletePersona(personaId)
    },
  }
}
