/**
 * Task host — Electron wiring for the unified TaskService. Replaces the
 * earlier split between reminder-host and todos-host.
 *
 * Owns: sqlite adapter, the OS notification callback for fire-at timers,
 * the broadcast hook the sidebar listens to, and the session-id provider
 * that links tasks to the chat session they were created in.
 */

import { app, BrowserWindow, Notification } from 'electron'

import { createTaskService, type TaskService } from '../core/tasks/service.js'
import { openSqliteTasks } from './storage/sqlite-task-adapter.js'
import { getMemoryService } from './memory-host.js'
import type { Task } from '../core/tasks/types.js'

let service: TaskService | null = null
let initError: string | null = null

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function showOSNotification(task: Task): void {
  if (!Notification.isSupported()) return
  const n = new Notification({
    title: 'OpenMeido 提醒',
    body: task.text,
    silent: false,
  })
  n.show()
}

/** Public broadcast hook for "the task set changed". Sidebar listens. */
export function broadcastTasksChanged(): void {
  broadcast('tasks:changed', { ts: Date.now() })
}

export async function initTasks(): Promise<void> {
  if (service || initError) return
  try {
    const adapter = openSqliteTasks(app.getPath('userData'))
    service = createTaskService({
      adapter,
      notify: (task) => {
        showOSNotification(task)
        // Also push to renderer so App.tsx can drop it into the chat
        // as an assistant message (existing pattern from reminders).
        broadcast('task:fired', task)
        broadcastTasksChanged()
      },
      onChange: broadcastTasksChanged,
      getSessionId: () => {
        const mem = getMemoryService()
        return mem ? mem.currentSession() : null
      },
      onError: (operation, message) => {
        broadcast('tasks:error', { operation, message, ts: Date.now() })
      },
    })
    const armed = await service.rearmAll()
    const active = await service.countActive()
    console.log(
      `[tasks] ready · ${active} active · ${armed} timer(s) re-armed`,
    )
  } catch (err) {
    initError = err instanceof Error ? err.message : String(err)
    console.error('[tasks] init failed:', err)
  }
}

export function getTaskService(): TaskService | null {
  return service
}

export function getTaskInitError(): string | null {
  return initError
}
