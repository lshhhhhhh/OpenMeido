/**
 * Storage abstraction for episodic memory. Concrete impls live in
 * platform-specific dirs (src/main/storage/sqlite-... for Electron, future
 * src/web/storage/indexeddb-... for PWA, etc.).
 *
 * All methods are async even though some impls (better-sqlite3) are
 * actually synchronous — this keeps the interface future-proof for the
 * IndexedDB / Capacitor SQLite cases where async is unavoidable.
 */

import type { Episode, Fact, NewFact, SessionSummary, Speaker, ToolCallPart, ToolResultPart } from './types.js'

export interface MemoryAdapter {
  /**
   * Persist a turn together with its embedding. Returns the new row id.
   *
   * `toolParts` carries the structured tool data for agent-loop replay:
   *   - For `speaker: 'assistant'`, pass the ToolCallPart[] the model
   *     emitted alongside its text on this step.
   *   - For `speaker: 'tool'`, pass the ToolResultPart[] from the tools'
   *     execute() outputs that match the previous assistant turn's calls.
   *   - For `speaker: 'user'`, leave undefined.
   * Without this round-tripping, ids returned by listRecentEmails die at
   * the end of a turn and follow-up readEmail calls have nothing real to
   * call against.
   */
  addEpisode(
    speaker: Speaker,
    text: string,
    embedding: Float32Array,
    sessionId?: string | null,
    toolParts?: (ToolCallPart | ToolResultPart)[],
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

  // ---- L3 facts ----

  /**
   * Upsert a fact for `key`. If an active fact (supersededBy IS NULL) with the
   * same key + same value already exists, just bumps `confidence` (toward 1.0)
   * and `updatedAt`. If the value differs, a NEW row is inserted and the
   * previous active row gets `supersededBy = newId` — old facts stay queryable
   * for audit but only the active one is injected into the system prompt.
   */
  upsertFact(input: NewFact): Promise<Fact>

  /** All facts currently active (supersededBy IS NULL), newest first. */
  listActiveFacts(limit?: number): Promise<Fact[]>

  /** Full history of facts for a key, oldest first. Used by the Memory inspector. */
  listFactHistory(key: string): Promise<Fact[]>

  /** Wipe all facts. Returns rows removed. */
  clearFacts(): Promise<number>

  /** Release resources. After close, all other methods reject. */
  close(): void
}
