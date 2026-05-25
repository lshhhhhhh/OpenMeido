/**
 * Regression test for the v0.3.0–0.3.3 memory-init crash.
 *
 * Bug: idx_episodes_kind was created in the top-level CREATE block, which
 * runs BEFORE the kind-column migration. On a pre-0.3.0 user DB (episodes
 * table without a `kind` column), `CREATE INDEX ... ON episodes(persona_id,
 * kind)` threw "no such column: kind", crashing memory init for EVERY
 * upgrading user. (Reported in the wild on a 0.3.x build.)
 *
 * This test simulates an old DB: it hand-creates a pre-0.3.0 episodes
 * table (no kind column) with a couple of rows, then opens it through the
 * production openSqliteMemory() path and asserts:
 *   - open does NOT throw (the crash is gone)
 *   - the kind column got added by migration
 *   - pre-existing rows are still queryable and defaulted to kind='chat'
 *     (so old chat history doesn't vanish from recent())
 *
 * Runs in Electron — better-sqlite3 native binding needs electron's node ABI.
 *
 * Run: npx electron tools/smoke-memory-upgrade.mjs
 */
import { app } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

async function main() {
  const { register } = await import('tsx/esm/api')
  register()
  const Database = (await import('better-sqlite3')).default
  const { openSqliteMemory } = await import('../src/main/storage/sqlite-memory-adapter.ts')

  let pass = 0
  let fail = 0
  const t = (ok, label, detail = '') => {
    if (ok) {
      pass++
      console.log(`  ✓ ${label}`)
    } else {
      fail++
      console.log(`  ✗ ${label}`)
      if (detail) console.log(`      ${detail}`)
    }
  }

  const dir = mkdtempSync(join(tmpdir(), 'mem-upgrade-'))
  const dbPath = join(dir, 'memory.sqlite')

  // ---- Step 1: hand-build a pre-0.3.0 episodes table (NO kind column) ----
  // Shape mirrors the post-tool-speaker, post-persona_id era (the most
  // common pre-0.3.0 state). Crucially: no `kind`, and the old indexes
  // that DID exist back then.
  {
    const old = new Database(dbPath)
    old.exec(`
      CREATE TABLE episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        speaker TEXT NOT NULL CHECK (speaker IN ('user', 'assistant', 'tool')),
        text TEXT NOT NULL,
        session_id TEXT,
        tool_data TEXT,
        images_data TEXT,
        persona_id TEXT NOT NULL DEFAULT 'maid',
        archived INTEGER DEFAULT 0
      );
      CREATE INDEX idx_episodes_ts ON episodes(ts);
      CREATE INDEX idx_episodes_session ON episodes(session_id);
      CREATE INDEX idx_episodes_persona ON episodes(persona_id);
    `)
    old
      .prepare(
        'INSERT INTO episodes (ts, speaker, text, session_id, persona_id) VALUES (?, ?, ?, ?, ?)',
      )
      .run(new Date().toISOString(), 'user', '主人你好呀', 's1', 'maid')
    old
      .prepare(
        'INSERT INTO episodes (ts, speaker, text, session_id, persona_id) VALUES (?, ?, ?, ?, ?)',
      )
      .run(new Date().toISOString(), 'assistant', '你回来啦', 's1', 'maid')
    old.close()
    console.log('[upgrade-smoke] seeded pre-0.3.0 episodes table (no kind column, 2 rows)')
  }

  // ---- Step 2: open through the production path ----
  let adapter = null
  let threw = null
  try {
    adapter = openSqliteMemory(dir, 8, 'maid')
  } catch (err) {
    threw = err
  }
  t(threw === null, 'openSqliteMemory did NOT throw on a pre-0.3.0 DB', threw ? String(threw) : '')

  if (adapter) {
    // ---- Step 3: kind column exists + old rows survive defaulted to 'chat' ----
    const recent = await adapter.recent('maid', 100)
    t(recent.length === 2, `both pre-existing rows still queryable (recent=${recent.length})`)
    t(
      recent.every((e) => e.kind === 'chat'),
      `pre-existing rows defaulted to kind='chat' (got: ${recent.map((e) => e.kind).join(',')})`,
    )
    t(
      recent.some((e) => e.text === '主人你好呀'),
      'old chat content preserved (not wiped by migration)',
    )

    // ---- Step 4: lore path works post-upgrade (kind='lore' write + filter) ----
    const loreId = await adapter.addEpisode(
      'maid',
      'assistant',
      '祖母教过我递茶的规矩',
      new Float32Array(8).fill(0.1),
      null,
      undefined,
      undefined,
      'lore',
    )
    t(typeof loreId === 'number', `lore write works after upgrade (id=${loreId})`)
    const recentAfter = await adapter.recent('maid', 100)
    t(
      !recentAfter.some((e) => e.id === loreId),
      'lore row excluded from recent() after upgrade',
    )

    adapter.close()
  }

  rmSync(dir, { recursive: true, force: true })
  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
}

app.whenReady().then(main).catch((err) => {
  console.error(err)
  app.exit(1)
})
