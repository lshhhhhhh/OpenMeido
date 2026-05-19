/**
 * MemoryAdapter implementation using better-sqlite3 + sqlite-vec.
 *
 * Lives in src/main/ because better-sqlite3 is a Node-native module — it
 * only loads inside the Electron main process. Mobile / PWA hosts will
 * provide their own adapter (IndexedDB + JS cosine, or sql.js WASM with
 * the WASM build of sqlite-vec).
 *
 * Two non-obvious sqlite-vec details that bit us during the initial
 * implementation:
 *
 *   1. vec0 rejects the PK if better-sqlite3 binds it as a plain JS Number
 *      ("Only integers are allowed for primary key values"). BigInt-coerced
 *      values bind correctly.
 *   2. KNN queries require the LIMIT (or `k = ?`) clause to apply DIRECTLY
 *      to the vec0 table; LIMIT on a JOIN result errors out. We do the KNN
 *      in an inner subquery and JOIN episodes afterward.
 */

import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import type { MemoryAdapter } from '../../core/memory/adapter.js'
import type { Episode, Fact, NewFact, SessionSummary, Speaker } from '../../core/memory/types.js'

interface EpisodeRow {
  id: number
  ts: string
  speaker: Speaker
  text: string
  sessionId: string | null
}

export function openSqliteMemory(dataDir: string, dim: number): MemoryAdapter {
  mkdirSync(dataDir, { recursive: true })
  const db = new Database(join(dataDir, 'memory.sqlite'))

  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  sqliteVec.load(db)

  db.exec(`
    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      speaker TEXT NOT NULL CHECK (speaker IN ('user', 'assistant')),
      text TEXT NOT NULL,
      session_id TEXT,
      archived INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_episodes_ts ON episodes(ts);
    CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id);

    -- L3 facts: LLM-distilled stable knowledge. supersededBy points to the
    -- row that replaced this one (NULL = currently active). We never DELETE
    -- a fact on contradiction — supersession keeps the history queryable
    -- so the user (or the model) can audit why a fact changed.
    CREATE TABLE IF NOT EXISTS facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      source_episode_ids TEXT NOT NULL DEFAULT '[]',
      superseded_by INTEGER REFERENCES facts(id)
    );

    -- Partial index on (key) WHERE active. Active-fact lookups dominate
    -- (every chat turn injects them into the system prompt) so the index
    -- size is dominated by the live set, not history.
    CREATE INDEX IF NOT EXISTS idx_facts_key_active
      ON facts(key) WHERE superseded_by IS NULL;
  `)

  // vec0 locks `dim` at CREATE time. Inspect any pre-existing episodes_vec
  // table; if its dim doesn't match the requested one (e.g. user migrated
  // from cloud 1536-dim embeddings to local bge 512-dim), drop and
  // recreate. The companion episodes table is left alone — those rows
  // simply won't be recallable until they're re-embedded, but they remain
  // visible in the Memory inspector.
  const existing = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'episodes_vec'")
    .get() as { sql?: string } | undefined
  if (existing?.sql) {
    const m = existing.sql.match(/FLOAT\[(\d+)\]/i)
    const existingDim = m && m[1] ? Number(m[1]) : NaN
    if (existingDim && existingDim !== dim) {
      console.warn(
        `[memory] embedding dim changed (${existingDim} -> ${dim}); dropping vec0 table. ` +
          'Existing episodes remain but won\'t participate in semantic recall until re-embedded.',
      )
      db.exec('DROP TABLE episodes_vec')
    }
  }
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS episodes_vec USING vec0(
      episode_id INTEGER PRIMARY KEY,
      embedding FLOAT[${dim}]
    );
  `)

  // Prepared statements — better-sqlite3 caches them after first compile.
  const insertEpisode = db.prepare<[string, Speaker, string, string | null]>(
    'INSERT INTO episodes (ts, speaker, text, session_id) VALUES (?, ?, ?, ?)',
  )
  const insertVec = db.prepare<[bigint, Buffer]>(
    'INSERT INTO episodes_vec (episode_id, embedding) VALUES (?, ?)',
  )
  const selectRecent = db.prepare<[number]>(
    `SELECT id, ts, speaker, text, session_id AS sessionId
     FROM episodes
     WHERE archived = 0
     ORDER BY id DESC
     LIMIT ?`,
  )
  // COALESCE so the 'legacy' bucket id matches rows with session_id IS NULL.
  const selectRecentInSession = db.prepare<[string, number]>(
    `SELECT id, ts, speaker, text, session_id AS sessionId
     FROM episodes
     WHERE archived = 0 AND COALESCE(session_id, 'legacy') = ?
     ORDER BY id DESC
     LIMIT ?`,
  )
  /**
   * Per-session summary. Episodes written before the session-id tracking
   * existed have session_id = NULL — we COALESCE them into a synthetic
   * 'legacy' bucket so the user can still see those chats in the picker.
   * The correlated subquery pulls the first user message for the preview.
   */
  const selectSessions = db.prepare(
    `SELECT
        COALESCE(session_id, 'legacy') AS id,
        COUNT(*) AS count,
        MIN(ts) AS startTs,
        MAX(ts) AS lastTs,
        COALESCE(
          (SELECT text FROM episodes e2
           WHERE COALESCE(e2.session_id, 'legacy') = COALESCE(e.session_id, 'legacy')
             AND e2.speaker = 'user'
           ORDER BY e2.id ASC LIMIT 1),
          ''
        ) AS preview
     FROM episodes e
     WHERE archived = 0
     GROUP BY COALESCE(session_id, 'legacy')
     ORDER BY MAX(ts) DESC`,
  )
  const selectByKnn = db.prepare<[Buffer, number]>(
    `SELECT e.id, e.ts, e.speaker, e.text, e.session_id AS sessionId, vc.distance
     FROM (
       SELECT episode_id, distance
       FROM episodes_vec
       WHERE embedding MATCH ?
       ORDER BY distance
       LIMIT ?
     ) vc
     JOIN episodes e ON e.id = vc.episode_id
     WHERE e.archived = 0
     ORDER BY vc.distance`,
  )
  const countEpisodes = db.prepare('SELECT COUNT(*) AS c FROM episodes WHERE archived = 0')

  // ---- L3 facts prepared statements ----
  const selectActiveByKey = db.prepare<[string]>(
    `SELECT id, key, value, confidence, created_at AS createdAt, updated_at AS updatedAt,
            source_episode_ids AS sourceEpisodeIdsJson, superseded_by AS supersededBy
     FROM facts
     WHERE key = ? AND superseded_by IS NULL`,
  )
  const insertFact = db.prepare<[string, string, number, string, string, string]>(
    `INSERT INTO facts (key, value, confidence, created_at, updated_at, source_episode_ids)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  const bumpFact = db.prepare<[number, string, number]>(
    `UPDATE facts SET confidence = ?, updated_at = ? WHERE id = ?`,
  )
  const supersedeFact = db.prepare<[number, number]>(
    `UPDATE facts SET superseded_by = ? WHERE id = ?`,
  )
  const selectFactById = db.prepare<[number]>(
    `SELECT id, key, value, confidence, created_at AS createdAt, updated_at AS updatedAt,
            source_episode_ids AS sourceEpisodeIdsJson, superseded_by AS supersededBy
     FROM facts WHERE id = ?`,
  )
  const selectActiveFacts = db.prepare<[number]>(
    `SELECT id, key, value, confidence, created_at AS createdAt, updated_at AS updatedAt,
            source_episode_ids AS sourceEpisodeIdsJson, superseded_by AS supersededBy
     FROM facts
     WHERE superseded_by IS NULL
     ORDER BY updated_at DESC
     LIMIT ?`,
  )
  const selectFactHistory = db.prepare<[string]>(
    `SELECT id, key, value, confidence, created_at AS createdAt, updated_at AS updatedAt,
            source_episode_ids AS sourceEpisodeIdsJson, superseded_by AS supersededBy
     FROM facts
     WHERE key = ?
     ORDER BY id ASC`,
  )

  interface FactRow {
    id: number
    key: string
    value: string
    confidence: number
    createdAt: string
    updatedAt: string
    sourceEpisodeIdsJson: string
    supersededBy: number | null
  }
  const rowToFact = (r: FactRow): Fact => ({
    id: r.id,
    key: r.key,
    value: r.value,
    confidence: r.confidence,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    sourceEpisodeIds: safeParseIntArray(r.sourceEpisodeIdsJson),
    supersededBy: r.supersededBy,
  })

  const addTxn = db.transaction(
    (speaker: Speaker, text: string, sessionId: string | null, embedding: Float32Array): number => {
      const ts = new Date().toISOString()
      const row = insertEpisode.run(ts, speaker, text, sessionId)
      const episodeId = Number(row.lastInsertRowid)
      insertVec.run(BigInt(episodeId), Buffer.from(embedding.buffer))
      return episodeId
    },
  )

  let closed = false
  const ensureOpen = (): void => {
    if (closed) throw new Error('sqlite-memory-adapter: closed')
  }

  return {
    async addEpisode(speaker, text, embedding, sessionId = null) {
      ensureOpen()
      return addTxn(speaker, text, sessionId, embedding)
    },

    async recent(n, sessionId) {
      ensureOpen()
      if (n <= 0) return []
      const rows = sessionId
        ? (selectRecentInSession.all(sessionId, n) as EpisodeRow[])
        : (selectRecent.all(n) as EpisodeRow[])
      return rows.reverse()
    },

    async listSessions() {
      ensureOpen()
      return selectSessions.all() as SessionSummary[]
    },

    async searchByEmbedding(queryEmbedding, k, excludeIds = new Set()) {
      ensureOpen()
      if (k <= 0) return []
      // Overfetch so we still get k after filtering excluded ids.
      const limit = k + excludeIds.size + 4
      const rows = selectByKnn.all(
        Buffer.from(queryEmbedding.buffer),
        limit,
      ) as (EpisodeRow & { distance: number })[]
      const filtered: Episode[] = []
      for (const r of rows) {
        if (excludeIds.has(r.id)) continue
        filtered.push({
          id: r.id,
          ts: r.ts,
          speaker: r.speaker,
          text: r.text,
          sessionId: r.sessionId,
        })
        if (filtered.length >= k) break
      }
      return filtered
    },

    async count() {
      ensureOpen()
      const row = countEpisodes.get() as { c: number }
      return row.c
    },

    async clear() {
      ensureOpen()
      // Delete in a transaction so the two tables stay in sync. vec0 has no
      // ON DELETE CASCADE hook, so we have to clear it explicitly.
      const wipe = db.transaction(() => {
        const result = db.prepare('DELETE FROM episodes').run()
        db.prepare('DELETE FROM episodes_vec').run()
        return Number(result.changes)
      })
      return wipe()
    },

    async deleteSession(sessionId: string) {
      ensureOpen()
      // Pull the doomed ids first so we can drop their vec rows too.
      const wipe = db.transaction(() => {
        const ids = db
          .prepare<[string]>(
            "SELECT id FROM episodes WHERE COALESCE(session_id, 'legacy') = ?",
          )
          .all(sessionId) as { id: number }[]
        if (ids.length === 0) return 0
        const delVec = db.prepare('DELETE FROM episodes_vec WHERE episode_id = ?')
        for (const { id } of ids) delVec.run(BigInt(id))
        const result = db
          .prepare<[string]>("DELETE FROM episodes WHERE COALESCE(session_id, 'legacy') = ?")
          .run(sessionId)
        return Number(result.changes)
      })
      return wipe()
    },

    async upsertFact(input: NewFact) {
      ensureOpen()
      const now = new Date().toISOString()
      const sourceIds = JSON.stringify(input.sourceEpisodeIds ?? [])
      const inputConf = input.confidence ?? 1.0
      const existing = selectActiveByKey.get(input.key) as FactRow | undefined
      const txn = db.transaction((): Fact => {
        if (existing && existing.value === input.value) {
          // Same key + same value → reinforce. Confidence drifts toward 1.0
          // by averaging the incoming confidence with the existing one — a
          // simple way to make stable facts converge without ever exceeding 1.
          const newConf = Math.min(1.0, (existing.confidence + inputConf) / 2 + 0.05)
          bumpFact.run(newConf, now, existing.id)
          return rowToFact({ ...existing, confidence: newConf, updatedAt: now })
        }
        // Either no active row yet, or value differs (contradiction). In
        // both cases we insert a NEW row, then point the old active row
        // (if any) at the new one as its supersedor.
        const ins = insertFact.run(input.key, input.value, inputConf, now, now, sourceIds)
        const newId = Number(ins.lastInsertRowid)
        if (existing) supersedeFact.run(newId, existing.id)
        return rowToFact(selectFactById.get(newId) as FactRow)
      })
      return txn()
    },

    async listActiveFacts(limit = 200) {
      ensureOpen()
      return (selectActiveFacts.all(limit) as FactRow[]).map(rowToFact)
    },

    async listFactHistory(key: string) {
      ensureOpen()
      return (selectFactHistory.all(key) as FactRow[]).map(rowToFact)
    },

    async clearFacts() {
      ensureOpen()
      const result = db.prepare('DELETE FROM facts').run()
      return Number(result.changes)
    },

    close() {
      if (closed) return
      closed = true
      db.close()
    },
  }
}

/**
 * Tolerant parser for the source_episode_ids JSON column. Defaults to []
 * on any shape error — a malformed JSON should never crash a chat turn.
 */
function safeParseIntArray(s: string | null): number[] {
  if (!s) return []
  try {
    const parsed = JSON.parse(s)
    if (Array.isArray(parsed)) {
      return parsed.filter((n) => typeof n === 'number' && Number.isFinite(n))
    }
  } catch {
    /* fall through */
  }
  return []
}
