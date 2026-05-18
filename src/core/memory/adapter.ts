/**
 * Storage abstraction for episodic memory. Concrete impls live in
 * platform-specific dirs (src/main/storage/sqlite-... for Electron, future
 * src/web/storage/indexeddb-... for PWA, etc.).
 *
 * All methods are async even though some impls (better-sqlite3) are
 * actually synchronous — this keeps the interface future-proof for the
 * IndexedDB / Capacitor SQLite cases where async is unavoidable.
 */

import type { Episode, SessionSummary, Speaker } from './types.js'

export interface MemoryAdapter {
  /** Persist a turn together with its embedding. Returns the new row id. */
  addEpisode(
    speaker: Speaker,
    text: string,
    embedding: Float32Array,
    sessionId?: string | null,
  ): Promise<number>

  /**
   * Most-recent N turns in chronological order (oldest first). If `sessionId`
   * is given, restrict to that session; otherwise return globally most-recent.
   */
  recent(n: number, sessionId?: string | null): Promise<Episode[]>

  /** Per-session summaries, ordered by last-activity (newest first). */
  listSessions(): Promise<SessionSummary[]>

  /**
   * Top-K cosine-nearest episodes to the query embedding. `excludeIds`
   * filters out episodes already returned via `recent()` to avoid
   * double-counting.
   */
  searchByEmbedding(
    queryEmbedding: Float32Array,
    k: number,
    excludeIds?: ReadonlySet<number>,
  ): Promise<Episode[]>

  /** Total un-archived row count — for diagnostics / "/recent" UIs. */
  count(): Promise<number>

  /** Wipe every episode and its embedding. Returns the number of rows removed. */
  clear(): Promise<number>

  /** Delete just one session's episodes. Returns rows removed. */
  deleteSession(sessionId: string): Promise<number>

  /** Release resources. After close, all other methods reject. */
  close(): void
}
