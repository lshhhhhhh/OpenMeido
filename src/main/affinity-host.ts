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
  AFFINITY_INITIAL,
  AFFINITY_MAX,
  PRESENCE_SCORE_CEILING,
  applyDecay,
  applyDeltaWithGuardrails,
  buildTierPromptBlock,
  curveDelta,
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
    const s = getOrInit(personaId)
    s.cachedScore = record.score
    const result = applyDeltaWithGuardrails({
      currentScore: record.score,
      rawDelta,
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
    broadcastAffinityChanged(personaId, result.finalScore, reason, result.effectiveDelta)

    // Milestone detection — when the score crosses a tier boundary
    // upward (20 / 40 / 60 / 80), fire a one-off "she notices the
    // relationship shifted" remark. Fire-and-forget; don't block the
    // judgement return path.
    const crossed = milestoneCrossed(record.lastMilestone, result.finalScore)
    if (crossed !== null) {
      console.log(`[affinity] milestone crossed: ${personaId} → Lv.${crossed / 20 + 1}`)
      void fireMilestone(personaId, result.finalScore, crossed).catch((err) => {
        console.warn('[affinity] milestone fire failed:', err)
      })
    }

    return result.finalScore
  } catch (err) {
    console.warn('[affinity] applyJudgement failed:', err)
    return null
  }
}

/**
 * Passive presence bump — small fractional affinity gain for having the
 * user nearby. Different from `applyJudgement`:
 *   - no LLM call (no judge, no reason synthesis)
 *   - HARD-CAPS at PRESENCE_SCORE_CEILING — deep relationship still
 *     requires real interaction, can't be ground out by leaving the
 *     window open
 *   - respects the 0..100 score bounds
 *   - does NOT touch the per-day judge cap or the rolling-median buffer
 *     (presence is a separate budget tracked by presence-host)
 *
 * `amount` is the raw points to add (before the diminishing curve).
 * The curve scales it down at higher scores so the meaningful payout
 * shrinks as the relationship matures. Returns null if no movement
 * (ceiling reached / memory not ready); otherwise the before+after
 * scores so the caller can decide what to log.
 */
export async function applyPresenceBump(
  personaId: string,
  amount: number,
  reason: string,
): Promise<{ before: number; after: number } | null> {
  const memory = getMemoryService()
  if (!memory) return null
  try {
    const record = await memory.getAffinity()
    if (record.score >= PRESENCE_SCORE_CEILING) return null
    const s = getOrInit(personaId)
    s.cachedScore = record.score
    const curved = curveDelta(amount, record.score)
    const next = Math.min(
      AFFINITY_MAX,
      Math.min(PRESENCE_SCORE_CEILING, record.score + curved),
    )
    if (next === record.score) return null
    await memory.setAffinity(next, reason)
    s.cachedScore = next
    // Intentionally not touching todayAbsDelta or recentDeltas — presence
    // is its own budget tracked by presence-host. Mixing them caused the
    // rolling-median sign-flip class of bugs (presence's many small
    // positives swamping a single judge negative).
    broadcastAffinityChanged(personaId, next, reason, next - record.score)

    // Milestone check — passive accrual can still cross tier boundaries.
    const crossed = milestoneCrossed(record.lastMilestone, next)
    if (crossed !== null) {
      console.log(
        `[affinity] milestone crossed via presence: ${personaId} → Lv.${crossed / 20 + 1}`,
      )
      void fireMilestone(personaId, next, crossed).catch((err) => {
        console.warn('[affinity] milestone fire failed:', err)
      })
    }
    return { before: record.score, after: next }
  } catch (err) {
    console.warn('[affinity] applyPresenceBump failed:', err)
    return null
  }
}

/**
 * Returns the new milestone band the score just crossed upward into
 * (one of 20 / 40 / 60 / 80), or null if no band was crossed. The
 * caller persists the new milestone via setLastMilestone so the same
 * boundary doesn't re-fire on subsequent score updates.
 */
