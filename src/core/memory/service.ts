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
import type { Episode, Speaker } from './types.js'
import { embed, type EmbedOptions } from './embed.js'

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
}

export interface MemoryServiceDeps {
  adapter: MemoryAdapter
  /** Called per-operation so config changes apply immediately. */
  getConfig: () => Config
  /** Returns the resolved API key for embedding calls. */
  resolveApiKey: () => string
}

export function createMemoryService(deps: MemoryServiceDeps): MemoryService {
  const { adapter, getConfig, resolveApiKey } = deps

  const embedOpts = (): EmbedOptions => {
    const cfg = getConfig()
    return {
      baseUrl: cfg.embedding.baseUrl || cfg.backend.baseUrl,
      apiKey: cfg.embedding.apiKey || resolveApiKey(),
      model: cfg.embedding.model,
      dim: cfg.embedding.dim,
    }
  }

  return {
    async addEpisode(speaker, text) {
      if (!text.trim()) return null
      try {
        const vec = await embed(text, embedOpts())
        return await adapter.addEpisode(speaker, text, vec)
      } catch (err) {
        console.warn('[memory] addEpisode failed:', err)
        return null
      }
    },

    async retrieve(userMessage) {
      const cfg = getConfig()
      const recent = await adapter.recent(cfg.memory.recentN)
      let recalled: Episode[] = []
      if (cfg.memory.topK > 0 && userMessage.trim()) {
        try {
          const qVec = await embed(userMessage, embedOpts())
          const exclude = new Set(recent.map((e) => e.id))
          recalled = await adapter.searchByEmbedding(qVec, cfg.memory.topK, exclude)
        } catch (err) {
          console.warn('[memory] retrieve search failed:', err)
        }
      }
      return { recent, recalled }
    },

    count() {
      return adapter.count()
    },
  }
}
