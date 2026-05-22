/**
 * Passive presence accrual — rewards the user for keeping OpenMeido open
 * and active alongside them. Smooth model (v0.0.28): every minute of
 * active presence adds a small fraction of a point, rather than
 * accumulating silently for an hour and then jumping by +1. Equivalent
 * total rate (1 pt/hr) but no jarring discrete bumps and no "I just
 * missed the threshold by 5 min" feeling on restart.
 *
 * Behavior:
 *   - tick fires every 1 minute
 *   - each successful tick adds 1/60 point to affinity (curve-adjusted)
 *   - daily cap +3 (same as before — full 8-hour day still tops out at +3)
 *   - hard score ceiling at 40 (Lv.3 floor) — beyond that, only real
 *     interaction (chat-judge path) advances the relationship
 *
 * "Active" means BOTH conditions hold during the tick:
 *   1. window is visible (not hidden via hotkey, not minimized)
 *   2. system is not idle (user input within last IDLE_THRESHOLD seconds)
 *
 * Counters persist to per-persona affinity row (sqlite) so a restart
 * mid-day doesn't reset today's accrual. Cross-midnight rollover resets
 * presenceAddedToday so the daily cap refreshes.
 */

import { BrowserWindow, powerMonitor } from 'electron'

import { getConfig } from './config.js'
import { applyPresenceBump } from './affinity-host.js'
import { getMemoryAdapter } from './memory-host.js'
import { PRESENCE_SCORE_CEILING } from '../shared/affinity.js'
import {
  PRESENCE_IDLE_THRESHOLD_SEC,
  isActivelyPresent as gate,
} from '../shared/presence-gate.js'

/** How often to wake up and check if the user is active. */
const TICK_INTERVAL_MS = 60 * 1000 // 1 minute
/** Affinity added per successful tick. 1/60 = 1 point per hour of active
 *  presence, matching the legacy "+1 per 60 minutes" rate but smoothed
 *  across minute-by-minute ticks. */
const POINTS_PER_TICK = 1 / 60
/** Daily soft cap on presence-driven accrual (one persona, raw points
 *  before curve). 3.0 matches the legacy "3 bumps per day" semantics. */
const DAILY_PRESENCE_CAP = 3.0

interface PresenceState {
  /** Calendar date this counter is for ("YYYY-MM-DD"); rolls over at local midnight. */
  date: string
  /** Raw points already added today through presence (before curve, before
   *  daily cap clipping). Used to enforce DAILY_PRESENCE_CAP. */
  presenceAddedToday: number
}

const stateByPersona = new Map<string, PresenceState>()
/** Personas whose state we've attempted to hydrate from sqlite this
 *  process lifetime. Without this, every tick would re-read the DB
 *  even after we have authoritative in-memory state. */
const hydrated = new Set<string>()
let tickTimer: NodeJS.Timeout | null = null
let getMainWindow: () => BrowserWindow | null = () => null

/** Write the in-memory state for this persona back to sqlite. Soft-fails:
 *  a write error must NOT crash the tick — we'd rather drift than crash. */
async function persist(personaId: string, s: PresenceState): Promise<void> {
  const adapter = getMemoryAdapter()
  if (!adapter) return
  try {
    // Reuse the existing schema fields. `minutesAccrued` now carries the
    // float "points added today" (column type is REAL so float fits);
    // `bumpsToday` is unused but kept at 0 for the adapter contract.
    await adapter.setPresenceState(personaId, {
      date: s.date,
      minutesAccrued: s.presenceAddedToday,
      bumpsToday: 0,
    })
  } catch (err) {
    console.warn('[presence] persist failed:', err)
  }
}

