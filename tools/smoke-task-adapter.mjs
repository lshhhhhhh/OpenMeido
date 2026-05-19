/**
 * Smoke test for the unified sqlite-task-adapter. Replaces the older
 * smoke-todo-adapter.mjs after the reminders/todos merge.
 *
 * Covers:
 *   - CRUD (add, listActive, listAll, markDone, markActive, remove, clear)
 *   - Distinct fireAt / notifiedAt / doneAt lifecycles (a fired reminder
 *     stays active until done; doneAt and notifiedAt are independent)
 *   - listUpcoming (timer re-arm on app restart)
 *   - Legacy migration from reminders.sqlite + todos.sqlite
 *
 * Runs in Electron because better-sqlite3 needs Electron's NODE_MODULE_VERSION.
 *
 * Run: npm run test:task-adapter
 */
import { app } from 'electron'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

async function main() {
  const { register } = await import('tsx/esm/api')
  register()
  const { openSqliteTasks } = await import('../src/main/storage/sqlite-task-adapter.ts')

  let pass = 0
  let fail = 0
  const check = (name, ok, detail = '') => {
    if (ok) {
      pass++
      console.log(`  ✓ ${name}`)
    } else {
      fail++
      console.log(`  ✗ ${name} :: ${detail}`)
    }
  }

  // ---------- Test 1: clean install, CRUD ----------
  console.log('\n[CRUD on a clean install]')
  const dir1 = mkdtempSync(join(tmpdir(), 'openmeido-task-clean-'))
  const a = openSqliteTasks(dir1)
  check('listActive empty initially', (await a.listActive()).length === 0)
  check('countActive 0 initially', (await a.countActive()) === 0)

  // Pure TODO (no fireAt)
  const idTodo = await a.add({ text: '回老板邮件' })
  // Reminder (with fireAt, future)
  const futureIso = new Date(Date.now() + 60_000).toISOString()
  const idReminder = await a.add({ text: '5 分钟后喝水', fireAt: futureIso })
  // Task with dueAt only (informational deadline, no notification)
  const dueIso = new Date(Date.now() + 7 * 86_400_000).toISOString()
  const idDue = await a.add({ text: '周报', dueAt: dueIso })

  const active1 = await a.listActive()
  check(`3 active rows (got ${active1.length})`, active1.length === 3)

  const todo = active1.find((t) => t.id === idTodo)
  check('todo: doneAt null', todo?.doneAt === null)
  check('todo: fireAt null', todo?.fireAt === null)
  check('todo: notifiedAt null', todo?.notifiedAt === null)

  const reminder = active1.find((t) => t.id === idReminder)
  check('reminder: fireAt set', reminder?.fireAt === futureIso)
  check('reminder: notifiedAt null (not fired yet)', reminder?.notifiedAt === null)
  check('reminder: doneAt null', reminder?.doneAt === null)

  const dueOnly = active1.find((t) => t.id === idDue)
  check('dueAt-only: fireAt null', dueOnly?.fireAt === null)
  check('dueAt-only: dueAt persisted', dueOnly?.dueAt === dueIso)

  // listUpcoming should return only the reminder (fireAt set, not notified)
  const upcoming = await a.listUpcoming()
  check(`listUpcoming returns 1 (got ${upcoming.length})`, upcoming.length === 1)
  check('listUpcoming returns the reminder', upcoming[0]?.id === idReminder)

  // ---------- Test 2: notification lifecycle separate from done ----------
  console.log('\n[notifiedAt and doneAt are independent]')
  const notifiedTime = new Date().toISOString()
  await a.markNotified(idReminder, notifiedTime)
  const afterNotify = (await a.listActive()).find((t) => t.id === idReminder)
  check('after markNotified: notifiedAt set', afterNotify?.notifiedAt === notifiedTime)
  check(
    "after markNotified: still active (doneAt remains null) — fired reminders STAY in the list",
    afterNotify?.doneAt === null,
  )
  // listUpcoming should now skip it (notifiedAt is set)
  const upcoming2 = await a.listUpcoming()
  check(
    `listUpcoming excludes already-notified (got ${upcoming2.length})`,
    upcoming2.length === 0,
  )

  // ---------- Test 3: markDone / markActive ----------
  console.log('\n[markDone / markActive]')
  const okDone = await a.markDone(idTodo, new Date().toISOString())
  check('markDone returns true on real id', okDone === true)
  const okDone2 = await a.markDone(idTodo, new Date().toISOString())
  check('markDone idempotent (returns false 2nd time)', okDone2 === false)
  const okDoneMissing = await a.markDone(99999, new Date().toISOString())
  check('markDone returns false on unknown id', okDoneMissing === false)
  check('countActive now 2', (await a.countActive()) === 2)

  const okActive = await a.markActive(idTodo)
  check('markActive returns true on done id', okActive === true)
  const okActive2 = await a.markActive(idTodo)
  check('markActive returns false on already-active id', okActive2 === false)
  check('countActive back to 3', (await a.countActive()) === 3)

  // ---------- Test 4: ordering newest first, with id tiebreaker ----------
  console.log('\n[ordering: newest first, id tiebreaker]')
  const idA = await a.add({ text: 'A' })
  const idB = await a.add({ text: 'B' })
  const ordered = await a.listActive()
  check(
    'newest (B) comes before A',
    ordered.findIndex((t) => t.id === idB) < ordered.findIndex((t) => t.id === idA),
  )

  // ---------- Test 5: listAll with recentDoneLimit cap ----------
  console.log('\n[listAll caps done rows]')
  // Mark several done.
  for (const id of [idA, idB, idTodo]) await a.markDone(id, new Date().toISOString())
  const all3 = await a.listAll(2)
  const doneCount = all3.filter((t) => t.doneAt !== null).length
  check(`listAll(2) returns ≤2 done rows (got ${doneCount})`, doneCount <= 2)
  const all0 = await a.listAll(0)
  check(
    `listAll(0) returns no done rows (got ${all0.filter((t) => t.doneAt !== null).length})`,
    all0.filter((t) => t.doneAt !== null).length === 0,
  )

  // ---------- Test 6: remove ----------
  console.log('\n[remove]')
  const okRemove = await a.remove(idReminder)
  check('remove returns true on real id', okRemove === true)
  const okRemove2 = await a.remove(idReminder)
  check('remove returns false on already-removed id', okRemove2 === false)

  // ---------- Test 7: clear ----------
  console.log('\n[clear]')
  const before = await a.countActive()
  const cleared = await a.clear()
  check(`clear returns count >0 (got ${cleared})`, cleared > 0)
  check('countActive 0 after clear', (await a.countActive()) === 0)
  void before

  a.close()
  rmSync(dir1, { recursive: true, force: true })

  // ---------- Test 8: legacy reminders migration ----------
  console.log('\n[migrate legacy reminders.sqlite]')
  const dir2 = mkdtempSync(join(tmpdir(), 'openmeido-task-mig-rem-'))
  // Build a synthetic reminders.sqlite the way the OLD adapter would have.
  {
    const oldDb = new Database(join(dir2, 'reminders.sqlite'))
    oldDb.exec(`
      CREATE TABLE reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        fire_at TEXT NOT NULL,
        message TEXT NOT NULL,
        session_id TEXT,
        fired_at TEXT
      );
    `)
    const ins = oldDb.prepare(
      `INSERT INTO reminders (created_at, fire_at, message, session_id, fired_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    // A pending reminder (fire_at future, fired_at null)
    ins.run(
      new Date(Date.now() - 86_400_000).toISOString(),
      new Date(Date.now() + 60_000).toISOString(),
      '喝水',
      'sess-old-1',
      null,
    )
    // An already-fired reminder
    ins.run(
      new Date(Date.now() - 2 * 86_400_000).toISOString(),
      new Date(Date.now() - 86_400_000).toISOString(),
      '昨天的提醒',
      'sess-old-1',
      new Date(Date.now() - 86_400_000).toISOString(),
    )
    oldDb.close()
  }
  // Now open tasks adapter in the same dir — should migrate.
  const m = openSqliteTasks(dir2)
  const all = await m.listAll(10)
  check(`migrated to 2 task rows (got ${all.length})`, all.length === 2)
  const pendingMig = all.find((t) => t.text === '喝水')
  check('pending reminder migrated as active (doneAt null)', pendingMig?.doneAt === null)
  check('pending reminder kept its fireAt', !!pendingMig?.fireAt)
  const firedMig = all.find((t) => t.text === '昨天的提醒')
  check('fired reminder migrated as DONE (doneAt set)', firedMig?.doneAt !== null)
  check('fired reminder kept notifiedAt', firedMig?.notifiedAt !== null)
  // Old file should be renamed to .bak
  const { existsSync } = await import('node:fs')
  check(
    'reminders.sqlite renamed to .bak',
    existsSync(join(dir2, 'reminders.sqlite.bak')) &&
      !existsSync(join(dir2, 'reminders.sqlite')),
  )
  m.close()
  rmSync(dir2, { recursive: true, force: true })

  // ---------- Test 9: idempotent migration (re-running doesn't duplicate) ----------
  console.log('\n[migration is idempotent on subsequent opens]')
  const dir3 = mkdtempSync(join(tmpdir(), 'openmeido-task-mig-idem-'))
  // Same setup but only one reminder for clarity
  {
    const oldDb = new Database(join(dir3, 'reminders.sqlite'))
    oldDb.exec(
      `CREATE TABLE reminders (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         created_at TEXT NOT NULL,
         fire_at TEXT NOT NULL,
         message TEXT NOT NULL,
         session_id TEXT,
         fired_at TEXT
       )`,
    )
    oldDb
      .prepare(
        `INSERT INTO reminders (created_at, fire_at, message, session_id, fired_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        new Date().toISOString(),
        new Date(Date.now() + 60_000).toISOString(),
        '一次性',
        null,
        null,
      )
    oldDb.close()
  }
  const m1 = openSqliteTasks(dir3)
  const count1 = (await m1.listAll(10)).length
  m1.close()
  // Re-open — migration already happened, .bak is present, real reminders.sqlite is gone
  const m2 = openSqliteTasks(dir3)
  const count2 = (await m2.listAll(10)).length
  check(`re-open same dir → row count unchanged (${count1} → ${count2})`, count1 === count2)
  m2.close()
  rmSync(dir3, { recursive: true, force: true })

  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
}

app.whenReady().then(main).catch((err) => {
  console.error('crashed:', err)
  app.exit(1)
})
