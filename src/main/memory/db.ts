/**
 * SQLite + sqlite-vec bootstrap for OpenMeido's persistent memory.
 *
 * better-sqlite3 is synchronous (no async overhead) and runs as a native
 * module in the main process. sqlite-vec is a loadable extension that adds
 * vec0 virtual tables for cosine-similarity search.
 *
 * Storage: <userData>/openmeido/memory.sqlite
 */

import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

export interface DbHandle {
  db: Database.Database
  /** Embedding dim the vec table was created with — must match the embedder. */
  dim: number
}

/**
 * Open / create the memory database. The vec table's embedding dimension is
 * locked the first time the table is created; passing a different `dim` on
 * a later call will leave the existing table untouched (caller should detect
 * mismatch and migrate).
 *
 * `dataDir` is injected (not derived from `electron.app.getPath`) so this
 * function is usable from plain Node smoke tests as well as the running app.
 */
export function openDb(dim: number, dataDir: string): DbHandle {
  mkdirSync(dataDir, { recursive: true })
  const dbPath = join(dataDir, 'memory.sqlite')

  const db = new Database(dbPath)
  // WAL mode + sane sync — good defaults for an interactive desktop app.
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
  `)

  // vec0 requires the dimension at CREATE TIME. If the table already exists
  // we leave it — caller can introspect via db.prepare('SELECT * FROM
  // episodes_vec LIMIT 0').columns() if dim verification is needed later.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS episodes_vec USING vec0(
      episode_id INTEGER PRIMARY KEY,
      embedding FLOAT[${dim}]
    );
  `)

  return { db, dim }
}
