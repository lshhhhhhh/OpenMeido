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
  // Cadence rebalanced in v0.1.5: tier1 was 1800/2400/1500/60 = ~40 min
  // silence between remarks for a fresh-install user, which made the
  // Day-1 experience feel abandoned after the onboarding peek. New
  // numbers target "fresh user feels her presence every 15-20 min"
  // without flipping over to the "she chatters constantly" zone.
  //
  // Strictly monotonic — every param decreases as tier rises — so the
  // user still sees a clear "she's getting more present" arc as
  // affinity grows. tier5 left unchanged because it was already in
  // the right zone for intimate-tier presence; tightening it more
  // would brush against chatty mode's territory.
  //
  // Persona / character distinction comes from the prompt's tier
  // trait pack, NOT cadence — so "polite stranger" feel at tier1 is
  // preserved by the prompt even though she speaks more often.
  tier1: { idleThresholdSec: 600,  timerSec: 1200, cooldownSec: 600, minSilenceSec: 60 },
  tier2: { idleThresholdSec: 540,  timerSec: 960,  cooldownSec: 540, minSilenceSec: 45 },
  tier3: { idleThresholdSec: 480,  timerSec: 780,  cooldownSec: 480, minSilenceSec: 30 },
  tier4: { idleThresholdSec: 360,  timerSec: 540,  cooldownSec: 360, minSilenceSec: 30 },
  tier5: { idleThresholdSec: 300,  timerSec: 420,  cooldownSec: 300, minSilenceSec: 30 },
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
