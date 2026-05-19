/**
 * Unified Task type — replaces the previous split between Reminder
 * (time-triggered one-shot, auto-archived on fire) and Todo (sticky
 * checklist, manually completed).
 *
 * A Task is fundamentally "a thing to remember." It optionally has a
 * fireAt; when set, a timer schedules an OS notification at that time.
 * Either way, the row STAYS in the user's list until they explicitly
 * mark it done. This means fired reminders no longer disappear (you
 * can see "what reminders did I get today") while still letting pure
 * TODOs work without time scheduling.
 *
 * Cross-platform core — no Node / Electron imports.
 */

export interface Task {
  /** Persisted row id. */
  id: number
  /** When the row was created (ISO 8601). */
  createdAt: string
  /** Free-text description of the task. */
  text: string
  /**
   * When the user (or AI) marked this task complete. null = still active.
   * Active state is the union "not yet done"; whether the notification
   * fired is a separate `notifiedAt` field.
   */
  doneAt: string | null
  /**
   * When the OS-level notification should fire. null = no notification
   * planned (pure TODO). When set, the scheduler arms a timer; when the
   * timer goes off, the task is NOT marked done — it just gets a
   * notification + `notifiedAt` stamped.
   */
  fireAt: string | null
  /**
   * When the scheduled notification actually fired. null = either no
   * fireAt was set, or fireAt is still in the future. Distinct from
   * doneAt: a notification can fire and the user can still leave the
   * task incomplete on their list.
   */
  notifiedAt: string | null
  /**
   * Optional informational due date. NOT scheduled — just displayed.
   * Use fireAt if you want a notification at the deadline; use dueAt
   * when there's a "by Friday" feel but no need for an OS popup.
   */
  dueAt: string | null
  /** Chat session that created the task, for future filtering. */
  sessionId: string | null
}

export interface NewTask {
  text: string
  fireAt?: string | null
  dueAt?: string | null
  sessionId?: string | null
}