function milestoneCrossed(lastMilestone: number, newScore: number): number | null {
  const BANDS = [20, 40, 60, 80]
  for (const b of BANDS) {
    if (newScore >= b && lastMilestone < b) return b
  }
  return null
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

/**
 * Broadcast a score change to all renderers. Includes the effective
 * delta when known — the renderer renders it as a floating "+1" /
 * "-1" damage-number-style popup over the affinity chip. Pass
 * `delta=null` (default) for changes the user didn't "earn" and
 * shouldn't be celebrated/lamented (decay, manual dev override) —
 * the chip updates silently in that case.
 */
function broadcastAffinityChanged(
  personaId: string,
  score: number,
  reason: string,
  delta: number | null = null,
): void {
  const tier = tierFor(score)
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('affinity:changed', {
        personaId,
        score,
        tier,
        reason,
        delta,
      })
    }
  }
}

/** Initial wiring: seed cache for the active persona and start the decay timer. */
export function initAffinity(activePersona: string): void {
  void seedInitialIfFresh(activePersona)
    .then(() => refreshCachedScore(activePersona))
    .then(() => {
      // Dev convenience: OPENMEIDO_DEV_AFFINITY=N at boot overrides the
      // active persona's score so we can preview Lv.1 / Lv.5 prompt
      // behavior without grinding chat. Silently ignored when unset,
      // out of range, or unparseable.
      const raw = process.env.OPENMEIDO_DEV_AFFINITY
      if (!raw) return
      const n = Number(raw)
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        console.warn(`[affinity] OPENMEIDO_DEV_AFFINITY="${raw}" not in [0,100], ignored`)
        return
      }
      void setAffinityForTest(activePersona, n, `dev override (OPENMEIDO_DEV_AFFINITY=${n})`)
        .then(() => console.log(`[affinity] dev override applied: ${activePersona} → ${n}`))
        .catch((err) => console.warn('[affinity] dev override failed:', err))
    })
  void applyDecayPass()
  // Re-run decay every 6 hours. Short enough that long-running sessions
  // see updates within the day, cheap enough to be invisible.
  setInterval(() => void applyDecayPass(), 6 * 60 * 60 * 1000)
}

/**
 * If this persona has never received a judgement (score=0 + no last
 * reason), seed the score to AFFINITY_INITIAL so the chip's
 * tier-progress bar has a visible fill from day 1. Skipped silently
 * for existing users — score=0 with a non-null lastReason means they
 * earned that 0 and we shouldn't gift them points.
 */
async function seedInitialIfFresh(personaId: string): Promise<void> {
  const adapter = getMemoryAdapter()
  if (!adapter) return
  try {
    const record = await adapter.getAffinity(personaId)
    const isFreshInstall = record.score === 0 && record.lastReason === null
    if (!isFreshInstall) return
    await adapter.setAffinity(personaId, AFFINITY_INITIAL, null)
    console.log(`[affinity] fresh persona "${personaId}" seeded → ${AFFINITY_INITIAL}`)
  } catch (err) {
    console.warn('[affinity] initial seed failed:', err)
  }
}

/**
 * Force the persona's affinity to a specific score. Bypasses every
 * normal guardrail (per-turn clamp, rolling median, daily cap, curve)
 * because the point of this entry IS to preview a tier without
 * earning it. Writes to sqlite + updates the in-memory cache +
 * broadcasts affinity:changed so the UI chip refreshes immediately.
 *
 * Used by:
 *   - OPENMEIDO_DEV_AFFINITY env var at boot (above)
 *   - `affinity:setForTest` IPC for runtime DevTools toggles
 *   - Future "reset relationship" Settings button if we add one
 *
 * NOT exposed to users via the normal Settings UI — there's no
 * production reason to let someone hand-edit the score, and doing so
 * undermines the relationship metric. If you find yourself wanting
 * this in shipped UI, reconsider; you probably want the "clear
 * memory" button instead.
 */
