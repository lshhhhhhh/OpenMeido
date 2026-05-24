/**
 * Token-usage tracker. Records per-LLM-call token counts so Settings →
 * AI can show users "今日 8,432 tokens · 本周 54k · proactive 占 44%".
 *
 * Deliberately does NOT compute costs — provider pricing changes
 * frequently and every backend has its own model (per-token vs
 * per-character vs cached discounts vs CNY-subsidy tiers). Maintaining
 * a price table across all of those is a foot-gun that ages badly.
 * The "用量" UI links out to each provider's own usage dashboard for
 * the actual billing number.
 *
 * Lives in its own sqlite file (`usage.sqlite`) NOT bundled into
 * memory.sqlite — usage is about your account, not what the maid
 * remembers. reset:memory shouldn't wipe it; reset:all does (because
 * it nukes the whole userData dir).
 */

import { app, ipcMain } from 'electron'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

let db: Database.Database | null = null

interface UsageRow {
  ts: string
  provider: string
  model: string
  feature: string
  prompt_tokens: number
  completion_tokens: number
  cached_tokens: number
}

export function initUsage(): void {
  const userData = app.getPath('userData')
  mkdirSync(userData, { recursive: true })
  db = new Database(join(userData, 'usage.sqlite'))
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      feature TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cached_tokens INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_usage_ts ON token_usage(ts);
    CREATE INDEX IF NOT EXISTS idx_usage_feature ON token_usage(feature);
  `)
  console.log('[usage] init ok')

  ipcMain.handle('usage:summary', () => getSummary())
}

/**
 * Provider id from baseUrl. Mirrors the heuristic resolveBackendKey
 * uses for env-var fallback — keep these in sync if a new backend
 * lands. Coarse on purpose; we want one stable label per "vendor"
 * for the UI breakdown, not granular routing.
 */
export function providerFromUrl(baseUrl: string): string {
  if (baseUrl.includes('googleapis.com')) return 'gemini'
  if (baseUrl.includes('anthropic.com')) return 'anthropic'
  if (baseUrl.includes('openai.com')) return 'openai'
  if (baseUrl.includes('bigmodel.cn')) return 'glm'
  if (baseUrl.includes('deepseek.com')) return 'deepseek'
  if (baseUrl.includes('dashscope.aliyuncs.com')) return 'qwen'
  if (baseUrl.includes('volces.com') || baseUrl.includes('ark.cn-beijing')) return 'doubao'
  if (baseUrl.includes('moonshot.cn') || baseUrl.includes('moonshot.ai')) return 'kimi'
  return 'other'
}

/**
 * Provider's own usage dashboard URL. Empty when we don't know one —
 * UI hides the link in that case. Public links only (no logged-in
 * deep links) so they work without OAuth.
 */
export function usageUrlFor(provider: string): string {
  switch (provider) {
    case 'openai':
      return 'https://platform.openai.com/usage'
    case 'gemini':
      return 'https://aistudio.google.com/'
    case 'anthropic':
      return 'https://console.anthropic.com/settings/usage'
    case 'glm':
      return 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys'
    case 'deepseek':
      return 'https://platform.deepseek.com/usage'
    case 'qwen':
      return 'https://dashscope.console.aliyun.com/'
    case 'doubao':
      return 'https://console.volcengine.com/ark/'
    case 'kimi':
      return 'https://platform.moonshot.cn/console/info'
    default:
      return ''
  }
}

/**
 * Fire-and-forget. Never throws — usage logging failure should NEVER
 * break the LLM call path it's instrumenting. Returns nothing
 * because callers don't have a useful failure response anyway.
 */
export function recordUsage(args: {
  provider: string
  model: string
  feature: string
  promptTokens: number
  completionTokens: number
  cachedTokens?: number
}): void {
  if (!db) return
  // Reject zero-token records — every active provider returns SOME
  // count, so 0/0 usually means usage wasn't extractable (provider
  // dropped it from the response, AI SDK version mismatch, etc.).
  // Recording them would just inflate row counts without useful data.
  if (args.promptTokens === 0 && args.completionTokens === 0) return
  try {
    db.prepare(
      `INSERT INTO token_usage (ts, provider, model, feature, prompt_tokens, completion_tokens, cached_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      new Date().toISOString(),
      args.provider,
      args.model,
      args.feature,
      args.promptTokens,
      args.completionTokens,
      args.cachedTokens ?? 0,
    )
  } catch (err) {
    console.warn('[usage] record failed (non-fatal):', err)
  }
}

export interface UsageSummary {
  today: { prompt: number; completion: number; total: number }
  week: { prompt: number; completion: number; total: number }
  month: { prompt: number; completion: number; total: number }
  byFeatureToday: { feature: string; total: number }[]
  byFeatureWeek: { feature: string; total: number }[]
  /** Most-used provider this week — drives which provider's usage
   *  dashboard the "查看实际账单" link points at. */
  topProviderWeek: string | null
  topProviderUrl: string
}

function getSummary(): UsageSummary {
  if (!db) {
    return {
      today: { prompt: 0, completion: 0, total: 0 },
      week: { prompt: 0, completion: 0, total: 0 },
      month: { prompt: 0, completion: 0, total: 0 },
      byFeatureToday: [],
      byFeatureWeek: [],
      topProviderWeek: null,
      topProviderUrl: '',
    }
  }

  // Day boundaries computed in main's local time. SQLite's date()
  // function treats ISO timestamps in UTC by default, but we stored
  // them in UTC anyway via toISOString, so the comparison just works
  // — "today" means "since 00:00 local time", which we derive in JS.
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).toISOString()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()

  const totalsFor = (since: string): { prompt: number; completion: number; total: number } => {
    const row = db!
      .prepare(
        `SELECT
           COALESCE(SUM(prompt_tokens), 0) AS prompt,
           COALESCE(SUM(completion_tokens), 0) AS completion
         FROM token_usage WHERE ts >= ?`,
      )
      .get(since) as { prompt: number; completion: number }
    return {
      prompt: row.prompt,
      completion: row.completion,
      total: row.prompt + row.completion,
    }
  }

  const byFeature = (since: string): { feature: string; total: number }[] => {
    return db!
      .prepare(
        `SELECT
           feature,
           COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS total
         FROM token_usage WHERE ts >= ?
         GROUP BY feature
         ORDER BY total DESC
         LIMIT 6`,
      )
      .all(since) as { feature: string; total: number }[]
  }

  const topProvider = db
    .prepare(
      `SELECT provider, SUM(prompt_tokens + completion_tokens) AS total
       FROM token_usage WHERE ts >= ?
       GROUP BY provider
       ORDER BY total DESC
       LIMIT 1`,
    )
    .get(weekStart) as { provider: string; total: number } | undefined

  return {
    today: totalsFor(todayStart),
    week: totalsFor(weekStart),
    month: totalsFor(monthStart),
    byFeatureToday: byFeature(todayStart),
    byFeatureWeek: byFeature(weekStart),
    topProviderWeek: topProvider?.provider ?? null,
    topProviderUrl: topProvider ? usageUrlFor(topProvider.provider) : '',
  }
}

/** Exported for tests (used to verify aggregation math without IPC). */
export function _getSummaryForTest(): UsageSummary {
  return getSummary()
}

/** Exported for tests — overrides the DB to a fresh in-memory one. */
export function _resetForTest(): void {
  if (db) db.close()
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      feature TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cached_tokens INTEGER NOT NULL DEFAULT 0
    );
  `)
}

export type { UsageRow }
