/**
 * End-to-end memory smoke with the new local-embed stack.
 *
 * Exercises: bge-small-zh-v1.5 → sqlite-vec vec0 → KNN search. Confirms
 * the embedding-dim migration (1536 → 512) doesn't trip up the actual
 * recall flow.
 *
 * Run: npx electron tools/smoke-memory-local.mjs
 */

import { app } from 'electron'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { pipeline, env } from '@huggingface/transformers'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

async function main() {
  // Share the prod model cache so we don't re-download.
  const cacheDir = join(app.getPath('userData'), 'hf-cache')
  mkdirSync(cacheDir, { recursive: true })
  env.cacheDir = cacheDir

  console.log('Loading bge-small-zh-v1.5 ...')
  const extractor = await pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5')

  async function embed(text) {
    const out = await extractor(text, { pooling: 'cls', normalize: true })
    return Float32Array.from(out.data)
  }

  const dim = 512
  const dir = mkdtempSync(join(tmpdir(), 'openmeido-mem-local-'))
  console.log('Temp dir:', dir)

  const db = new Database(join(dir, 'memory.sqlite'))
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

  console.log('\nWriting 6 episodes ...')
  for (const [speaker, text] of turns) {
    const vec = await embed(text)
    const row = db
      .prepare('INSERT INTO episodes (ts, speaker, text) VALUES (?, ?, ?)')
      .run(new Date().toISOString(), speaker, text)
    db.prepare('INSERT INTO episodes_vec (episode_id, embedding) VALUES (?, ?)').run(
      BigInt(Number(row.lastInsertRowid)),
      Buffer.from(vec.buffer),
    )
  }

  console.log('\nQueries:')
  const queries = [
    { q: '我的猫叫什么名字', expect: '阿黄' },
    { q: '我是做什么职业的', expect: '程序员' },
  ]

  let pass = true
  for (const { q, expect } of queries) {
    const qVec = await embed(q)
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
    if (!rows.some((r) => r.text.includes(expect))) {
      pass = false
      console.log(`  ❌ "${expect}" NOT in top-3`)
    } else {
      console.log(`  ✅ "${expect}" recalled`)
    }
  }

  db.close()
  rmSync(dir, { recursive: true, force: true })
  console.log(pass ? '\n✅ Memory pipeline (local embed) PASSED' : '\n❌ FAILED')
  app.exit(pass ? 0 : 1)
}

app.whenReady().then(main).catch((err) => {
  console.error('crashed:', err)
  app.exit(1)
})
