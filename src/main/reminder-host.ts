/**
 * Reminder host — assembles the sqlite adapter + core service with an
 * Electron-specific notification callback. On app whenReady, re-arms
 * timers for everything in the DB so reminders survive restarts.
 */

import { app, BrowserWindow, Notification } from 'electron'

import { createReminderService, type ReminderService } from '../core/reminders/service.js'
import { openSqliteReminders } from './storage/sqlite-reminder-adapter.js'
import type { Reminder } from '../core/reminders/types.js'

let service: ReminderService | null = null
let initError: string | null = null

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function showNotification(reminder: Reminder): void {
  // Electron Notification is the right cross-platform path — uses native
  // toast / banner / dock badge depending on OS.
  if (!Notification.isSupported()) return
  const n = new Notification({
    title: 'OpenMeido 提醒',
    body: reminder.message,
    // Quiet — we don't want startle-louder-than-actual-message UX.
    silent: false,
  })
  n.show()
}

export async function initReminders(): Promise<void> {
  if (service || initError) return
  try {
    const adapter = openSqliteReminders(app.getPath('userData'))
    service = createReminderService({
      adapter,
      notify: (reminder) => {
        showNotification(reminder)
        broadcast('reminder:fired', reminder)
      },
      onError: (operation, message) => {
        broadcast('reminder:error', { operation, message, ts: Date.now() })
      },
    })
    const armed = await service.rearmAll()
    console.log(`[reminders] ready, re-armed ${armed} pending reminders`)
  } catch (err) {
    initError = err instanceof Error ? err.message : String(err)
    console.error('[reminders] init failed:', err)
  }
}

export function getReminderService(): ReminderService | null {
  return service
}
