/**
 * Passive presence accrual — rewards the user for keeping OpenMeido open
 * and active alongside them. Different from the chat-judge path:
 *   - no LLM call, no judge, no reason synthesis
 *   - +1 affinity per 120 minutes of cumulative ACTIVE presence
 *   - daily cap +3 (so a full 8-hour workday with her on screen = +3)
 *   - hard score ceiling at 40 (Lv.3 floor) — beyond that, only real
 *     interaction (chat-judge path) advances the relationship
 *
 * "Active" means BOTH conditions hold during the tick window:
 *   1. window is visible (not hidden via hotkey, not minimized)
 *   2. system is not idle (user input within last IDLE_THRESHOLD seconds)
 *
 * Counters are in-memory and reset on app restart. That's intentional:
 *   - no persistence schema for "minutes accrued today" needed
 *   - encourages presence within a session, not "I left it running 24/7"
 *
 * Daily cap shares the per-day delta counter inside affinity-host so
 * presence + judge bumps together can't exceed PER_DAY_DELTA_CAP.
 */

import { BrowserWindow, powerMonitor } from 'electron'

import { getConfig } from './config.js'
import { applyPresenceBump } from './affinity-host.js'
import { PRESENCE_SCORE_CEILING } from '../shared/affinity.js'
import {
  PRESENCE_IDLE_THRESHOLD_SEC,
  isActivelyPresent as gate,
} from '../shared/presence-gate.js'

/** How often to wake up and check if the user is active. */
const TICK_INTERVAL_MS = 10 * 60 * 1000 // 10 minutes
/** Cumulative minutes of presence needed for +1. */
const MINUTES_PER_BUMP = 120
/** Daily soft cap on presence-driven bumps (one persona). */
const DAILY_PRESENCE_BUMP_CAP = 3

interface PresenceState {
  /** Calendar date this counter is for ("YYYY-MM-DD"); rolls over at local midnight. */
  date: string
  /** Minutes accrued since the last successful bump for this persona. */
  minutesSinceLastBump: number
  /** Bumps already given today via the presence path (vs judge). */
  bumpsToday: number
}

const stateByPersona = new Map<string, PresenceState>()
let tickTimer: NodeJS.Timeout | null = null
let getMainWindow: () => BrowserWindow | null = () => null

function todayLocal(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`
}

function getOrInit(personaId: string): PresenceState {
  const today = todayLocal()
  let s = stateByPersona.get(personaId)
  if (!s) {
    s = { date: today, minutesSinceLastBump: 0, bumpsToday: 0 }
    stateByPersona.set(personaId, s)
  } else if (s.date !== today) {
    s.date = today
    s.bumpsToday = 0
    // Don't reset minutesSinceLastBump — partial accrual carries across
    // midnight so a user who chats with her from 10 PM to 1 AM gets
    // proper credit for those 3 hours.
  }
  return s
}

/** Re-export the pure gate so callers in this directory have a single
 *  import. Tests reach into shared/presence-gate directly. */
export const isActivelyPresent = gate

async function tick(): Promise<void> {
  try {
    const cfg = getConfig()
    const personaId = cfg.persona.preset

    const win = getMainWindow()
    const windowVisible = !!(win && !win.isDestroyed() && win.isVisible())
    const windowMinimized = !!(win && !win.isDestroyed() && win.isMinimized())
    const idleSec = powerMonitor.getSystemIdleTime()
    if (!isActivelyPresent({ windowVisible, windowMinimized, systemIdleSec: idleSec })) {
      // User isn't actively present this tick — don't accrue.
      return
    }

    const s = getOrInit(personaId)
    if (s.bumpsToday >= DAILY_PRESENCE_BUMP_CAP) {
      // Hit daily cap — accumulate minutes but don't bump until midnight rolls over.
      return
    }
    s.minutesSinceLastBump += TICK_INTERVAL_MS / 60_000
    if (s.minutesSinceLastBump < MINUTES_PER_BUMP) return

    const reason = '她注意到你最近一直在身边'
    const newScore = await applyPresenceBump(personaId, reason)
    if (newScore === null) {
      // Bump didn't apply (ceiling / cap). Don't reset the accumulator —
      // if the user crosses below ceiling via decay later, the saved
      // accrual lets us re-fire faster. But cap it so the number doesn't
      // grow unboundedly across days.
      s.minutesSinceLastBump = Math.min(s.minutesSinceLastBump, MINUTES_PER_BUMP * 3)
      return
    }
    s.minutesSinceLastBump = 0
    s.bumpsToday += 1
    console.log(
      `[presence] +1 → ${newScore} for ${personaId} (today ${s.bumpsToday}/${DAILY_PRESENCE_BUMP_CAP})`,
    )
  } catch (err) {
    console.warn('[presence] tick failed:', err)
  }
}

export function initPresence(windowAccessor: () => BrowserWindow | null): void {
  getMainWindow = windowAccessor
  // First tick after 10 minutes (short enough to feel responsive on
  // open-and-stay-here scenarios; long enough that quick "check then
  // close" sessions don't bump).
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = setInterval(() => void tick(), TICK_INTERVAL_MS)
}

export function stopPresence(): void {
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
}

/** Test seam — reset all in-memory state. */
export function __resetPresence(): void {
  stateByPersona.clear()
}

// Re-export the constants so tests / callers have one import surface.
export { PRESENCE_SCORE_CEILING, PRESENCE_IDLE_THRESHOLD_SEC }
