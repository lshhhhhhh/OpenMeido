/**
 * SQLite-backed TaskAdapter — the unified store for reminders + TODOs.
 *
 * Migrates from the two old separate files on first launch:
 *   - reminders.sqlite has rows with fire_at; we copy them in with
 *     fire_at preserved and done_at set to the old fired_at value
 *     (so historically-fired reminders show as "completed" rather
 *     than flooding the sidebar as undone items).
 *   - todos.sqlite (if present from the brief window where the split
 *     existed) copies in as pure TODOs with fire_at = null.
 *
 * After successful migration, the old files are RENAMED to *.bak so
 * users can roll back manually if anything goes wrong. We don't delete
 * them outright in case the migration found a subtle bug.
 */

import Database from 'better-sqlite3'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

import type { TaskAdapter } from '../../core/tasks/adapter.js'
import type { NewTask, Task } from '../../core/tasks/types.js'

interface TaskRow {
  id: number
  created_at: string
  text: string
  done_at: string | null
  fire_at: string | null
  notified_at: string | null
  due_at: string | null
  session_id: string | null
}

function row2task(r: TaskRow): Task {
  return {
    id: r.id,
    createdAt: r.created_at,
    text: r.text,
    doneAt: r.done_at,
    fireAt: r.fire_at,
    notifiedAt: r.notified_at,
    dueAt: r.due_at,
    sessionId: r.session_id,
  }
}

/**
 * Copy rows from the legacy reminders.sqlite and todos.sqlite (if they
 * exist and the new tasks table is empty). Idempotent — only runs when
 * the new table has zero rows, so re-launching after a successful
 * migration is a no-op.
 */
