/**
 * Episodic memory — append-only log of user/assistant turns, each row paired
 * with an embedding in the vec0 virtual table. Provides recent-window read
 * + top-K cosine search.
 */

import type Database from 'better-sqlite3'

export type Speaker = 'user' | 'assistant'

export interface Episode {
  id: number
  ts: string
  speaker: Speaker
  text: string
  sessionId: string | null
}

export class EpisodicStore {
  constructor(private readonly db: Database.Database) {}

  /** Add a turn and its embedding atomically. */
  add(
    speaker: Speaker,
    text: string,
    embedding: Float32Array,
    sessionId: string | null = null,
  ): number {
    const insert = this.db.transaction((): number => {
      const ts = new Date().toISOString()
      const row = this.db
        .prepare<[string, Speaker, string, string | null]>(
          'INSERT INTO episodes (ts, speaker, text, session_id) VALUES (?, ?, ?, ?)',
        )
        .run(ts, speaker, text, sessionId)
      const episodeId = Number(row.lastInsertRowid)
      // sqlite-vec rejects the PK if better-sqlite3 binds it as a plain JS
      // Number ("Only integers are allowed for primary key values on
      // episodes_vec"); BigInt-coerced values bind correctly.
      this.db
        .prepare('INSERT INTO episodes_vec (episode_id, embedding) VALUES (?, ?)')
        .run(BigInt(episodeId), Buffer.from(embedding.buffer))
      return episodeId
    })
    return insert()
  }

  /** Most-recent N turns in chronological order (oldest first). */
  recent(n: number): Episode[] {
    if (n <= 0) return []
    const rows = this.db
      .prepare<[number]>(
        `SELECT id, ts, speaker, text, session_id AS sessionId
         FROM episodes
         WHERE archived = 0
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(n) as Array<{
      id: number
      ts: string
      speaker: Speaker
      text: string
      sessionId: string | null
    }>
    return rows.reverse()
  }

  /**
   * Top-K most cosine-similar episodes for the given query embedding. The
   * `excludeIds` set lets callers omit episodes already returned by recent()
   * so the working window and semantic recall don't double-count.
   *
   * sqlite-vec requires the KNN LIMIT/k constraint to apply DIRECTLY to the
   * vec0 table — if you put `LIMIT ?` on a JOIN result it errors with
   * "A LIMIT or 'k = ?' constraint is required on vec0 knn queries". So we
   * do the KNN in an inner subquery and join to episodes afterwards.
   */
  search(queryEmbedding: Float32Array, k: number, excludeIds: Set<number> = new Set()): Episode[] {
    if (k <= 0) return []
    // Overfetch a bit so we still get k after filtering excluded ids.
    const limit = k + excludeIds.size + 4
    const rows = this.db
      .prepare<[Buffer, number]>(
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
      .all(Buffer.from(queryEmbedding.buffer), limit) as Array<{
      id: number
      ts: string
      speaker: Speaker
      text: string
      sessionId: string | null
      distance: number
    }>
    return rows.filter((r) => !excludeIds.has(r.id)).slice(0, k)
  }

  /** Total row count — handy for the diagnostic "/recent" UI later. */
  count(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM episodes WHERE archived = 0')
      .get() as { c: number }
    return row.c
  }
}
