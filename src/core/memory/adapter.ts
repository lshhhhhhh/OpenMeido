/**
 * Storage abstraction for episodic memory. Concrete impls live in
 * platform-specific dirs (src/main/storage/sqlite-... for Electron, future
 * src/web/storage/indexeddb-... for PWA, etc.).
 *
 * All methods are async even though some impls (better-sqlite3) are
 * actually synchronous — this keeps the interface future-proof for the
 * IndexedDB / Capacitor SQLite cases where async is unavoidable.
 *
 * Every episode + fact is scoped to a `personaId`. The active persona is
 * read from config at every operation by the service layer; the adapter
 * itself is stateless w.r.t. which persona is current. Cross-persona
 * leakage (a maid query returning a 大小姐 episode) would be both a
 * privacy bug and a UX disaster, so the persona scope is required on
 * every method that touches per-persona data.
 */

import type {
  Episode,
  EpisodeImage,
  EpisodeKind,
  Fact,
  FactCategory,
  NewFact,
  SessionSummary,
  Speaker,
  ToolCallPart,
  ToolResultPart,
} from './types.js'

/** Affinity record stored in `persona_affinity`. */
export interface AffinityRecord {
  personaId: string
  score: number
  lastUpdated: string
  lastReason: string | null
  /** Highest tier-boundary score crossed so far (0 / 20 / 40 / 60 / 80).
   *  Drives "we just crossed Lv.X" milestone events — the engine only
   *  fires the milestone the FIRST time the score crosses upward into
   *  a new band. */
  lastMilestone: number
  /** ISO timestamp of the last weekly-review remark. null when no
   *  review has been delivered for this persona yet. */
  lastReviewAt: string | null
}

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
    personaId: string,
    speaker: Speaker,
    text: string,
    embedding: Float32Array,
    sessionId?: string | null,
    toolParts?: (ToolCallPart | ToolResultPart)[],
    images?: EpisodeImage[],
    kind?: EpisodeKind,
  ): Promise<number>

  /**
   * Most-recent N turns in chronological order (oldest first). If `sessionId`
   * is given, restrict to that session; otherwise return globally most-recent
   * for this persona.
   */
  recent(personaId: string, n: number, sessionId?: string | null): Promise<Episode[]>

  /** Per-session summaries for this persona, ordered by last-activity (newest first). */
  listSessions(personaId: string): Promise<SessionSummary[]>

  /**
   * Top-K cosine-nearest episodes to the query embedding, within this persona's
   * pool. `excludeIds` filters out episodes already returned via `recent()` to
   * avoid double-counting.
   */
  searchByEmbedding(
    personaId: string,
    queryEmbedding: Float32Array,
    k: number,
    excludeIds?: ReadonlySet<number>,
  ): Promise<Episode[]>

  /** Total un-archived row count for this persona — for diagnostics / "/recent" UIs. */
  count(personaId: string): Promise<number>

  /** Wipe every episode and its embedding for this persona. Returns the number of rows removed. */
  clear(personaId: string): Promise<number>

  /**
   * Wipe only the kind='lore' episodes (and their vec entries) for this
   * persona. Called before re-seeding lore so archetype switches don't
   * pile up dead fragments. Live chat is untouched.
   */
  clearLore(personaId: string): Promise<number>

  /** Delete just one session's episodes (scoped to this persona). Returns rows removed. */
  deleteSession(personaId: string, sessionId: string): Promise<number>

  // ---- L3 facts ----

  /**
   * Upsert a fact for `key` under this persona. Same key but a different
   * persona is a different fact — facts about the user can drift per-relationship
   * (e.g. she only knows your work nickname after you mentioned it to her).
   *
   * Special case: when `input.value === 'DELETE'`, the matching key's
   * supersession chain is wiped and the method returns `null`. This is
   * the negation pipeline — reflection emits a DELETE marker when the
   * user retracts a fact, and the adapter cleans up the chain in one
   * transaction so subsequent reads don't see the stale value.
   */
  upsertFact(
    personaId: string,
    input: NewFact,
    category?: FactCategory,
  ): Promise<Fact | null>

  /** All facts currently active under this persona, newest first.
   *  `category` defaults to 'personal'. */
  listActiveFacts(
    personaId: string,
    limit?: number,
    category?: FactCategory,
  ): Promise<Fact[]>

  /** Full history of facts for a key under this persona, oldest first. */
  listFactHistory(personaId: string, key: string): Promise<Fact[]>

  /** Wipe all facts for this persona. Returns rows removed. */
  clearFacts(personaId: string): Promise<number>

  /**
   * Delete every fact for a persona whose key starts with `prefix`. Used
   * by the lore seeder to wipe stale archetype anchors before writing
   * new ones — switching from "newcomer" to "childhood" must not leave
   * "newcomer"-only keys behind. Returns rows removed.
   */
  deleteFactsByKeyPrefix(personaId: string, prefix: string): Promise<number>

  /**
   * Manual override: delete one fact by id (hard delete row + any history
   * for the same key under this persona). Used by the Settings UI when
   * the user corrects something the model wrote ("我没养猫"). Returns
   * true if the row existed and was removed. */
  deleteFact(personaId: string, factId: number): Promise<boolean>

  // ---- Per-persona affinity (relationship state) ----

  /**
   * Read the affinity record for this persona. If no row exists yet,
   * returns a synthesized zero record — callers don't need to handle
   * "first-time" specially.
   */
  getAffinity(personaId: string): Promise<AffinityRecord>

  /**
   * Replace the affinity record for this persona. `score` is the resolved
   * post-guardrail value; callers handle clamping + capping above this
   * layer — the adapter just writes what it's told.
   */
  setAffinity(personaId: string, score: number, reason: string | null): Promise<void>

  /** Update the last-milestone-crossed band for this persona (0/20/40/60/80).
   *  Called by the affinity engine after a milestone event has been
   *  delivered to the renderer, so the same band doesn't re-fire. */
  setLastMilestone(personaId: string, milestone: number): Promise<void>

  /** Read persisted presence-accrual state for this persona. Returns
   *  zeros + null date when no row exists yet (first run). */
  getPresenceState(personaId: string): Promise<{
    date: string | null
    minutesAccrued: number
    bumpsToday: number
  }>

  /** Persist presence-accrual state. Called after every tick that
   *  changes the in-memory counters so a restart doesn't lose them. */
  setPresenceState(
    personaId: string,
    state: { date: string | null; minutesAccrued: number; bumpsToday: number },
  ): Promise<void>

  /** Read reflection turn counters for this persona. Persisted across
   *  process restarts so short-session users still accumulate toward
   *  the reflection threshold. */
  getReflectionCounters(personaId: string): Promise<{ personal: number; work: number }>

  /** Persist reflection turn counters. Called after every chat turn
   *  with the post-increment values. */
  setReflectionCounters(
    personaId: string,
    personalTurns: number,
    workTurns: number,
  ): Promise<void>

  /** Record that a weekly review fired right now for this persona.
   *  Engine uses this + a 7-day check to decide when next to fire. */
  touchLastReview(personaId: string): Promise<void>

  /** Permanently remove every trace of a persona (episodes, vec rows,
   *  facts, affinity). Returns total rows removed. */
  deletePersona(personaId: string): Promise<number>

  /**
   * Write a clean snapshot of the database to `destPath`. For sqlite
   * adapters this uses the native online backup API (VACUUM INTO or
   * better-sqlite3's .backup) so the destination is a single-file
   * standalone copy — no WAL state to worry about, openable from
   * another machine. Used by the "导出记忆备份" Settings button.
   */
  exportTo(destPath: string): Promise<void>

  /** Release resources. After close, all other methods reject. */
  close(): void
}