export async function setAffinityForTest(
  personaId: string,
  score: number,
  reason: string,
): Promise<void> {
  const adapter = getMemoryAdapter()
  if (!adapter) throw new Error('memory adapter not initialized')
  const clamped = Math.max(0, Math.min(100, score))
  await adapter.setAffinity(personaId, clamped, reason)
  getOrInit(personaId).cachedScore = clamped
  broadcastAffinityChanged(personaId, clamped, reason)
}

/**
 * Fire a milestone remark — she notices the relationship just stepped
 * up a tier. Delivered through the existing proactive:remark channel
 * so the renderer's bubble + TTS + classifier all work as if she
 * spontaneously opened up. Persists the new milestone so the same
 * band never fires twice.
 *
 * Soft-fails (logs + continues) if memory / chat host isn't ready.
 */
async function fireMilestone(
  personaId: string,
  score: number,
  newMilestone: number,
): Promise<void> {
  const { resolvePersona } = await import('../shared/config.js')
  const { runExtraction } = await import('./chat-host.js')
  const { getConfig } = await import('./config.js')
  const { buildMilestonePrompt } = await import('../shared/daily-prompts.js')
  const { classifyAndApply } = await import('./emotion-classifier.js')

  const cfg = getConfig()
  // Milestones are persona-scoped — only fire when this persona is
  // the user's currently active one. Firing for a non-active persona
  // would surface a remark from a character the user isn't currently
  // chatting with, which is confusing.
  if (cfg.persona.preset !== personaId) {
    console.log(`[affinity] milestone skipped: ${personaId} is not active persona`)
    // Still mark it persisted so re-becoming-active doesn't re-fire
    // an outdated milestone.
    const adapter = getMemoryAdapter()
    if (adapter) await adapter.setLastMilestone(personaId, newMilestone)
    return
  }

  const persona = resolvePersona(cfg.persona)
  const tierBlock = buildTierPromptBlock(score, persona.name, persona.traits)
  // Pull a tiny bit of memory for grounding — the milestone remark
  // should reference real shared history, not invent.
  const memory = getMemoryService()
  const factsBlock = memory ? await memory.factsBlock(0.5).catch(() => '') : ''
  const recent = memory ? await memory.listRecent(20).catch(() => []) : []
  const recentUserMessages = recent
    .filter((e) => e.speaker === 'user' && e.text.trim())
    .slice(-4)
    .map((e) => (e.text.length > 120 ? e.text.slice(0, 120) + '…' : e.text))

  const prompt = buildMilestonePrompt({
    persona,
    tierBlock,
    score,
    factsBlock,
    recentUserMessages,
  })
  let line = ''
  try {
    const raw = await runExtraction(prompt, { temperature: 0.85 })
    line = raw.trim()
  } catch (err) {
    console.warn('[affinity] milestone LLM call failed:', err)
    return
  }
  if (!line || line.length < 8) return

  // Persist the new milestone band BEFORE broadcasting — guarantees
  // we won't re-fire on a duplicate event from the same boundary
  // cross.
  const adapter = getMemoryAdapter()
  if (adapter) await adapter.setLastMilestone(personaId, newMilestone)

  // Persist as an assistant episode so future retrieval sees it.
  if (memory) {
    try {
      await memory.addEpisode('assistant', line)
    } catch (err) {
      console.warn('[affinity] milestone episode persist failed:', err)
    }
  }
  // Broadcast through the same channel proactive uses — renderer
  // chat handler renders it as a maid bubble.
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('proactive:remark', {
        text: line,
        ts: new Date().toISOString(),
        triggers: [`milestone:Lv.${newMilestone / 20 + 1}`],
      })
    }
  }
  console.log(`[affinity] milestone delivered (Lv.${newMilestone / 20 + 1}): ${line}`)
  // Fire the emotion classifier so her face matches.
  void classifyAndApply(line, '')
}
