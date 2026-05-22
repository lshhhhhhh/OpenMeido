/**
 * MemoryAdapter implementation using better-sqlite3 + sqlite-vec.
 *
 * Lives in src/main/ because better-sqlite3 is a Node-native module — it
 * only loads inside the Electron main process. Mobile / PWA hosts will
 * provide their own adapter (IndexedDB + JS cosine, or sql.js WASM with
 * the WASM build of sqlite-vec).
 *
 * Persona scope: episodes + facts both carry a `persona_id` column. Every
 * read/write filters on it so a 大小姐 query never returns a 女仆 episode.
 * The companion vec0 table doesn't have persona_id (vec0 doesn't support
 * metadata columns); cross-persona leakage is prevented by JOINing with
 * episodes and filtering there.
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
import { mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import type { AffinityRecord, MemoryAdapter } from '../../core/memory/adapter.js'
import type {
  Episode,
  EpisodeImage,
  Fact,
  NewFact,
  SessionSummary,
  Speaker,
} from '../../core/memory/types.js'

interface EpisodeRow {
  id: number
  ts: string
  speaker: Speaker
  text: string
  sessionId: string | null
  /** Raw JSON text from the tool_data column; null when absent. */
  toolDataRaw?: string | null
  /** Raw JSON text from the images_data column; null when absent. */
  imagesDataRaw?: string | null
}

function parseToolData(raw: string | null | undefined): Episode['toolParts'] {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined
    return parsed
  } catch {
    return undefined
  }
}

function parseImagesData(raw: string | null | undefined): EpisodeImage[] | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined
    return parsed as EpisodeImage[]
  } catch {
    return undefined
  }
}

function rowToEpisode(r: EpisodeRow): Episode {
  return {
    id: r.id,
    ts: r.ts,
    speaker: r.speaker,
    text: r.text,
    sessionId: r.sessionId,
    toolParts: parseToolData(r.toolDataRaw),
    images: parseImagesData(r.imagesDataRaw),
  }
}

function resolveSqliteVecExtension(): string {
  const ext = process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so'
  const os = process.platform === 'win32' ? 'windows' : process.platform
  const pkg = `sqlite-vec-${os}-${process.arch}`
  const file = `vec0.${ext}`
  const candidates = [
    join(process.cwd(), 'node_modules', pkg, file),
    process.resourcesPath
      ? join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', pkg, file)
      : '',
  ].filter(Boolean) as string[]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  throw new Error(
    `sqlite-vec extension not found. Looked in: ${candidates.join(' | ')}. ` +
      'Check that asarUnpack in electron-builder.yml includes node_modules/sqlite-vec-*/**.',
  )
}

/**
 * `migrateActivePersona` is the persona id we backfill existing episode +
 * fact rows with. The host (memory-host.ts) reads it from the current
 * config so users who were chatting with `imouto` don't suddenly find
 * their history under `maid`. First-time installs pass 'maid' and no
 * rows exist yet, so the value is moot.
 */
