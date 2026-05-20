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
import { runExtraction } from './chat-host.js'
import { resolvePersona } from '../shared/config.js'
import { getConfig } from './config.js'
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

/**
 * Generate a maid-styled reminder line via the chat backend, persist it as
 * an assistant episode (so the model remembers it spoke), and broadcast it
 * as a `proactive:remark` so the renderer displays it + speaks via TTS —
 * exactly the same channel the proactive observer uses.
 *
 * Falls back to a plain template if the LLM call fails; we never want a
 * fire-at to silently drop.
 */
async function speakReminder(task: Task): Promise<void> {
  const persona = resolvePersona(getConfig().persona)
  const prompt =
    `${persona.systemPrompt}\n\n` +
    `[系统] 主人之前让你在到时提醒："${task.text}"。\n` +
    `现在该提醒了。用 1-2 句话自然地提醒主人，亲切、口语化，` +
    `不要直接复述任务原文也不要加引号、emoji 或 markdown。`
  let line = ''
  try {
    // Creative temperature — reminder lines are short ("主人，喝水时
    // 间到了哦") and should vary, not parrot the same template.
    const raw = await runExtraction(prompt, { temperature: 0.7 })
    line = raw.trim()
  } catch (err) {
    console.warn('[tasks] reminder LLM call failed, using fallback:', err)
  }
  if (!line) line = `主人，到时间了——${task.text}`

  const memory = getMemoryService()
  if (memory) {
    try {
      await memory.addEpisode('assistant', line)
    } catch (err) {
      console.warn('[tasks] failed to persist reminder episode:', err)
    }
  }

  broadcast('proactive:remark', {
    text: line,
    ts: new Date().toISOString(),
    triggers: ['task-fire'],
  })
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
        // OS notification still useful when the window is minimized or in
        // the background — gives the user a glanceable alert.
        showOSNotification(task)
        // Fire-and-forget the maid line; renderer will display + speak via
        // proactive:remark. We don't await it because the notify callback
        // is sync from the timer's POV — let the LLM call run in the bg.
        void speakReminder(task)
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
