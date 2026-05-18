/**
 * Memory pipeline smoke test.
 *
 * Verifies in isolation that:
 *   1. better-sqlite3 + sqlite-vec load in the Electron Node runtime
 *   2. The /embeddings endpoint actually returns vectors
 *   3. The vec0 MATCH + ORDER BY distance flow returns the right hits
 *
 * Doesn't touch the app's persistent DB — uses a fresh temp dir.
 *
 * Run: npx electron tools/smoke-memory.mjs
 *
 * Why electron and not node: native modules are rebuilt for Electron's
 * NODE_MODULE_VERSION (130) and won't load in host Node (137).
 */

import { app } from 'electron'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

async function embed(text, opts) {
  const res = await fetch(opts.baseUrl.replace(/\/$/, '') + '/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({ input: text, model: opts.model, dimensions: opts.dim }),
  })
  if (!res.ok) throw new Error(`embed ${res.status}: ${await res.text()}`)
  const json = await res.json()
  return new Float32Array(json.data[0].embedding)
}

async function main() {
  try {
    process.loadEnvFile('.env')
  } catch {}

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    console.error('❌ OPENAI_API_KEY not set in .env')
    app.exit(1)
    return
  }

  const dim = 1536
  const opts = {
    baseUrl: 'https://api.openai.com/v1',
    apiKey,
    model: 'text-embedding-3-small',
    dim,
  }

  const dir = join(tmpdir(), 'openmeido-smoke-' + Date.now())
  mkdirSync(dir, { recursive: true })
  console.log('Temp dir:', dir)

  const db = new Database(join(dir, 'mem.sqlite'))
  db.pragma('journal_mode = WAL')
  sqliteVec.load(db)

  db.exec(`
    CREATE TABLE episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      speaker TEXT NOT NULL,
      text TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE episodes_vec USING vec0(
      episode_id INTEGER PRIMARY KEY,
      embedding FLOAT[${dim}]
    );
  `)

  const turns = [
    ['user', '我叫小李，是一名程序员'],
    ['assistant', '你好小李，很高兴认识你'],
    ['user', '我养了一只橘猫，叫阿黄'],
    ['assistant', '阿黄是个好名字'],
    ['user', '今天天气真不错'],
    ['assistant', '是啊，适合出去走走'],
  ]

  console.log('\n--- Writing episodes ---')
  for (const [speaker, text] of turns) {
    const vec = await embed(text, opts)
    const row = db
      .prepare('INSERT INTO episodes (ts, speaker, text) VALUES (?, ?, ?)')
      .run(new Date().toISOString(), speaker, text)
    const id = Number(row.lastInsertRowid)
    db.prepare('INSERT INTO episodes_vec (episode_id, embedding) VALUES (?, ?)').run(
      BigInt(id),
      Buffer.from(vec.buffer),
    )
    console.log(`  stored: [${speaker}] ${text}`)
  }

  console.log('\n--- Retrieval test ---')
  const queries = [
    { q: '我的猫叫什么名字', expect: '阿黄' },
    { q: '我是做什么职业的', expect: '程序员' },
  ]
  let pass = true
  for (const { q, expect } of queries) {
    const qVec = await embed(q, opts)
    // KNN LIMIT must live directly on the vec0 table — use a subquery.
    const rows = db
      .prepare(
        `SELECT e.text, e.speaker, vc.distance
         FROM (
           SELECT episode_id, distance
           FROM episodes_vec
           WHERE embedding MATCH ?
           ORDER BY distance LIMIT 3
         ) vc JOIN episodes e ON e.id = vc.episode_id
         ORDER BY vc.distance`,
      )
      .all(Buffer.from(qVec.buffer))
    console.log(`\nQ: ${q}  (expecting hit on "${expect}")`)
    for (const r of rows) {
      console.log(`  [d=${r.distance.toFixed(3)}] (${r.speaker}) ${r.text}`)
    }
    const hit = rows.some((r) => r.text.includes(expect))
    console.log(hit ? `  ✅ "${expect}" recalled` : `  ❌ "${expect}" NOT in top-3`)
    if (!hit) pass = false
  }

  db.close()
  rmSync(dir, { recursive: true, force: true })

  console.log(pass ? '\n✅ Smoke test PASSED' : '\n❌ Smoke test FAILED')
  app.exit(pass ? 0 : 1)
}

app.whenReady().then(main).catch((err) => {
  console.error('Smoke crashed:', err)
  app.exit(1)
})
