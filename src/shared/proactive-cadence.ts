/**
 * Proactive-mode cadence resolver.
 *
 * The cross-turn "spontaneous remark" engine used to expose five timing
 * sliders (poll / timer / idle / silence / cooldown). 99% of users never
 * touched them; they're now derived here from a single user choice:
 *
 *   mute    — engine off; never speaks unprompted.
 *   auto    — engine on; cadence escalates with affinity tier (cold ⇒
 *             nearly silent, warm ⇒ steady presence).
 *   chatty  — engine on, dense cadence regardless of affinity (override
 *             for users who want her around even before the relationship
 *             has earned it).
 *
 * The cadence numbers are deliberately conservative at low tiers: a
 * stranger who comments every 5 minutes would feel intrusive; the same
 * cadence from a Lv.5 companion feels warm. This is the whole point of
 * tier-driven cadence — same engine, different felt presence.
 */

import { tierFor, type Tier } from './affinity.js'

export type ProactiveMode = 'auto' | 'chatty' | 'mute'

export interface ProactiveCadence {
  /** Fires once when system idle ≥ this many seconds (latches until any
   *  user activity rearms). */
  idleThresholdSec: number
  /** Fires when this many seconds have passed since the last assistant
   *  remark (proactive OR user-driven). */
  timerSec: number
  /** Hard cooldown between any two proactive remarks. */
  cooldownSec: number
  /** Suppress firing if the user spoke within this many seconds. */
  minSilenceSec: number
}

/**
 * Per-tier auto-mode cadence. Lower tier = quieter.
 *
 * The Lv.3 row preserves the previous global defaults (10 min idle, 15
 * min timer, 10 min cooldown, 30 s silence) so users sitting at the
 * mid-tier today see no behavior change after the migration.
 */
const AUTO_CADENCE: Record<Tier, ProactiveCadence> = {
  tier1: { idleThresholdSec: 1800, timerSec: 2400, cooldownSec: 1500, minSilenceSec: 60 },
  tier2: { idleThresholdSec: 1500, timerSec: 1800, cooldownSec: 1200, minSilenceSec: 60 },
  tier3: { idleThresholdSec: 600,  timerSec: 900,  cooldownSec: 600,  minSilenceSec: 30 },
  tier4: { idleThresholdSec: 420,  timerSec: 600,  cooldownSec: 420,  minSilenceSec: 30 },
  tier5: { idleThresholdSec: 300,  timerSec: 420,  cooldownSec: 300,  minSilenceSec: 30 },
}

/**
 * Chatty-mode cadence — dense regardless of affinity score. Tuned a notch
 * tighter than auto-Lv.5 so the user can dial up explicitly (e.g. demo
 * mode, "I want her around right now").
 */
const CHATTY_CADENCE: ProactiveCadence = {
  idleThresholdSec: 180,
  timerSec: 300,
  cooldownSec: 180,
  minSilenceSec: 20,
}

/** Fixed poll interval. No longer user-configurable — 5 s is enough
 *  granularity to catch idle threshold crossings without burning CPU. */
export const PROACTIVE_POLL_INTERVAL_SEC = 5

/**
 * Resolve the cadence for the current user mode + cached affinity tier.
 * Returns `null` ⇔ the engine should not fire at all (mute). The host
 * uses null as the cue to bail out of evaluation without doing any
 * trigger collection or LLM calls.
 */
export function cadenceFor(
  mode: ProactiveMode,
  tier: Tier,
): ProactiveCadence | null {
  if (mode === 'mute') return null
  if (mode === 'chatty') return CHATTY_CADENCE
  return AUTO_CADENCE[tier]
}

/** Convenience: skip the tier lookup when you only have the raw score. */
export function cadenceForScore(
  mode: ProactiveMode,
  score: number,
): ProactiveCadence | null {
  return cadenceFor(mode, tierFor(score).tier)
}
