/**
 * Persistence interface for reminders. The desktop adapter is sqlite-backed
 * (src/main/storage/sqlite-reminder-adapter.ts); future PWA / Capacitor
 * hosts plug in their own storage.
 */

import type { NewReminder, Reminder } from './types.js'

export interface ReminderAdapter {
  /** Persist a new reminder. Returns the assigned id. */
  add(reminder: NewReminder): Promise<number>

  /** Mark a reminder as fired at the given ISO timestamp. */
  markFired(id: number, firedAt: string): Promise<void>

  /** All reminders whose fire_at is in the future and that haven't fired yet. */
  listUpcoming(): Promise<Reminder[]>

  /** All reminders (pending + fired), newest fireAt first. For the inspector UI. */
  listAll(limit: number): Promise<Reminder[]>

  /** Delete a single reminder regardless of state. */
  remove(id: number): Promise<void>

  close(): void
}
