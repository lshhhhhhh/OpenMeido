/**
 * Pure gating helper for passive-presence accrual. Lives in shared/
 * (no electron imports) so it can be unit-tested in plain Node without
 * standing up an Electron runtime.
 *
 * The full presence loop (timer, accumulator, persona-active check)
 * lives in src/main/presence-host.ts, which uses this gate.
 */

/** Seconds. System must have received user input within this window
 *  for presence to count as "active" — past it, the user has walked
 *  away from the machine. */
export const PRESENCE_IDLE_THRESHOLD_SEC = 300

export interface PresenceGateInput {
  /** Window is visible on screen (not hidden via hotkey). */
  windowVisible: boolean
  /** Window is minimized (taskbar only). Treated as not-present. */
  windowMinimized: boolean
  /** Seconds since last user input, as Electron's powerMonitor reports. */
  systemIdleSec: number
}

/** True when the user counts as "actively present" right now —
 *  window is on screen AND the system isn't idle. */
export function isActivelyPresent(input: PresenceGateInput): boolean {
  if (!input.windowVisible) return false
  if (input.windowMinimized) return false
  if (input.systemIdleSec > PRESENCE_IDLE_THRESHOLD_SEC) return false
  return true
}
