/**
 * Pure decision logic for the Day-1 onboarding screen-peek.
 *
 * Two questions:
 *   1. At greeting time — should we even SCHEDULE a peek for ~45s later?
 *      (Skip if already fired, mode=mute, or screen mode off.)
 *   2. At fire time — is it safe to fire NOW?
 *      (Skip if user already started chatting, or another remark already
 *      went out, since the moment we wanted to seize is gone.)
 *
 * These live here (not in proactive-host) so they can be exercised by
 * the onboarding smoke test without booting Electron.
 */

import type { Config } from './config.js'

export type ScheduleSkipReason =
  | 'already-fired'
  | 'mute-mode'
  | 'screen-disabled'

export type FireSkipReason =
  | 'user-already-chatted'
  | 'assistant-already-spoke-again'

/**
 * Decide at greeting-host time whether to arm the onboarding timer.
 *
 * Returns null when we should schedule, or the reason we're skipping.
 * The reason makes log lines self-explanatory ("[onboarding] skipping:
 * mute-mode") and lets the smoke test assert each branch by name.
 */
export function shouldScheduleOnboardingPeek(cfg: Config): ScheduleSkipReason | null {
  if (cfg.onboarding.firstScreenPeekFired) return 'already-fired'
  if (cfg.proactive.mode === 'mute') return 'mute-mode'
  // includeScreen=false means the user actively disabled the very feature
  // this onboarding moment showcases. Triggering a text-only peek would
  // miss the point and feel weird — defer entirely (and don't keep retrying
  // either; the user's Settings choice IS the signal).
  if (!cfg.proactive.includeScreen) return 'screen-disabled'
  return null
}

/**
 * Decide at timeout fire time whether the moment is still right.
 *
 * Args are timestamps in ms since epoch. `greetingTs` is when the
 * greeting line broadcast finished. `lastUserAt` and `lastAssistantAt`
 * are the proactive-host's activity clocks.
 *
 * The peek is meant to surprise a user who's been silently exploring
 * since the greeting — staring at the maid, poking around the UI. If
 * they've already started chatting OR she's already spoken again
 * (another proactive remark beat us to it), the "first impression"
 * moment is gone.
 */
export function shouldFireOnboardingPeek(state: {
  greetingTs: number
  lastUserAt: number
  lastAssistantAt: number
}): FireSkipReason | null {
  if (state.lastUserAt > state.greetingTs) return 'user-already-chatted'
  if (state.lastAssistantAt > state.greetingTs) return 'assistant-already-spoke-again'
  return null
}

/**
 * Pick a fire delay in [MIN, MAX] ms with jitter. Exported so the smoke
 * test can assert the range without depending on Math.random.
 */
export const ONBOARDING_DELAY_MIN_MS = 30_000
export const ONBOARDING_DELAY_MAX_MS = 60_000

export function pickOnboardingDelayMs(rand: () => number = Math.random): number {
  const span = ONBOARDING_DELAY_MAX_MS - ONBOARDING_DELAY_MIN_MS
  // Math.round (not floor) so the endpoints are inclusive: rand=0 → MIN,
  // rand=1 → MAX. With floor + (span+1), rand=1 overshoots by one ms.
  // (Math.random itself is [0,1) so this only matters for tests that
  // inject rand=1 explicitly, but cleaner formula is cheap.)
  return ONBOARDING_DELAY_MIN_MS + Math.round(rand() * span)
}
