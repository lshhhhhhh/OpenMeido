/**
 * MemoryStore — façade over the DB + embed client + episodic store.
 *
 * Lazy-initialized so the renderer can be up and showing UI even if memory
 * fails to come online (e.g. better-sqlite3 binary missing, embed API
 * unreachable). Failures degrade to "no memory this turn" rather than
 * blocking chat.
 */

import { onConfigChange, resolveApiKey } from '../config.js'
import type { Config } from '../../shared/config.js'
import { embed, type EmbedOptions } from './embed.js'
import { openDb, type DbHandle } from './db.js'
import { EpisodicStore, type Episode, type Speaker } from './episodic.js'

/** Pull the per-call embed opts out of the current config. */
function embedOpts(cfg: Config): EmbedOptions {
  return {
    baseUrl: cfg.embedding.baseUrl || cfg.backend.baseUrl,
    apiKey: cfg.embedding.apiKey || resolveApiKey(cfg),
    model: cfg.embedding.model,
    dim: cfg.embedding.dim,
  }
}

let handle: DbHandle | null = null
let episodic: EpisodicStore | null = null
let initError: string | null = null

/**
 * Initialize once at app whenReady. Safe to call again — no-op if already up.
 *
 * `dataDir` is the directory the sqlite file lives in. Caller passes
 * `app.getPath('userData')` from the running Electron app, or any tmp dir
 * from a Node smoke test.
 */
export function initMemory(cfg: Config, dataDir: string): void {
  if (handle || initError) return
  if (!cfg.memory.enabled) return
  try {
    handle = openDb(cfg.embedding.dim, dataDir)
    episodic = new EpisodicStore(handle.db)
    console.log('[memory] ready at', dataDir, 'dim=' + cfg.embedding.dim)
  } catch (err) {
    initError = err instanceof Error ? err.message : String(err)
    console.error('[memory] init failed — running without memory:', err)
  }
}

export function isReady(): boolean {
  return episodic !== null
}

export function getInitError(): string | null {
  return initError
}

/**
 * Persist a single turn. Awaits the embedding so callers can sequence writes,
 * but swallows errors — a missed memory write should never break chat.
 */
export async function addEpisode(
  speaker: Speaker,
  text: string,
  cfg: Config,
): Promise<number | null> {
  if (!episodic || !text.trim()) return null
  try {
    const vec = await embed(text, embedOpts(cfg))
    return episodic.add(speaker, text, vec)
  } catch (err) {
    console.warn('[memory] addEpisode failed:', err)
    return null
  }
}

/**
 * Build the context for the NEXT model turn: top-K semantically relevant
 * past episodes (excluding ones already covered by the recent window) plus
 * the recent-N window. Both lists are returned in chronological order so
 * the caller can interleave them into the prompt as needed.
 */
export async function retrieve(
  userMessage: string,
  cfg: Config,
): Promise<{ recent: Episode[]; recalled: Episode[] }> {
  if (!episodic) return { recent: [], recalled: [] }
  const recent = episodic.recent(cfg.memory.recentN)
  let recalled: Episode[] = []
  if (cfg.memory.topK > 0 && userMessage.trim()) {
    try {
      const qVec = await embed(userMessage, embedOpts(cfg))
      const exclude = new Set(recent.map((e) => e.id))
      recalled = episodic.search(qVec, cfg.memory.topK, exclude)
    } catch (err) {
      console.warn('[memory] retrieve search failed:', err)
    }
  }
  return { recent, recalled }
}

export function episodeCount(): number {
  return episodic?.count() ?? 0
}

// Re-init if embedding dim changes (rare). Note: dim change WITH existing
// rows means the vec table's row count won't match — we'd need a migration,
// which is out of scope for v1. Log a warning instead.
onConfigChange((next) => {
  if (handle && next.embedding.dim !== handle.dim) {
    console.warn(
      `[memory] embedding.dim changed (${handle.dim} -> ${next.embedding.dim}). ` +
        'Existing vectors will mismatch the new dim; consider deleting memory.sqlite.',
    )
  }
})
