/**
 * Smoke test for the persona-lore pipeline.
 *
 * Verifies (without launching the full app):
 *   - openSqliteMemory() applies the kind migration cleanly
 *   - addEpisode with kind='lore' writes a row that does NOT show up in
 *     recent() but DOES show up in searchByEmbedding() when the query is
 *     similar
 *   - addEpisode with default kind ('chat') stays in recent()
 *   - clearLore wipes only kind='lore' rows
 *   - deleteFactsByKeyPrefix wipes facts by key prefix
 *   - upsertFact with key prefix 'persona.' lands as scope='persona'
 *
 * Runs in Electron because the real sqlite-memory-adapter needs the
 * better-sqlite3 native binding (compiled against electron's node ABI).
 *
 * Run: npx electron tools/smoke-persona-lore.mjs
 */
import { app } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

async function main() {
  const { register } = await import('tsx/esm/api')
  register()
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

  // Fake embedding: per-text deterministic vector so we can engineer
  // similarity. Not cryptographically meaningful — just enough to
  // demonstrate the KNN path picks up the lore row.
  function fakeEmbed(text) {
    const dim = 8
    const v = new Float32Array(dim)
    let h = 0
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0
    for (let i = 0; i < dim; i++) v[i] = ((h >>> (i * 4)) & 0xff) / 255
    let norm = 0
    for (let i = 0; i < dim; i++) norm += v[i] * v[i]
    norm = Math.sqrt(norm) || 1
    for (let i = 0; i < dim; i++) v[i] /= norm
    return v
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'persona-lore-smoke-'))
  console.log(`[lore-smoke] tmp dir: ${tmpDir}`)

  try {
    const adapter = openSqliteMemory(tmpDir, 8, 'maid')

    console.log('\n[1] addEpisode default kind = chat')
    const chatId = await adapter.addEpisode(
      'maid',
      'user',
      'Hello chat row',
      fakeEmbed('Hello chat row'),
      null,
    )
    t(typeof chatId === 'number', `chat row written (id=${chatId})`)

    console.log('\n[2] addEpisode with kind=lore')
    const loreText = '她还记得祖母教她递茶时小指要紧贴杯壁'
    const loreId = await adapter.addEpisode(
      'maid',
      'assistant',
      loreText,
      fakeEmbed(loreText),
      null,
      undefined,
      undefined,
      'lore',
    )
    t(typeof loreId === 'number' && loreId !== chatId, `lore row written (id=${loreId})`)

    console.log('\n[3] recent() returns chat but NOT lore')
    const recent = await adapter.recent('maid', 100)
    const recentIds = recent.map((e) => e.id)
    t(recentIds.includes(chatId), 'recent includes chat row')
    t(!recentIds.includes(loreId), 'recent EXCLUDES lore row')
    t(
      recent.every((e) => e.kind === 'chat'),
      `every recent row has kind='chat' (got: ${recent.map((e) => e.kind).join(',')})`,
    )

    console.log('\n[4] count() reports chat only')
    const count = await adapter.count('maid')
    t(count === 1, `count = 1 (excludes lore); got ${count}`)

    console.log('\n[5] listSessions() returns chat-only sessions')
    const sessions = await adapter.listSessions('maid')
    t(sessions.length >= 1, `sessions list non-empty (got ${sessions.length})`)

    console.log('\n[6] searchByEmbedding surfaces lore row')
    const knnHits = await adapter.searchByEmbedding('maid', fakeEmbed(loreText), 5)
    const knnIds = knnHits.map((e) => e.id)
    t(knnIds.includes(loreId), `KNN top-5 includes lore id=${loreId} (got: [${knnIds.join(',')}])`)
    const loreHit = knnHits.find((e) => e.id === loreId)
    t(loreHit?.kind === 'lore', `retrieved lore row has kind='lore'`)

    console.log('\n[7] upsertFact with persona.* key → scope=persona')
    const fact = await adapter.upsertFact('maid', {
      key: 'persona.relationship.framing',
      value: 'She is new here.',
      confidence: 1.0,
    })
    t(fact?.scope === 'persona', `anchor fact scope = 'persona'; got '${fact?.scope}'`)

    console.log('\n[8] deleteFactsByKeyPrefix wipes anchors')
    const wipedFacts = await adapter.deleteFactsByKeyPrefix('maid', 'persona.relationship.')
    t(wipedFacts >= 1, `deleted ≥1 anchor fact (got ${wipedFacts})`)

    console.log('\n[9] clearLore wipes only lore episodes')
    const wipedLore = await adapter.clearLore('maid')
    t(wipedLore === 1, `clearLore removed 1 row (got ${wipedLore})`)
    const recentAfter = await adapter.recent('maid', 100)
    t(recentAfter.length === 1, `chat row survives after clearLore (recent=${recentAfter.length})`)
    const knnAfter = await adapter.searchByEmbedding('maid', fakeEmbed(loreText), 5)
    t(
      !knnAfter.map((e) => e.id).includes(loreId),
      `lore row no longer in KNN results after clearLore`,
    )

    adapter.close()
  } catch (err) {
    console.error('\n[fatal]', err)
    fail++
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
}

app.whenReady().then(main).catch((err) => {
  console.error(err)
  app.exit(1)
})
