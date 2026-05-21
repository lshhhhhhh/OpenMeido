/**
 * Smoke test: per-persona memory isolation.
 *
 * Verifies the core promise of the 人物 system — that episodes, facts,
 * affinity, and session listings for one persona never bleed into
 * another. Without this, switching from 女仆 to 大小姐 would dump the
 * maid's chat history onto the ojou's screen, defeating the entire
 * "she doesn't know me yet" UX.
 *
 * What it asserts:
 *   1. addEpisode under maid leaves imouto's pool empty
 *   2. recent(maid) returns only maid rows
 *   3. searchByEmbedding(maid) returns only maid rows even when imouto
 *      rows have closer vectors (the JOIN-and-filter must work)
 *   4. count(personaId) is per-persona
 *   5. listSessions(personaId) is per-persona
 *   6. clear(maid) leaves imouto rows intact
 *   7. upsertFact(maid) under same key as imouto's existing fact creates
 *      a NEW fact (doesn't supersede the imouto one)
 *   8. listActiveFacts(maid) returns only maid facts
 *   9. getAffinity(maid) and getAffinity(imouto) are independent
 *  10. deletePersona(imouto) wipes only imouto
 *
 * Runs in Electron because the real sqlite-memory-adapter needs the
 * better-sqlite3 native binding + sqlite-vec extension.
 *
 * Run: npm run test:persona-isolation
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
  const check = (name, ok, detail = '') => {
    if (ok) {
      pass++
      console.log(`  ✓ ${name}`)
    } else {
      fail++
      console.log(`  ✗ ${name} :: ${detail}`)
    }
  }

  const dir = mkdtempSync(join(tmpdir(), 'openmeido-isolation-'))
  // migrate-active arg moot — fresh DB so no rows to backfill.
  const adapter = openSqliteMemory(dir, 4, 'maid')

  // Hand-crafted 4-D embeddings so we can control "closeness". Maid rows
  // get vectors near [1,0,0,0]; imouto rows near [0,1,0,0].
  const vMaid = (eps = 0.01) => Float32Array.of(1 - eps, eps, 0, 0)
  const vImouto = (eps = 0.01) => Float32Array.of(eps, 1 - eps, 0, 0)

  // ---------- 1+2. addEpisode + recent isolation ----------
  console.log('\n[1+2: addEpisode + recent isolation]')
  const maidEp1 = await adapter.addEpisode('maid', 'user', '主人，今天天气真好', vMaid(), 's1')
  const maidEp2 = await adapter.addEpisode('maid', 'assistant', '是呢，主人要不要去散步？', vMaid(0.02), 's1')
  const imoEp1 = await adapter.addEpisode('imouto', 'user', '哥你在干嘛', vImouto(), 's2')
  check('maid has 2 episodes', (await adapter.count('maid')) === 2)
  check('imouto has 1 episode', (await adapter.count('imouto')) === 1)
  check('ojou has 0 episodes (never touched)', (await adapter.count('ojou')) === 0)

  const maidRecent = await adapter.recent('maid', 10)
  check(`maid.recent returns 2 (got ${maidRecent.length})`, maidRecent.length === 2)
  check('maid.recent has no imouto rows', !maidRecent.some((e) => e.text.includes('哥你在干嘛')))
  const imoRecent = await adapter.recent('imouto', 10)
  check(`imouto.recent returns 1 (got ${imoRecent.length})`, imoRecent.length === 1)
  check('imouto.recent has only imouto rows', imoRecent.every((e) => e.text.includes('哥你在干嘛')))

  // ---------- 3. searchByEmbedding isolation under cross-contamination ----------
  console.log('\n[3: searchByEmbedding isolation]')
  // Query with an imouto-leaning vector — the imouto row is closer in
  // vec space, but the maid persona scope must filter it out.
  const maidSearchWithImoQuery = await adapter.searchByEmbedding('maid', vImouto(), 5)
  check(
    'maid.search with imouto-leaning query → no imouto rows leak',
    !maidSearchWithImoQuery.some((e) => e.text.includes('哥你在干嘛')),
  )
  // And imouto search returns only the imouto row (even if maid rows
  // exist with closer vectors — none here, but the principle is tested).
  const imoSearch = await adapter.searchByEmbedding('imouto', vImouto(), 5)
  check(
    `imouto.search returns the imouto row (got ${imoSearch.length})`,
    imoSearch.length === 1 && imoSearch[0]?.text.includes('哥你在干嘛'),
  )

  // ---------- 5. listSessions isolation ----------
  console.log('\n[5: listSessions isolation]')
  const maidSessions = await adapter.listSessions('maid')
  const imoSessions = await adapter.listSessions('imouto')
  check(`maid.listSessions returns 1 (got ${maidSessions.length})`, maidSessions.length === 1)
  check(`imouto.listSessions returns 1 (got ${imoSessions.length})`, imoSessions.length === 1)
  check(
    'sessions live in separate buckets',
    maidSessions[0]?.id !== imoSessions[0]?.id,
  )

  // ---------- 7+8. Facts isolation ----------
  console.log('\n[7+8: facts isolation]')
  await adapter.upsertFact('maid', {
    key: 'user.profile.mood',
    value: '今天心情不错',
    confidence: 0.9,
    sourceEpisodeIds: [maidEp1],
  })
  await adapter.upsertFact('imouto', {
    key: 'user.profile.mood',
    value: '今天有点烦',
    confidence: 0.9,
    sourceEpisodeIds: [imoEp1],
  })
  // Same key under different personas — should NOT supersede each other.
  const maidFacts = await adapter.listActiveFacts('maid')
  const imoFacts = await adapter.listActiveFacts('imouto')
  check(`maid has 1 active fact (got ${maidFacts.length})`, maidFacts.length === 1)
  check('maid fact value is maid-specific', maidFacts[0]?.value === '今天心情不错')
  check(`imouto has 1 active fact (got ${imoFacts.length})`, imoFacts.length === 1)
  check('imouto fact value is imouto-specific', imoFacts[0]?.value === '今天有点烦')

  // Now upsert a contradicting fact under maid — should supersede maid's
  // own fact, not imouto's.
  await adapter.upsertFact('maid', {
    key: 'user.profile.mood',
    value: '突然又有点丧',
    sourceEpisodeIds: [maidEp2],
  })
  const maidFacts2 = await adapter.listActiveFacts('maid')
  const imoFacts2 = await adapter.listActiveFacts('imouto')
  check(
    'maid still has 1 active fact (supersession worked)',
    maidFacts2.length === 1 && maidFacts2[0]?.value === '突然又有点丧',
  )
  check(
    'imouto fact untouched by maid supersession',
    imoFacts2.length === 1 && imoFacts2[0]?.value === '今天有点烦',
  )

  // ---------- 9. Affinity isolation ----------
  console.log('\n[9: affinity isolation]')
  const aMaid0 = await adapter.getAffinity('maid')
  const aImo0 = await adapter.getAffinity('imouto')
  check('maid affinity defaults to 0', aMaid0.score === 0)
  check('imouto affinity defaults to 0', aImo0.score === 0)
  await adapter.setAffinity('maid', 47, '主人记得了我喜欢吃布丁')
  const aMaid1 = await adapter.getAffinity('maid')
  const aImo1 = await adapter.getAffinity('imouto')
  check(`maid affinity now 47 (got ${aMaid1.score})`, aMaid1.score === 47)
  check('maid affinity has reason', aMaid1.lastReason === '主人记得了我喜欢吃布丁')
  check('imouto affinity untouched (still 0)', aImo1.score === 0)

  // ---------- 6. clear(persona) isolation ----------
  console.log('\n[6: clear(persona) isolation]')
  const cleared = await adapter.clear('maid')
  check(`clear('maid') removed >= 2 rows (got ${cleared})`, cleared >= 2)
  check(`maid has 0 episodes after clear`, (await adapter.count('maid')) === 0)
  check(`imouto still has 1 episode`, (await adapter.count('imouto')) === 1)
  // Imouto's search should still work
  const imoSearchAfter = await adapter.searchByEmbedding('imouto', vImouto(), 5)
  check(
    `imouto can still semantic-search after maid clear (got ${imoSearchAfter.length})`,
    imoSearchAfter.length === 1,
  )

  // ---------- 10. deletePersona wipes everything for one persona ----------
  console.log('\n[10: deletePersona wipes everything]')
  // Seed an ojou record so we have a 3-way test
  await adapter.addEpisode('ojou', 'user', '哼', vMaid(), 's3')
  await adapter.setAffinity('ojou', 5, 'just met')
  await adapter.upsertFact('ojou', { key: 'k', value: 'v' })

  const ojouDeleted = await adapter.deletePersona('ojou')
  check(`deletePersona('ojou') removed >= 3 rows (got ${ojouDeleted})`, ojouDeleted >= 3)
  check('ojou episodes wiped', (await adapter.count('ojou')) === 0)
  check('ojou facts wiped', (await adapter.listActiveFacts('ojou')).length === 0)
  check('ojou affinity reset to default', (await adapter.getAffinity('ojou')).score === 0)
  // Imouto data untouched
  check('imouto episodes intact', (await adapter.count('imouto')) === 1)
  check(
    'imouto fact intact',
    (await adapter.listActiveFacts('imouto')).length === 1,
  )

  adapter.close()
  rmSync(dir, { recursive: true, force: true })
  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
}

app.whenReady().then(main).catch((err) => {
  console.error('crashed:', err)
  app.exit(1)
})
