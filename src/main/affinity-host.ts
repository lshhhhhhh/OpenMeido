/**
 * Affinity host — wires the pure guardrail engine (shared/affinity.ts) to
 * the in-memory rate-limit state, the persisted score (via MemoryService),
 * and the renderer broadcast.
 *
 * Public surface:
 *   - applyJudgement(personaId, rawDelta, reason) — call after every
 *     successful judge response
 *   - applyDecayPass() — call from a timer
 *   - currentTier(personaId) — synchronous "for prompt assembly" helper;
 *     reads the last-known score from cache, falling back to 0
 *
 * In-memory state is per-process; restart resets daily usage + recent
 * deltas, which is acceptable (worst case: a user could "re-buy" some
 * daily quota by restarting, but the per-turn clamp limits actual abuse).
 */

import { BrowserWindow } from 'electron'

import { getConfig } from './config.js'
import { getMemoryService, getMemoryAdapter } from './memory-host.js'
import {
  applyDecay,
  applyDeltaWithGuardrails,
  tierFor,
  type TierInfo,
} from '../shared/affinity.js'

interface PersonaState {
  /** YYYY-MM-DD string in local time — when this rolled over we reset usage. */
  date: string
  /** |delta| accumulated today (across all signs). */
  todayAbsDelta: number
  /** Last 2 effective deltas (newest first). Feeds the rolling median. */
  recentDeltas: number[]
  /** Cached score so currentTier() can run synchronously without a DB read.
   *  Refreshed whenever the engine writes; falls back to 0 on cold start. */
  cachedScore: number
}

const state = new Map<string, PersonaState>()

function todayString(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${day}`
}

function getOrInit(personaId: string): PersonaState {
  const today = todayString()
  let s = state.get(personaId)
  if (!s) {
    s = { date: today, todayAbsDelta: 0, recentDeltas: [], cachedScore: 0 }
    state.set(personaId, s)
  } else if (s.date !== today) {
    s.date = today
    s.todayAbsDelta = 0
    s.recentDeltas = []
  }
  return s
}

/**
 * Process one judge result. Reads current affinity + lifetime turn count
 * from the memory service, applies guardrails, persists, broadcasts.
 * Returns the new score (useful for tests / debug).
 *
 * Errors are swallowed (warned) so a side-task failure never breaks chat.
 */
export async function applyJudgement(
  personaId: string,
  rawDelta: number,
  reason: string,
): Promise<number | null> {
  const memory = getMemoryService()
  if (!memory) return null
  try {
    const record = await memory.getAffinity()
    const lifetimeTurns = await memory.countFor(personaId)
    const s = getOrInit(personaId)
    s.cachedScore = record.score
    const result = applyDeltaWithGuardrails({
      currentScore: record.score,
      rawDelta,
      lifetimeTurns,
      todayAbsDelta: s.todayAbsDelta,
      recentDeltas: s.recentDeltas,
    })
    if (result.finalScore === record.score) {
      // No movement to persist — but still log so debug-level "why?" is
      // visible. Reason is whatever the judge said; note is the engine
      // explanation (clamp / damp / cap).
      console.log(
        `[affinity] ${personaId} unchanged (raw=${rawDelta} ${result.note ?? ''}): ${reason}`,
      )
      return record.score
    }
    await memory.setAffinity(result.finalScore, reason)
    s.cachedScore = result.finalScore
    s.todayAbsDelta += Math.abs(result.effectiveDelta)
    s.recentDeltas = [result.effectiveDelta, ...s.recentDeltas].slice(0, 2)
    console.log(
      `[affinity] ${personaId} ${record.score} → ${result.finalScore} ` +
        `(Δ${result.effectiveDelta >= 0 ? '+' : ''}${result.effectiveDelta}` +
        `${result.note ? ', ' + result.note : ''}): ${reason}`,
    )
    broadcastAffinityChanged(personaId, result.finalScore, reason)
    return result.finalScore
  } catch (err) {
    console.warn('[affinity] applyJudgement failed:', err)
    return null
  }
}

/**
 * Decay pass — call on startup and from a periodic timer. Iterates every
 * persona that has an affinity row and shaves -1 per day idle, floor 30.
 */
export async function applyDecayPass(): Promise<void> {
  const memory = getMemoryService()
  if (!memory) return
  // We only know about personas that have been written to. Iterate the
  // built-in ids + any custom persona currently in config.
  try {
    const cfg = getConfig()
    const builtinIds = ['maid', 'imouto', 'ojou']
    const customIds = cfg.persona.customs.map((c) => c.id)
    const all = [...builtinIds, ...customIds]
    const adapter = getMemoryAdapter()
    if (!adapter) return
    for (const pid of all) {
      const record = await adapter.getAffinity(pid)
      if (record.score <= 0) continue // nothing to decay
      const days = daysSince(record.lastUpdated)
      const decayed = applyDecay(record.score, days)
      if (decayed !== record.score) {
        await adapter.setAffinity(
          pid,
          decayed,
          `${days} 天没说话，自然冷却一点`,
        )
        console.log(`[affinity] decay ${pid} ${record.score} → ${decayed} (${days}d idle)`)
      }
    }
  } catch (err) {
    console.warn('[affinity] decay pass failed:', err)
  }
}

function daysSince(iso: string): number {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return 0
  const ms = Date.now() - then
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)))
}

/**
 * Synchronous tier lookup — used at prompt-assembly time. Reads from the
 * in-memory cache populated by applyJudgement. On a fresh process boot
 * the cache is empty, returns tier for 0 (stranger) — chat-host should
 * call refreshCachedScore() during init to seed the right value.
 */
export function currentTier(personaId: string): TierInfo {
  const s = state.get(personaId)
  return tierFor(s?.cachedScore ?? 0)
}

/**
 * Seed the cache from persisted state. Call at boot for the active
 * persona and whenever the user switches personas.
 */
export async function refreshCachedScore(personaId: string): Promise<void> {
  try {
    // Use the per-persona adapter path so this works for non-active
    // personas too (sidebar may want to render multiple at once).
    const adapter = getMemoryAdapter()
    if (!adapter) return
    const record = await adapter.getAffinity(personaId)
    getOrInit(personaId).cachedScore = record.score
  } catch (err) {
    console.warn('[affinity] refresh failed:', err)
  }
}

function broadcastAffinityChanged(
  personaId: string,
  score: number,
  reason: string,
): void {
  const tier = tierFor(score)
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('affinity:changed', { personaId, score, tier, reason })
    }
  }
}

/** Initial wiring: seed cache for the active persona and start the decay timer. */
export function initAffinity(activePersona: string): void {
  void refreshCachedScore(activePersona)
  void applyDecayPass()
  // Re-run decay every 6 hours. Short enough that long-running sessions
  // see updates within the day, cheap enough to be invisible.
  setInterval(() => void applyDecayPass(), 6 * 60 * 60 * 1000)
}