export function openSqliteMemory(
  dataDir: string,
  dim: number,
  migrateActivePersona: string,
): MemoryAdapter {
  mkdirSync(dataDir, { recursive: true })
  const db = new Database(join(dataDir, 'memory.sqlite'))

  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.loadExtension(resolveSqliteVecExtension())

  // Tables only — indexes go AFTER the column-migration step, so that
  // we never try to CREATE INDEX on a column that the upgrading user's
  // table doesn't have yet. (CREATE TABLE IF NOT EXISTS is a no-op when
  // the table exists with the old shape, so persona_id won't be on it
  // until the ALTER TABLE block runs below.)
  db.exec(`
    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      speaker TEXT NOT NULL CHECK (speaker IN ('user', 'assistant', 'tool')),
      text TEXT NOT NULL,
      session_id TEXT,
      tool_data TEXT,
      images_data TEXT,
      persona_id TEXT NOT NULL DEFAULT 'maid',
      archived INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_episodes_ts ON episodes(ts);
    CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id);

    CREATE TABLE IF NOT EXISTS facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      source_episode_ids TEXT NOT NULL DEFAULT '[]',
      superseded_by INTEGER REFERENCES facts(id),
      persona_id TEXT NOT NULL DEFAULT 'maid'
    );

    CREATE INDEX IF NOT EXISTS idx_facts_key_active
      ON facts(key) WHERE superseded_by IS NULL;

    CREATE TABLE IF NOT EXISTS persona_affinity (
      persona_id TEXT PRIMARY KEY,
      score INTEGER NOT NULL DEFAULT 0,
      last_updated TEXT NOT NULL,
      last_reason TEXT,
      -- Highest score band crossed so far (0/20/40/60/80). Used by the
      -- affinity engine to detect "she just crossed into a new tier"
      -- moments and fire a one-off milestone remark. We seed to the
      -- current band on startup so existing relationships don't trigger
      -- a flurry of "we became closer!" remarks for tiers already
      -- earned. Default 0 = no milestone yet.
      last_milestone INTEGER NOT NULL DEFAULT 0,
      -- ISO timestamp of the last weekly-review remark (the periodic
      -- "looking back at this week with you" feature). NULL means no
      -- review has fired yet for this persona.
      last_review_at TEXT
    );
  `)

  // ---- Backward-compat migrations ----
  // Pattern: PRAGMA table_info to detect missing columns, then ALTER TABLE
  // ADD COLUMN. ALTER would error if the column exists; the PRAGMA guard
  // makes the migration idempotent across launches.

  const episodeCols = db
    .prepare("PRAGMA table_info(episodes)")
    .all() as { name: string }[]
  if (!episodeCols.some((c) => c.name === 'tool_data')) {
    db.exec('ALTER TABLE episodes ADD COLUMN tool_data TEXT')
    console.log('[memory] migrated: added episodes.tool_data column')
  }
  if (!episodeCols.some((c) => c.name === 'images_data')) {
    db.exec('ALTER TABLE episodes ADD COLUMN images_data TEXT')
    console.log('[memory] migrated: added episodes.images_data column')
  }
  if (!episodeCols.some((c) => c.name === 'persona_id')) {
    // New install (which would have created the table with persona_id
    // already, falling into the CREATE branch) skips this. Existing users
    // get the column added with a default, then we backfill every
    // existing row with the persona they were actively using at upgrade
    // time. Without the backfill, default 'maid' would dump everyone's
    // history into maid even if they were chatting as imouto.
    db.exec("ALTER TABLE episodes ADD COLUMN persona_id TEXT NOT NULL DEFAULT 'maid'")
    db.prepare('UPDATE episodes SET persona_id = ?').run(migrateActivePersona)
    db.exec('CREATE INDEX IF NOT EXISTS idx_episodes_persona ON episodes(persona_id)')
    console.log(
      `[memory] migrated: added episodes.persona_id, backfilled to '${migrateActivePersona}'`,
    )
  }

  // Older DBs were created with `speaker IN ('user', 'assistant')` — that
  // CHECK constraint rejects the 'tool' speaker we now write.
  const tableSql = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='episodes'")
    .get() as { sql?: string } | undefined
  if (tableSql?.sql && !/CHECK\s*\(\s*speaker\s+IN\s*\([^)]*'tool'/i.test(tableSql.sql)) {
    console.log('[memory] migrating: rebuilding episodes table to widen speaker CHECK')
    const rebuild = db.transaction(() => {
      db.exec(`
        CREATE TABLE episodes_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          speaker TEXT NOT NULL CHECK (speaker IN ('user', 'assistant', 'tool')),
          text TEXT NOT NULL,
          session_id TEXT,
          tool_data TEXT,
          images_data TEXT,
          persona_id TEXT NOT NULL DEFAULT 'maid',
          archived INTEGER DEFAULT 0
        );
      `)
      // Use prepared statement for the data move — db.exec doesn't accept
      // parameter binding, and we want to backfill persona_id via the
      // app-controlled migrateActivePersona without string interpolation.
      db.prepare(
        `INSERT INTO episodes_new (id, ts, speaker, text, session_id, tool_data, images_data, persona_id, archived)
         SELECT id, ts, speaker, text, session_id, tool_data, images_data,
                COALESCE(persona_id, ?), archived
         FROM episodes`,
      ).run(migrateActivePersona)
      db.exec(`
        DROP TABLE episodes;
        ALTER TABLE episodes_new RENAME TO episodes;
        CREATE INDEX IF NOT EXISTS idx_episodes_ts ON episodes(ts);
        CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id);
        CREATE INDEX IF NOT EXISTS idx_episodes_persona ON episodes(persona_id);
      `)
    })
    rebuild()
  }

  const factCols = db.prepare("PRAGMA table_info(facts)").all() as { name: string }[]
  if (!factCols.some((c) => c.name === 'persona_id')) {
    db.exec("ALTER TABLE facts ADD COLUMN persona_id TEXT NOT NULL DEFAULT 'maid'")
    db.prepare('UPDATE facts SET persona_id = ?').run(migrateActivePersona)
    db.exec('CREATE INDEX IF NOT EXISTS idx_facts_persona ON facts(persona_id)')
    console.log(
      `[memory] migrated: added facts.persona_id, backfilled to '${migrateActivePersona}'`,
    )
  }
  // Dual-track memory (v0.0.29): facts get a category — 'personal' or
  // 'work'. Old rows are all relationship-line memory, so default 'personal'.
  if (!factCols.some((c) => c.name === 'category')) {
    db.exec(
      "ALTER TABLE facts ADD COLUMN category TEXT NOT NULL DEFAULT 'personal'",
    )
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_facts_category_active ON facts(persona_id, category) WHERE superseded_by IS NULL",
    )
    console.log('[memory] migrated: added facts.category (default personal)')
  }
  // Work fact expiry (v0.0.30): work-track context goes stale within
  // weeks (project status / ticket state). Without TTL, factsBlock
  // grows monotonically and old "等待 alice 验收" lingers in system
  // prompt forever. Personal facts stay NULL (no expiry). Existing
  // rows have NULL → treated as never-expiring on read.
  if (!factCols.some((c) => c.name === 'expires_at')) {
    db.exec('ALTER TABLE facts ADD COLUMN expires_at TEXT')
    console.log('[memory] migrated: added facts.expires_at')
  }
  // Shared scope (v0.0.30): facts about the user (name, pets, projects)
  // are the same person regardless of which persona is talking — they
  // should not be re-learned every time the user switches character.
  // 'shared' means cross-persona-visible; 'persona' means
  // persona-specific (e.g. an in-joke nickname). New writes default to
  // 'shared'; existing rows stay 'persona' so the upgrade doesn't
  // surprise users by suddenly merging knowledge across characters
  // they may have intentionally kept separate. New facts coming in
  // after this migration will be shared (per scopeFor() rules).
  if (!factCols.some((c) => c.name === 'scope')) {
    db.exec("ALTER TABLE facts ADD COLUMN scope TEXT NOT NULL DEFAULT 'persona'")
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_facts_scope_active ON facts(scope, category) WHERE superseded_by IS NULL",
    )
    console.log("[memory] migrated: added facts.scope (existing rows kept as 'persona')")
  }

  // persona_affinity new columns for milestone + weekly review (v0.0.26).
  // Seed last_milestone to the band the user is currently at — so we
  // don't immediately fire a "we just crossed Lv.2!" event for users
  // already past that. Reviews start as never-fired (NULL).
  const affCols = db
    .prepare('PRAGMA table_info(persona_affinity)')
    .all() as { name: string }[]
  if (!affCols.some((c) => c.name === 'last_milestone')) {
    db.exec('ALTER TABLE persona_affinity ADD COLUMN last_milestone INTEGER NOT NULL DEFAULT 0')
    // Seed each existing row's last_milestone to the highest band their
    // current score has already crossed. floor(score / 20) * 20 gives
    // 0 / 20 / 40 / 60 / 80 — the band lower bound.
    db.exec(
      "UPDATE persona_affinity SET last_milestone = CAST(score / 20 AS INTEGER) * 20",
    )
    console.log('[memory] migrated: added persona_affinity.last_milestone')
  }
  if (!affCols.some((c) => c.name === 'last_review_at')) {
    db.exec('ALTER TABLE persona_affinity ADD COLUMN last_review_at TEXT')
    console.log('[memory] migrated: added persona_affinity.last_review_at')
  }
  // Presence accrual state (v0.0.28). Without this, every app restart
  // wipes minutesSinceLastBump and a user who chats in short sessions
  // never reaches the 60-minute threshold for a +1.
  if (!affCols.some((c) => c.name === 'presence_date')) {
    db.exec('ALTER TABLE persona_affinity ADD COLUMN presence_date TEXT')
    console.log('[memory] migrated: added persona_affinity.presence_date')
  }
  if (!affCols.some((c) => c.name === 'presence_minutes_accrued')) {
    db.exec(
      'ALTER TABLE persona_affinity ADD COLUMN presence_minutes_accrued REAL NOT NULL DEFAULT 0',
    )
    console.log('[memory] migrated: added persona_affinity.presence_minutes_accrued')
  }
  if (!affCols.some((c) => c.name === 'presence_bumps_today')) {
    db.exec(
      'ALTER TABLE persona_affinity ADD COLUMN presence_bumps_today INTEGER NOT NULL DEFAULT 0',
    )
    console.log('[memory] migrated: added persona_affinity.presence_bumps_today')
  }
  // Reflection counter persistence (v0.0.30). Module-level counters in
  // chat.ts reset on every process restart, so users in short-session
  // patterns (open app → ask one question → close) never reach the
  // 5-turn threshold and reflection never fires. Persist per-persona
  // so progress survives restarts.
  if (!affCols.some((c) => c.name === 'personal_turns_since_reflection')) {
    db.exec(
      'ALTER TABLE persona_affinity ADD COLUMN personal_turns_since_reflection INTEGER NOT NULL DEFAULT 0',
    )
    console.log('[memory] migrated: added persona_affinity.personal_turns_since_reflection')
  }
  if (!affCols.some((c) => c.name === 'work_turns_since_reflection')) {
    db.exec(
      'ALTER TABLE persona_affinity ADD COLUMN work_turns_since_reflection INTEGER NOT NULL DEFAULT 0',
    )
    console.log('[memory] migrated: added persona_affinity.work_turns_since_reflection')
  }

  // ---- Vec0 setup (unchanged from pre-persona schema; episode JOIN
  // applies the persona filter at query time) ----
  const existing = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'episodes_vec'")
    .get() as { sql?: string } | undefined
  if (existing?.sql) {
    const m = existing.sql.match(/FLOAT\[(\d+)\]/i)
    const existingDim = m && m[1] ? Number(m[1]) : NaN
    if (existingDim && existingDim !== dim) {
      console.warn(
        `[memory] embedding dim changed (${existingDim} -> ${dim}); dropping vec0 table.`,
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

  // ---- Prepared statements ----
  const insertEpisode = db.prepare<
    [string, string, Speaker, string, string | null, string | null, string | null]
  >(
    'INSERT INTO episodes (persona_id, ts, speaker, text, session_id, tool_data, images_data) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  const insertVec = db.prepare<[bigint, Buffer]>(
    'INSERT INTO episodes_vec (episode_id, embedding) VALUES (?, ?)',
  )
  const selectRecent = db.prepare<[string, number]>(
    `SELECT id, ts, speaker, text, session_id AS sessionId,
            tool_data AS toolDataRaw, images_data AS imagesDataRaw
     FROM episodes
     WHERE archived = 0 AND persona_id = ?
     ORDER BY id DESC
     LIMIT ?`,
  )
  const selectRecentInSession = db.prepare<[string, string, number]>(
    `SELECT id, ts, speaker, text, session_id AS sessionId,
            tool_data AS toolDataRaw, images_data AS imagesDataRaw
     FROM episodes
     WHERE archived = 0 AND persona_id = ? AND COALESCE(session_id, 'legacy') = ?
     ORDER BY id DESC
     LIMIT ?`,
  )
  const selectSessions = db.prepare<[string]>(
    `SELECT
        COALESCE(session_id, 'legacy') AS id,
        COUNT(*) AS count,
        MIN(ts) AS startTs,
        MAX(ts) AS lastTs,
        COALESCE(
          (SELECT text FROM episodes e2
           WHERE e2.persona_id = e.persona_id
             AND COALESCE(e2.session_id, 'legacy') = COALESCE(e.session_id, 'legacy')
             AND e2.speaker = 'user'
           ORDER BY e2.id ASC LIMIT 1),
          ''
        ) AS preview
     FROM episodes e
     WHERE archived = 0 AND persona_id = ?
     GROUP BY COALESCE(session_id, 'legacy')
     ORDER BY MAX(ts) DESC`,
  )
  const selectByKnn = db.prepare<[Buffer, number, string]>(
    `SELECT e.id, e.ts, e.speaker, e.text, e.session_id AS sessionId,
            e.tool_data AS toolDataRaw, e.images_data AS imagesDataRaw,
            vc.distance
     FROM (
       SELECT episode_id, distance
       FROM episodes_vec
       WHERE embedding MATCH ?
       ORDER BY distance
       LIMIT ?
     ) vc
     JOIN episodes e ON e.id = vc.episode_id
     WHERE e.archived = 0 AND e.persona_id = ?
     ORDER BY vc.distance`,
  )
  const countEpisodes = db.prepare<[string]>(
    'SELECT COUNT(*) AS c FROM episodes WHERE archived = 0 AND persona_id = ?',
  )

  // ---- L3 facts prepared statements ----
  // Same-key supersession is scoped per CATEGORY: a 'work' fact for key
  // X never supersedes a 'personal' fact for the same key. Letting them
  // collide would let work memory eat personal memory whenever they
  // share a key (rare but conceivable, e.g. `user.role`).
  //
  // Lookup semantics: `selectActiveFacts` returns BOTH (a) facts scoped
  // to the active persona AND (b) facts scoped 'shared' (which apply
  // to the user regardless of persona). `selectActiveByKey` searches
  // both buckets too — supersession of a shared fact happens from any
  // persona that's currently talking with the user.
  //
  // Work fact TTL: rows whose `expires_at` is in the past are filtered
  // out of all read paths. Bumping confidence on an existing fact also
  // extends the expiry (see upsertFact below).
  const factCommonCols = `id, key, value, confidence, created_at AS createdAt, updated_at AS updatedAt,
            source_episode_ids AS sourceEpisodeIdsJson, superseded_by AS supersededBy,
            category, scope, expires_at AS expiresAt`
  const selectActiveByKey = db.prepare<[string, string, string]>(
    `SELECT ${factCommonCols}
     FROM facts
     WHERE (persona_id = ? OR scope = 'shared')
       AND key = ? AND category = ? AND superseded_by IS NULL
     ORDER BY scope = 'shared' DESC, id DESC
     LIMIT 1`,
  )
  const insertFact = db.prepare<
    [string, string, string, number, string, string, string, string, string, string | null]
  >(
    `INSERT INTO facts (persona_id, key, value, confidence, created_at, updated_at, source_episode_ids, category, scope, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const bumpFact = db.prepare<[number, string, string | null, number]>(
    `UPDATE facts SET confidence = ?, updated_at = ?, expires_at = ? WHERE id = ?`,
  )
  const supersedeFact = db.prepare<[number, number]>(
    `UPDATE facts SET superseded_by = ? WHERE id = ?`,
  )
  const selectFactById = db.prepare<[number]>(
    `SELECT ${factCommonCols} FROM facts WHERE id = ?`,
  )
  const selectActiveFacts = db.prepare<[string, string, number]>(
    `SELECT ${factCommonCols}
     FROM facts
     WHERE (persona_id = ? OR scope = 'shared')
       AND category = ?
       AND superseded_by IS NULL
       AND (expires_at IS NULL OR expires_at > datetime('now'))
     ORDER BY updated_at DESC
     LIMIT ?`,
  )
  const selectFactHistory = db.prepare<[string, string]>(
    `SELECT ${factCommonCols}
     FROM facts
     WHERE (persona_id = ? OR scope = 'shared') AND key = ?
     ORDER BY id ASC`,
  )

  // ---- Reflection counter prepared statements ----
  const selectReflectionCounters = db.prepare<[string]>(
    `SELECT personal_turns_since_reflection AS personalTurns,
            work_turns_since_reflection AS workTurns
     FROM persona_affinity WHERE persona_id = ?`,
  )
  const upsertReflectionCounters = db.prepare<[string, number, number]>(
    `INSERT INTO persona_affinity
       (persona_id, score, last_updated, last_reason,
        personal_turns_since_reflection, work_turns_since_reflection)
     VALUES (?, 0, datetime('now'), NULL, ?, ?)
     ON CONFLICT(persona_id) DO UPDATE SET
       personal_turns_since_reflection = excluded.personal_turns_since_reflection,
       work_turns_since_reflection = excluded.work_turns_since_reflection`,
  )

  // ---- Affinity prepared statements ----
  const selectAffinity = db.prepare<[string]>(
    `SELECT persona_id AS personaId, score,
            last_updated AS lastUpdated, last_reason AS lastReason,
            last_milestone AS lastMilestone, last_review_at AS lastReviewAt
     FROM persona_affinity WHERE persona_id = ?`,
  )
  const upsertAffinity = db.prepare<[string, number, string, string | null]>(
    `INSERT INTO persona_affinity (persona_id, score, last_updated, last_reason)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(persona_id) DO UPDATE SET
       score = excluded.score,
       last_updated = excluded.last_updated,
       last_reason = excluded.last_reason`,
  )
  const updateLastMilestone = db.prepare<[string, number]>(
    `INSERT INTO persona_affinity (persona_id, score, last_updated, last_reason, last_milestone)
     VALUES (?, 0, datetime('now'), NULL, ?)
     ON CONFLICT(persona_id) DO UPDATE SET last_milestone = excluded.last_milestone`,
  )
  const selectPresence = db.prepare<[string]>(
    `SELECT presence_date AS date,
            presence_minutes_accrued AS minutesAccrued,
            presence_bumps_today AS bumpsToday
     FROM persona_affinity WHERE persona_id = ?`,
  )
  const upsertPresence = db.prepare<[string, string | null, number, number]>(
    `INSERT INTO persona_affinity
       (persona_id, score, last_updated, last_reason,
        presence_date, presence_minutes_accrued, presence_bumps_today)
     VALUES (?, 0, datetime('now'), NULL, ?, ?, ?)
     ON CONFLICT(persona_id) DO UPDATE SET
       presence_date = excluded.presence_date,
       presence_minutes_accrued = excluded.presence_minutes_accrued,
       presence_bumps_today = excluded.presence_bumps_today`,
  )
  const updateLastReviewAt = db.prepare<[string, string]>(
    `INSERT INTO persona_affinity (persona_id, score, last_updated, last_reason, last_review_at)
     VALUES (?, 0, datetime('now'), NULL, ?)
     ON CONFLICT(persona_id) DO UPDATE SET last_review_at = excluded.last_review_at`,
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
    category: string
    scope: string
    expiresAt: string | null
  }
  const rowToFact = (r: FactRow): Fact => ({
    id: r.id,
    key: r.key,
    value: r.value,
    confidence: r.confidence,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    category: r.category === 'work' ? 'work' : 'personal',
    scope: r.scope === 'shared' ? 'shared' : 'persona',
    expiresAt: r.expiresAt ?? null,
    sourceEpisodeIds: safeParseIntArray(r.sourceEpisodeIdsJson),
    supersededBy: r.supersededBy,
  })

  const addTxn = db.transaction(
    (
      personaId: string,
      speaker: Speaker,
      text: string,
      sessionId: string | null,
      embedding: Float32Array,
      toolData: string | null,
      imagesData: string | null,
    ): number => {
      const ts = new Date().toISOString()
      const row = insertEpisode.run(personaId, ts, speaker, text, sessionId, toolData, imagesData)
      const episodeId = Number(row.lastInsertRowid)
      if (embedding.length > 0) {
        insertVec.run(BigInt(episodeId), Buffer.from(embedding.buffer))
      }
      return episodeId
    },
  )

  let closed = false
  const ensureOpen = (): void => {
    if (closed) throw new Error('sqlite-memory-adapter: closed')
  }

  return {
    async addEpisode(personaId, speaker, text, embedding, sessionId = null, toolParts, images) {
      ensureOpen()
      const toolData = toolParts && toolParts.length > 0 ? JSON.stringify(toolParts) : null
      const imagesData = images && images.length > 0 ? JSON.stringify(images) : null
      return addTxn(personaId, speaker, text, sessionId, embedding, toolData, imagesData)
    },

    async recent(personaId, n, sessionId) {
      ensureOpen()
      if (n <= 0) return []
      const rows = sessionId
        ? (selectRecentInSession.all(personaId, sessionId, n) as EpisodeRow[])
        : (selectRecent.all(personaId, n) as EpisodeRow[])
      return rows.reverse().map(rowToEpisode)
    },

    async listSessions(personaId) {
      ensureOpen()
      return selectSessions.all(personaId) as SessionSummary[]
    },

    async searchByEmbedding(personaId, queryEmbedding, k, excludeIds = new Set()) {
      ensureOpen()
      if (k <= 0) return []
      // Overfetch — KNN doesn't pre-filter by persona, so a 大小姐 with 10
      // recent episodes might have several of its top-K nearest in 女仆's
      // pool; we filter those out post-JOIN and need extra headroom.
      const limit = k + excludeIds.size + 16
      const rows = selectByKnn.all(
        Buffer.from(queryEmbedding.buffer),
        limit,
        personaId,
      ) as (EpisodeRow & { distance: number })[]
      const filtered: Episode[] = []
      for (const r of rows) {
        if (excludeIds.has(r.id)) continue
        filtered.push(rowToEpisode(r))
        if (filtered.length >= k) break
      }
      return filtered
    },

    async count(personaId) {
      ensureOpen()
      const row = countEpisodes.get(personaId) as { c: number }
      return row.c
    },

    async clear(personaId) {
      ensureOpen()
      const wipe = db.transaction(() => {
        const ids = db
          .prepare<[string]>('SELECT id FROM episodes WHERE persona_id = ?')
          .all(personaId) as { id: number }[]
        if (ids.length === 0) return 0
        const delVec = db.prepare('DELETE FROM episodes_vec WHERE episode_id = ?')
        for (const { id } of ids) delVec.run(BigInt(id))
        const result = db.prepare<[string]>('DELETE FROM episodes WHERE persona_id = ?').run(personaId)
        return Number(result.changes)
      })
      return wipe()
    },

    async deleteSession(personaId: string, sessionId: string) {
      ensureOpen()
      const wipe = db.transaction(() => {
        const ids = db
          .prepare<[string, string]>(
            "SELECT id FROM episodes WHERE persona_id = ? AND COALESCE(session_id, 'legacy') = ?",
          )
          .all(personaId, sessionId) as { id: number }[]
        if (ids.length === 0) return 0
        const delVec = db.prepare('DELETE FROM episodes_vec WHERE episode_id = ?')
        for (const { id } of ids) delVec.run(BigInt(id))
        const result = db
          .prepare<[string, string]>(
            "DELETE FROM episodes WHERE persona_id = ? AND COALESCE(session_id, 'legacy') = ?",
          )
          .run(personaId, sessionId)
        return Number(result.changes)
      })
      return wipe()
    },

    async upsertFact(personaId, input: NewFact, category = 'personal') {
      ensureOpen()
      const now = new Date().toISOString()
      const sourceIds = JSON.stringify(input.sourceEpisodeIds ?? [])
      const inputConf = input.confidence ?? 1.0
      // Scope inference: by default everything we extract goes to
      // 'shared' so 大小姐 doesn't have to relearn that the user has a
      // cat after 女仆 already knew it. The exception is keys that
      // represent persona-specific context (in-joke nicknames, the
      // way THIS character refers to the user). Add prefixes here as
      // they come up.
      const PERSONA_SCOPED_PREFIXES = ['user.nicknames.', 'user.preferred_address']
      const scope: 'shared' | 'persona' = PERSONA_SCOPED_PREFIXES.some((p) =>
        input.key.startsWith(p),
      )
        ? 'persona'
        : 'shared'
      // Work-fact TTL: 14 days from write. Bumping confidence on the
      // same key+value also extends the expiry — so as long as the
      // model keeps confirming a fact in reflection, it stays alive.
      const WORK_TTL_MS = 14 * 24 * 60 * 60 * 1000
      const expiresAt =
        category === 'work'
          ? new Date(Date.now() + WORK_TTL_MS).toISOString()
          : null
      const existing = selectActiveByKey.get(personaId, input.key, category) as
        | FactRow
        | undefined
      if (input.value === 'DELETE') {
        const txn = db.transaction((): Fact => {
          db.prepare(
            `DELETE FROM facts WHERE key = ? AND category = ? AND (persona_id = ? OR scope = 'shared')`
          ).run(input.key, category, personaId)
          return {
            id: existing ? -existing.id : -1,
            key: input.key,
            value: 'DELETE',
            confidence: 1.0,
            createdAt: now,
            updatedAt: now,
            category: category === 'work' ? 'work' : 'personal',
            scope: scope,
            expiresAt: null,
            sourceEpisodeIds: input.sourceEpisodeIds ?? [],
            supersededBy: null,
          }
        })
        return txn()
      }
      const txn = db.transaction((): Fact => {
        if (existing && existing.value === input.value) {
          const newConf = Math.min(1.0, (existing.confidence + inputConf) / 2 + 0.05)
          // Extend expiry on confirmation (only relevant for work facts;
          // personal facts pass null through and stay non-expiring).
          const extendedExpiry =
            existing.expiresAt && category === 'work' ? expiresAt : existing.expiresAt
          bumpFact.run(newConf, now, extendedExpiry, existing.id)
          return rowToFact({
            ...existing,
            confidence: newConf,
            updatedAt: now,
            expiresAt: extendedExpiry,
          })
        }
        const ins = insertFact.run(
          personaId,
          input.key,
          input.value,
          inputConf,
          now,
          now,
          sourceIds,
          category,
          scope,
          expiresAt,
        )
        const newId = Number(ins.lastInsertRowid)
        if (existing) supersedeFact.run(newId, existing.id)
        return rowToFact(selectFactById.get(newId) as FactRow)
      })
      return txn()
    },

    async listActiveFacts(personaId, limit = 200, category = 'personal') {
      ensureOpen()
      return (selectActiveFacts.all(personaId, category, limit) as FactRow[]).map(rowToFact)
    },

    async listFactHistory(personaId, key: string) {
      ensureOpen()
      return (selectFactHistory.all(personaId, key) as FactRow[]).map(rowToFact)
    },

    async getReflectionCounters(personaId) {
      ensureOpen()
      const row = selectReflectionCounters.get(personaId) as
        | { personalTurns: number; workTurns: number }
        | undefined
      return {
        personal: row?.personalTurns ?? 0,
        work: row?.workTurns ?? 0,
      }
    },

    async setReflectionCounters(personaId, personalTurns, workTurns) {
      ensureOpen()
      upsertReflectionCounters.run(personaId, personalTurns, workTurns)
    },

    async clearFacts(personaId) {
      ensureOpen()
      // Wipe persona-scoped facts under this persona AND every shared
      // fact (shared facts apply across personas, so clearing makes no
      // sense to scope to one). Match the user's mental model: "清空
      // 记忆" means "she forgets everything about me", not "she forgets
      // only what she-as-this-character extracted".
      const result = db
        .prepare<[string]>(
          "DELETE FROM facts WHERE persona_id = ? OR scope = 'shared'",
        )
        .run(personaId)
      return Number(result.changes)
    },

    async deleteFact(personaId, factId) {
      ensureOpen()
      // Find the key first so we can also wipe the full supersession
      // chain. Otherwise an orphaned earlier version of the same fact
      // (still marked superseded by the row we're deleting) gets left
      // behind as dead weight in the table.
      const row = selectFactById.get(factId) as FactRow | undefined
      if (!row) return false
      // Guard: the row must be visible from this persona's perspective —
      // either persona-scoped to this persona, or shared (in which case
      // any persona can delete; the user is deleting their own fact).
      const visible = db
        .prepare<[number, string]>(
          "SELECT 1 FROM facts WHERE id = ? AND (persona_id = ? OR scope = 'shared')",
        )
        .get(factId, personaId)
      if (!visible) return false
      // Wipe the whole supersession chain for that key. Match the
      // visibility rule above (don't accidentally delete some OTHER
      // persona's persona-scoped row that happens to share a key).
      const result = db
        .prepare<[string, string]>(
          "DELETE FROM facts WHERE key = ? AND (persona_id = ? OR scope = 'shared')",
        )
        .run(row.key, personaId)
      return Number(result.changes) > 0
    },

    async getAffinity(personaId) {
      ensureOpen()
      const row = selectAffinity.get(personaId) as AffinityRecord | undefined
      if (row) return row
      return {
        personaId,
        score: 0,
        lastUpdated: new Date(0).toISOString(),
        lastReason: null,
        lastMilestone: 0,
        lastReviewAt: null,
      }
    },

    async setAffinity(personaId, score, reason) {
      ensureOpen()
      upsertAffinity.run(personaId, score, new Date().toISOString(), reason ?? null)
    },

    async setLastMilestone(personaId, milestone) {
      ensureOpen()
      updateLastMilestone.run(personaId, milestone)
    },

    async touchLastReview(personaId) {
      ensureOpen()
      updateLastReviewAt.run(personaId, new Date().toISOString())
    },

    async getPresenceState(personaId) {
      ensureOpen()
      const row = selectPresence.get(personaId) as
        | { date: string | null; minutesAccrued: number; bumpsToday: number }
        | undefined
      return {
        date: row?.date ?? null,
        minutesAccrued: row?.minutesAccrued ?? 0,
        bumpsToday: row?.bumpsToday ?? 0,
      }
    },

    async setPresenceState(personaId, state) {
      ensureOpen()
      upsertPresence.run(
        personaId,
        state.date,
        state.minutesAccrued,
        state.bumpsToday,
      )
    },

    async deletePersona(personaId) {
      ensureOpen()
      const txn = db.transaction(() => {
        // Episodes (cascades to vec rows) — always persona-specific.
        const ids = db
          .prepare<[string]>('SELECT id FROM episodes WHERE persona_id = ?')
          .all(personaId) as { id: number }[]
        const delVec = db.prepare('DELETE FROM episodes_vec WHERE episode_id = ?')
        for (const { id } of ids) delVec.run(BigInt(id))
        const epDel = db.prepare<[string]>('DELETE FROM episodes WHERE persona_id = ?').run(personaId)
        // Facts: drop only the persona-scoped rows owned by THIS
        // persona. Shared facts describe the user themselves and must
        // survive — deleting 大小姐 shouldn't make the maid forget the
        // user's cat. (Behavioral change from v0.0.29; before scope
        // existed, every fact was persona-scoped.)
        const factDel = db
          .prepare<[string]>(
            "DELETE FROM facts WHERE persona_id = ? AND scope = 'persona'",
          )
          .run(personaId)
        const affDel = db
          .prepare<[string]>('DELETE FROM persona_affinity WHERE persona_id = ?')
          .run(personaId)
        return Number(epDel.changes) + Number(factDel.changes) + Number(affDel.changes)
      })
      return txn()
    },

    close() {
      if (closed) return
      closed = true
      db.close()
    },
  }
}

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
