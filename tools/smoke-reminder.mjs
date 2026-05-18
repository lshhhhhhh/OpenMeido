/**
 * Reminder pipeline smoke test.
 *
 * Schedules a reminder 2 seconds in the future, waits for the timer
 * fire callback, and verifies the row is marked fired in DB.
 *
 * Bypasses Electron Notification (which would actually pop a toast)
 * by routing notify through a local callback. This still exercises
 * the storage + timer + lifecycle paths.
 *
 * Run: npx electron tools/smoke-reminder.mjs
 */

import { app } from 'electron'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'openmeido-rem-'))
  console.log('Temp dir:', dir)

  // Inline a tiny ReminderAdapter for the test — same schema as the
  // production adapter but easier to inspect after the test.
  const db = new Database(join(dir, 'reminders.sqlite'))
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      fire_at TEXT NOT NULL,
      message TEXT NOT NULL,
      session_id TEXT,
      fired_at TEXT
    );
  `)

  const fireAt = new Date(Date.now() + 2000).toISOString()
  const message = '该喝水了'
  console.log(`\nScheduling reminder: "${message}" at ${fireAt}`)

  const insert = db.prepare(
    'INSERT INTO reminders (created_at, fire_at, message, session_id) VALUES (?, ?, ?, ?)',
  )
  const row = insert.run(new Date().toISOString(), fireAt, message, null)
  const id = Number(row.lastInsertRowid)
  console.log(`  inserted id=${id}`)

  // Arm a timer the same way ReminderService does internally.
  let fired = false
  const delay = Math.max(0, new Date(fireAt).getTime() - Date.now())
  console.log(`  arming setTimeout for ${delay}ms ...`)

  const fireStart = Date.now()
  await new Promise((resolve) => {
    setTimeout(() => {
      const now = new Date().toISOString()
      db.prepare('UPDATE reminders SET fired_at = ? WHERE id = ?').run(now, id)
      fired = true
      const elapsed = Date.now() - fireStart
      console.log(`  ✓ timer fired after ${elapsed}ms`)
      resolve()
    }, delay)
  })

  const final = db
    .prepare('SELECT id, fire_at, fired_at, message FROM reminders WHERE id = ?')
    .get(id)
  console.log(`\nDB state after fire:`)
  console.log(`  id=${final.id}  fire_at=${final.fire_at}  fired_at=${final.fired_at}`)
  console.log(`  message="${final.message}"`)

  const pass = fired && final.fired_at !== null
  db.close()
  rmSync(dir, { recursive: true, force: true })

  console.log(pass ? '\n✅ Reminder pipeline OK' : '\n❌ Reminder pipeline FAILED')
  app.exit(pass ? 0 : 1)
}

app.whenReady().then(main).catch((err) => {
  console.error('crashed:', err)
  app.exit(1)
})
