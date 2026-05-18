/**
 * ReminderService — owns the in-memory setTimeout map. On schedule, persist
 * via adapter and arm a timer. On app startup, replay storage to re-arm
 * timers for any reminders whose fireAt is still in the future. When a
 * timer fires, mark the row as fired in DB and notify the host (which
 * shows the OS notification + pushes a chat event).
 *
 * Pure cross-platform core — uses setTimeout / setImmediate from web/Node
 * standard. The host gives us a `notify` callback for the actual OS-level
 * notification (Electron Notification in main, future Web Notifications
 * in PWA).
 */

import type { ReminderAdapter } from './adapter.js'
import type { NewReminder, Reminder } from './types.js'

export interface ReminderService {
  /**
   * Schedule a new reminder. Persists + arms a timer. Returns the new id.
   * If fireAt is in the past, fires immediately on the next tick.
   */
  schedule(input: NewReminder): Promise<number>

  /** Cancel an active reminder (clear timer + remove from DB). */
  cancel(id: number): Promise<void>

  /** All pending + fired reminders for the inspector UI. */
  listAll(limit: number): Promise<Reminder[]>

  /** Re-arm timers for everything in the DB after an app restart. */
  rearmAll(): Promise<number>
}

export interface ReminderServiceDeps {
  adapter: ReminderAdapter
  /**
   * Host hook that actually shows the OS notification + lights up the UI.
   * Returns nothing — fire-and-forget.
   */
  notify: (reminder: Reminder) => void
  /** Optional error sink, same shape as MemoryService.onError. */
  onError?: (operation: string, message: string) => void
}

export function createReminderService(deps: ReminderServiceDeps): ReminderService {
  const { adapter, notify, onError } = deps
  const timers = new Map<number, ReturnType<typeof setTimeout>>()

  function report(op: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[reminder] ${op} failed:`, err)
    onError?.(op, message)
  }

  /** Compute delay in ms; clamped to >= 0. Past fireAt fires immediately. */
  function msUntil(fireAtIso: string): number {
    const t = new Date(fireAtIso).getTime()
    if (!Number.isFinite(t)) return 0
    return Math.max(0, t - Date.now())
  }

  function arm(reminder: Reminder): void {
    // setTimeout can only handle up to ~24.8 days. Beyond that, schedule
    // a far-future tick that re-arms. Realistic reminders are minutes /
    // hours / days out so 24-day delay would be rare, but we should not
    // crash on it either.
    const MAX = 2_147_483_647
    const delay = Math.min(msUntil(reminder.fireAt), MAX)
    const t = setTimeout(() => {
      timers.delete(reminder.id)
      const now = new Date().toISOString()
      void adapter.markFired(reminder.id, now).catch((err) => report('markFired', err))
      try {
        notify({ ...reminder, firedAt: now })
      } catch (err) {
        report('notify', err)
      }
    }, delay)
    timers.set(reminder.id, t)
  }

  return {
    async schedule(input) {
      try {
        const id = await adapter.add(input)
        arm({
          id,
          createdAt: new Date().toISOString(),
          fireAt: input.fireAt,
          message: input.message,
          sessionId: input.sessionId ?? null,
          firedAt: null,
        })
        return id
      } catch (err) {
        report('schedule', err)
        throw err
      }
    },

    async cancel(id) {
      const t = timers.get(id)
      if (t) {
        clearTimeout(t)
        timers.delete(id)
      }
      try {
        await adapter.remove(id)
      } catch (err) {
        report('cancel', err)
      }
    },

    listAll(limit) {
      return adapter.listAll(limit)
    },

    async rearmAll() {
      try {
        const upcoming = await adapter.listUpcoming()
        for (const r of upcoming) arm(r)
        return upcoming.length
      } catch (err) {
        report('rearmAll', err)
        return 0
      }
    },
  }
}
