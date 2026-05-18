/**
 * Reminder types. Platform-agnostic core.
 */

export interface Reminder {
  /** Persisted row id (auto-increment). */
  id: number
  /** ISO 8601 of when the reminder row was created. */
  createdAt: string
  /** ISO 8601 of when the reminder should fire. */
  fireAt: string
  /** Short text the user will see when it fires. */
  message: string
  /** Optional — the session id active when the reminder was scheduled. */
  sessionId: string | null
  /** ISO 8601 of when the reminder actually fired; null = still pending. */
  firedAt: string | null
}

export interface NewReminder {
  fireAt: string
  message: string
  sessionId?: string | null
}
