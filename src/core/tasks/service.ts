/**
 * TaskService — combines the old ReminderService (timer management) +
 * TodoService (sticky list) into one. Owns:
 *   - the in-memory setTimeout map for fireAt scheduling
 *   - the broadcast hook for sidebar live updates
 *   - the session-id injection on add()
 *
 * Notification semantics: when a fireAt timer goes off we DON'T mark
 * the task done. We just call `notify(task)` and stamp `notifiedAt`.
 * The user (or AI) decides when the task is actually complete.
 */

import type { TaskAdapter } from './adapter.js'
import type { NewTask, Task } from './types.js'

export interface TaskService {
  add(input: NewTask): Promise<number>
  listActive(): Promise<Task[]>
  listAll(recentDoneLimit?: number, doneSinceIso?: string | null): Promise<Task[]>
  markDone(id: number): Promise<boolean>
  markActive(id: number): Promise<boolean>
  remove(id: number): Promise<boolean>
  countActive(): Promise<number>
  clear(): Promise<number>
  /** Re-arm timers for everything with future fireAt after restart. */
  rearmAll(): Promise<number>
}

export interface TaskServiceDeps {
  adapter: TaskAdapter
  /** Host hook for OS notification when a fireAt timer goes off. */
  notify: (task: Task) => void
  /** Host hook called after any state mutation; sidebar listens. */
  onChange?: () => void
  /** Session-id provider; usually wired to memory-host. */
  getSessionId?: () => string | null
  /** Diagnostic sink. */
  onError?: (operation: string, message: string) => void
}

export function createTaskService(deps: TaskServiceDeps): TaskService {
  const { adapter, notify, onChange, getSessionId, onError } = deps
  const timers = new Map<number, ReturnType<typeof setTimeout>>()

  function report(op: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[task] ${op} failed:`, err)
    onError?.(op, message)
  }

  function notifyChange(): void {
    try {
      onChange?.()
    } catch (err) {
      report('onChange', err)
    }
  }

  function msUntil(iso: string): number {
    const t = new Date(iso).getTime()
    if (!Number.isFinite(t)) return 0
    return Math.max(0, t - Date.now())
  }

  function arm(task: Task): void {
    if (!task.fireAt) return
    // Clear any existing timer for this id (no double-arming).
    const existing = timers.get(task.id)
    if (existing) clearTimeout(existing)
    const MAX = 2_147_483_647 // setTimeout's ceiling, ~24.8 days.
    const delay = Math.min(msUntil(task.fireAt), MAX)
    const t = setTimeout(() => {
      timers.delete(task.id)
      const now = new Date().toISOString()
      void adapter.markNotified(task.id, now).catch((err) => report('markNotified', err))
      try {
        notify({ ...task, notifiedAt: now })
      } catch (err) {
        report('notify', err)
      }
      notifyChange()
    }, delay)
    timers.set(task.id, t)
  }

  return {
    async add(input) {
      const sessionId = input.sessionId ?? getSessionId?.() ?? null
      const id = await adapter.add({ ...input, sessionId })
      if (input.fireAt) {
        arm({
          id,
          createdAt: new Date().toISOString(),
          text: input.text,
          doneAt: null,
          fireAt: input.fireAt,
          notifiedAt: null,
          dueAt: input.dueAt ?? null,
          sessionId,
        })
      }
      notifyChange()
      return id
    },

    listActive() {
      return adapter.listActive()
    },

    listAll(recentDoneLimit, doneSinceIso) {
      return adapter.listAll(recentDoneLimit, doneSinceIso)
    },

    async markDone(id) {
      const ok = await adapter.markDone(id, new Date().toISOString())
      if (ok) {
        // Cancel any pending notification — if you've marked it done,
        // we don't need to remind you anymore.
        const t = timers.get(id)
        if (t) {
          clearTimeout(t)
          timers.delete(id)
        }
        notifyChange()
      }
      return ok
    },

    async markActive(id) {
      const ok = await adapter.markActive(id)
      if (ok) notifyChange()
      return ok
    },

    async remove(id) {
      const t = timers.get(id)
      if (t) {
        clearTimeout(t)
        timers.delete(id)
      }
      const ok = await adapter.remove(id)
      if (ok) notifyChange()
      return ok
    },

    countActive() {
      return adapter.countActive()
    },

    async clear() {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
      const n = await adapter.clear()
      if (n > 0) notifyChange()
      return n
    },

    async rearmAll() {
      try {
        const upcoming = await adapter.listUpcoming()
        for (const t of upcoming) arm(t)
        return upcoming.length
      } catch (err) {
        report('rearmAll', err)
        return 0
      }
    },
  }
}