/** Pull persisted state into memory once per persona per process. */
async function hydrate(personaId: string): Promise<void> {
  if (hydrated.has(personaId)) return
  hydrated.add(personaId)
  const adapter = getMemoryAdapter()
  if (!adapter) return
  try {
    const row = await adapter.getPresenceState(personaId)
    const today = todayLocal()
    const isToday = row.date === today
    // Migration guard: pre-v0.0.28 stored minutes (0-60+) in the same
    // column where we now store fractional "points added today" (cap
    // 3.0). Old rows commonly have values like 30 or 60 — far above
    // the new cap — which would silently jam the cap from launch one.
    // Anything past the cap is legacy garbage; reset.
    const raw = isToday ? row.minutesAccrued : 0
    const cleaned = raw > DAILY_PRESENCE_CAP ? 0 : raw
    if (cleaned !== raw) {
      console.log(
        `[presence] hydrate: stored value ${raw.toFixed(2)} exceeds cap ${DAILY_PRESENCE_CAP} — treating as legacy data, resetting to 0`,
      )
    }
    stateByPersona.set(personaId, {
      date: today,
      presenceAddedToday: cleaned,
    })
  } catch (err) {
    console.warn('[presence] hydrate failed:', err)
  }
}

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
    s = { date: today, presenceAddedToday: 0 }
    stateByPersona.set(personaId, s)
  } else if (s.date !== today) {
    s.date = today
    s.presenceAddedToday = 0
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
    await hydrate(personaId)

    const win = getMainWindow()
    const windowVisible = !!(win && !win.isDestroyed() && win.isVisible())
    const windowMinimized = !!(win && !win.isDestroyed() && win.isMinimized())
    const idleSec = powerMonitor.getSystemIdleTime()
    const present = isActivelyPresent({ windowVisible, windowMinimized, systemIdleSec: idleSec })
    const sBefore = stateByPersona.get(personaId)
    console.log(
      `[presence] tick visible=${windowVisible} min=${windowMinimized} ` +
        `idleSec=${idleSec} present=${present} ` +
        `addedToday=${(sBefore?.presenceAddedToday ?? 0).toFixed(3)}/${DAILY_PRESENCE_CAP}`,
    )
    if (!present) return

    const s = getOrInit(personaId)
    if (s.presenceAddedToday >= DAILY_PRESENCE_CAP) return

    // Clip per-tick to whatever's left in today's budget so we don't
    // overshoot the cap on the final tick of a long day.
    const remaining = DAILY_PRESENCE_CAP - s.presenceAddedToday
    const amount = Math.min(POINTS_PER_TICK, remaining)

    const reason = '她注意到你最近一直在身边'
    const result = await applyPresenceBump(personaId, amount, reason)
    if (result === null) {
      // Ceiling reached (score >= PRESENCE_SCORE_CEILING) or memory not
      // ready. Don't credit local budget — try again next tick.
      return
    }
    s.presenceAddedToday += amount
    await persist(personaId, s)
    // Per-tick log so the user can SEE accrual happening every minute.
    // Score shown to 3 decimals because each tick contributes <0.02.
    // Adds a ★ marker when the integer-displayed score moves so big
    // milestones still stand out in a long log.
    const crossed = Math.round(result.before) !== Math.round(result.after)
    console.log(
      `[presence] ${personaId} ${result.before.toFixed(3)} → ${result.after.toFixed(3)}` +
        ` (+${(result.after - result.before).toFixed(3)})` +
        ` today=${s.presenceAddedToday.toFixed(2)}/${DAILY_PRESENCE_CAP}` +
        (crossed ? ' ★' : ''),
    )
  } catch (err) {
    console.warn('[presence] tick failed:', err)
  }
}

export function initPresence(windowAccessor: () => BrowserWindow | null): void {
  getMainWindow = windowAccessor
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = setInterval(() => void tick(), TICK_INTERVAL_MS)
  setImmediate(() => void tick())
}

/** Manual trigger for ad-hoc diagnostics. Wired via `presence:tickNow` IPC. */
export async function tickNow(): Promise<void> {
  await tick()
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
  hydrated.clear()
}

// Re-export the constants so tests / callers have one import surface.
export { PRESENCE_SCORE_CEILING, PRESENCE_IDLE_THRESHOLD_SEC }
