/**
 * Persistence interface for tasks. Sqlite-backed in main; future PWA
 * hosts can plug in IndexedDB.
 */

import type { NewTask, Task } from './types.js'

export interface TaskAdapter {
  /** Persist a new task. Returns the assigned id. */
  add(input: NewTask): Promise<number>

  /** Active tasks (doneAt IS NULL), newest first. */
  listActive(): Promise<Task[]>

  /**
   * All tasks including recently-completed. `recentDoneLimit` caps how
   * many done rows tag along (sidebar shows the last few for the
   * satisfaction-of-checking-off effect). `doneSinceIso`, if provided,
   * further restricts done rows to those completed at-or-after that
   * timestamp — used to scope "recently completed" to the current app
   * session so X-deleting a row doesn't pull older history into view.
   */
  listAll(recentDoneLimit?: number, doneSinceIso?: string | null): Promise<Task[]>

  /**
   * All tasks with a future fireAt that haven't fired yet — used by the
   * service to re-arm notification timers after an app restart.
   */
  listUpcoming(): Promise<Task[]>

  /** Mark notification as fired at the given time. Doesn't touch doneAt. */
  markNotified(id: number, notifiedAt: string): Promise<void>

  /** Mark complete; idempotent. Returns true if found and changed. */
  markDone(id: number, doneAt: string): Promise<boolean>

  /** Re-open a completed task. Returns true if found and changed. */
  markActive(id: number): Promise<boolean>

  /** Delete entirely, regardless of state. Returns true if removed. */
  remove(id: number): Promise<boolean>

  /** Active count — for sidebar badge. */
  countActive(): Promise<number>

  /** Wipe everything. Returns rows removed. */
  clear(): Promise<number>

  close(): void
}