function migrateLegacy(db: Database.Database, dataDir: string): void {
  const existing = db.prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number }
  if (existing.c > 0) return // already migrated (or new install with data)

  const remindersPath = join(dataDir, 'reminders.sqlite')
  const todosPath = join(dataDir, 'todos.sqlite')
  let migrated = 0

  if (existsSync(remindersPath)) {
    try {
      const oldDb = new Database(remindersPath, { readonly: true })
      const rows = oldDb
        .prepare(
          `SELECT id, created_at, fire_at, message, session_id, fired_at FROM reminders`,
        )
        .all() as {
        id: number
        created_at: string
        fire_at: string
        message: string
        session_id: string | null
        fired_at: string | null
      }[]
      const insert = db.prepare(
        `INSERT INTO tasks (created_at, text, done_at, fire_at, notified_at, due_at, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      const txn = db.transaction((rs: typeof rows) => {
        for (const r of rs) {
          // Old fired reminders → treat as historically complete. Otherwise
          // every user would suddenly see a flood of "uncompleted" tasks
          // they thought were handled.
          const doneAt = r.fired_at
          insert.run(
            r.created_at,
            r.message,
            doneAt,
            r.fire_at,
            r.fired_at, // notified_at mirrors old fired_at
            null, // due_at didn't exist in reminders schema
            r.session_id,
          )
        }
      })
      txn(rows)
      oldDb.close()
      migrated += rows.length
      // Rename rather than delete — preserves a manual recovery path.
      renameSync(remindersPath, remindersPath + '.bak')
      console.log(`[tasks] migrated ${rows.length} rows from reminders.sqlite`)
    } catch (err) {
      console.warn('[tasks] reminders migration failed:', err)
    }
  }

  if (existsSync(todosPath)) {
    try {
      const oldDb = new Database(todosPath, { readonly: true })
      const rows = oldDb
        .prepare(
          `SELECT id, created_at, text, done_at, due_at, session_id FROM todos`,
        )
        .all() as {
        id: number
        created_at: string
        text: string
        done_at: string | null
        due_at: string | null
        session_id: string | null
      }[]
      const insert = db.prepare(
        `INSERT INTO tasks (created_at, text, done_at, fire_at, notified_at, due_at, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      const txn = db.transaction((rs: typeof rows) => {
        for (const r of rs) {
          insert.run(r.created_at, r.text, r.done_at, null, null, r.due_at, r.session_id)
        }
      })
      txn(rows)
      oldDb.close()
      migrated += rows.length
      renameSync(todosPath, todosPath + '.bak')
      console.log(`[tasks] migrated ${rows.length} rows from todos.sqlite`)
    } catch (err) {
      console.warn('[tasks] todos migration failed:', err)
    }
  }

  if (migrated > 0) {
    console.log(`[tasks] migration complete: ${migrated} rows imported`)
  }
}

export function openSqliteTasks(dataDir: string): TaskAdapter {
  mkdirSync(dataDir, { recursive: true })
  const db = new Database(join(dataDir, 'tasks.sqlite'))
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      text TEXT NOT NULL,
      done_at TEXT,
      fire_at TEXT,
      notified_at TEXT,
      due_at TEXT,
      session_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_active
      ON tasks(created_at DESC) WHERE done_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_tasks_upcoming
      ON tasks(fire_at) WHERE fire_at IS NOT NULL AND notified_at IS NULL;
  `)

  migrateLegacy(db, dataDir)

  const insertStmt = db.prepare<
    [string, string, string | null, string | null, string | null]
  >(
    `INSERT INTO tasks (created_at, text, fire_at, due_at, session_id)
     VALUES (?, ?, ?, ?, ?)`,
  )
  const selectActiveStmt = db.prepare(
    `SELECT id, created_at, text, done_at, fire_at, notified_at, due_at, session_id
     FROM tasks
     WHERE done_at IS NULL
     ORDER BY created_at DESC, id DESC`,
  )
  const selectAllStmt = db.prepare<[number]>(
    `SELECT id, created_at, text, done_at, fire_at, notified_at, due_at, session_id FROM (
       SELECT *, 0 AS sort_key FROM tasks WHERE done_at IS NULL
       UNION ALL
       SELECT *, 1 AS sort_key FROM (
         SELECT * FROM tasks WHERE done_at IS NOT NULL
         ORDER BY done_at DESC, id DESC LIMIT ?
       )
     )
     ORDER BY sort_key ASC, created_at DESC, id DESC`,
  )
  const selectUpcomingStmt = db.prepare(
    `SELECT id, created_at, text, done_at, fire_at, notified_at, due_at, session_id
     FROM tasks
     WHERE fire_at IS NOT NULL AND notified_at IS NULL AND done_at IS NULL
     ORDER BY fire_at ASC`,
  )
  const markNotifiedStmt = db.prepare<[string, number]>(
    `UPDATE tasks SET notified_at = ? WHERE id = ?`,
  )
  const markDoneStmt = db.prepare<[string, number]>(
    `UPDATE tasks SET done_at = ? WHERE id = ? AND done_at IS NULL`,
  )
  const markActiveStmt = db.prepare<[number]>(
    `UPDATE tasks SET done_at = NULL WHERE id = ? AND done_at IS NOT NULL`,
  )
  const removeStmt = db.prepare<[number]>(`DELETE FROM tasks WHERE id = ?`)
  const countActiveStmt = db.prepare(
    `SELECT COUNT(*) AS c FROM tasks WHERE done_at IS NULL`,
  )

  let closed = false
  const ensureOpen = (): void => {
    if (closed) throw new Error('sqlite-task-adapter: closed')
  }

  return {
    async add(input: NewTask) {
      ensureOpen()
      const createdAt = new Date().toISOString()
      const result = insertStmt.run(
        createdAt,
        input.text,
        input.fireAt ?? null,
        input.dueAt ?? null,
        input.sessionId ?? null,
      )
      return Number(result.lastInsertRowid)
    },

    async listActive() {
      ensureOpen()
      return (selectActiveStmt.all() as TaskRow[]).map(row2task)
    },

    async listAll(recentDoneLimit = 5) {
      ensureOpen()
      return (selectAllStmt.all(recentDoneLimit) as TaskRow[]).map(row2task)
    },

    async listUpcoming() {
      ensureOpen()
      return (selectUpcomingStmt.all() as TaskRow[]).map(row2task)
    },

    async markNotified(id: number, notifiedAt: string) {
      ensureOpen()
      markNotifiedStmt.run(notifiedAt, id)
    },

    async markDone(id: number, doneAt: string) {
      ensureOpen()
      const r = markDoneStmt.run(doneAt, id)
      return r.changes > 0
    },

    async markActive(id: number) {
      ensureOpen()
      const r = markActiveStmt.run(id)
      return r.changes > 0
    },

    async remove(id: number) {
      ensureOpen()
      const r = removeStmt.run(id)
      return r.changes > 0
    },

    async countActive() {
      ensureOpen()
      return (countActiveStmt.get() as { c: number }).c
    },

    async clear() {
      ensureOpen()
      const r = db.prepare('DELETE FROM tasks').run()
      return Number(r.changes)
    },

    close() {
      if (closed) return
      closed = true
      db.close()
    },
  }
}
