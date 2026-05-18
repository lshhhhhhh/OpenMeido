/**
 * SQLite-backed ReminderAdapter. Lives in main/ for the same reasons as
 * sqlite-memory-adapter — better-sqlite3 is a Node-native module.
 *
 * Stored at <userData>/reminders.sqlite (separate file from memory.sqlite
 * so the two subsystems can be cleared / migrated independently).
 */

import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import type { ReminderAdapter } from '../../core/reminders/adapter.js'
import type { NewReminder, Reminder } from '../../core/reminders/types.js'

interface ReminderRow {
  id: number
  created_at: string
  fire_at: string
  message: string
  session_id: string | null
  fired_at: string | null
}

function row2reminder(r: ReminderRow): Reminder {
  return {
    id: r.id,
    createdAt: r.created_at,
    fireAt: r.fire_at,
    message: r.message,
    sessionId: r.session_id,
    firedAt: r.fired_at,
  }
}

export function openSqliteReminders(dataDir: string): ReminderAdapter {
  mkdirSync(dataDir, { recursive: true })
  const db = new Database(join(dataDir, 'reminders.sqlite'))
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      fire_at TEXT NOT NULL,
      message TEXT NOT NULL,
      session_id TEXT,
      fired_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_reminders_pending
      ON reminders(fire_at) WHERE fired_at IS NULL;
  `)

  const insertStmt = db.prepare<[string, string, string, string | null]>(
    `INSERT INTO reminders (created_at, fire_at, message, session_id)
     VALUES (?, ?, ?, ?)`,
  )
  const markFiredStmt = db.prepare<[string, number]>(
    'UPDATE reminders SET fired_at = ? WHERE id = ?',
  )
  const removeStmt = db.prepare<[number]>('DELETE FROM reminders WHERE id = ?')
  const selectUpcomingStmt = db.prepare(
    `SELECT id, created_at, fire_at, message, session_id, fired_at
     FROM reminders
     WHERE fired_at IS NULL
     ORDER BY fire_at ASC`,
  )
  const selectAllStmt = db.prepare<[number]>(
    `SELECT id, created_at, fire_at, message, session_id, fired_at
     FROM reminders
     ORDER BY fire_at DESC
     LIMIT ?`,
  )

  let closed = false
  const ensureOpen = (): void => {
    if (closed) throw new Error('sqlite-reminder-adapter: closed')
  }

  return {
    async add(r: NewReminder) {
      ensureOpen()
      const createdAt = new Date().toISOString()
      const result = insertStmt.run(createdAt, r.fireAt, r.message, r.sessionId ?? null)
      return Number(result.lastInsertRowid)
    },

    async markFired(id: number, firedAt: string) {
      ensureOpen()
      markFiredStmt.run(firedAt, id)
    },

    async listUpcoming() {
      ensureOpen()
      const rows = selectUpcomingStmt.all() as ReminderRow[]
      return rows.map(row2reminder)
    },

    async listAll(limit: number) {
      ensureOpen()
      const rows = selectAllStmt.all(limit) as ReminderRow[]
      return rows.map(row2reminder)
    },

    async remove(id: number) {
      ensureOpen()
      removeStmt.run(id)
    },

    close() {
      if (closed) return
      closed = true
      db.close()
    },
  }
}
