/**
 * Pre-Zod schema migrations.
 *
 * These run against raw on-disk JSON before configSchema.parse() is called,
 * to translate shape changes between releases without losing user intent.
 * Each migration is a pure function over a Record<string, unknown> — no
 * Electron / Node side effects — so it can be unit-tested without booting
 * the runtime.
 */

import { z } from 'zod'

import { configSchema, type Config } from './config.js'

/**
 * v0.0.34 → v0.0.35: replace the proactive timing-knob grab-bag
 * (enabled + pollIntervalSec + timerSec + idleThresholdSec + minSilenceSec
 * + cooldownSec) with a single `mode` enum. Preserves the user's intent:
 *
 *   - `enabled: false`         → `mode: 'mute'`
 *   - `enabled` missing/true and no `mode` → leave defaults (Zod fills 'auto')
 *   - `mode` already set       → kept verbatim (even if `enabled: false` also
 *     present — explicit mode wins, the legacy flag was the only signal we
 *     had before)
 *
 * Strips the dead knobs from on-disk JSON so they don't linger as noise
 * for users who hand-inspect config.json.
 */
export function migrateProactiveLegacyKnobs(raw: Record<string, unknown>): void {
  const p = raw.proactive as Record<string, unknown> | undefined
  if (!p || typeof p !== 'object') return
  if (!('mode' in p) && 'enabled' in p && p.enabled === false) {
    p.mode = 'mute'
  }
  delete p.enabled
  delete p.pollIntervalSec
  delete p.timerSec
  delete p.idleThresholdSec
  delete p.minSilenceSec
  delete p.cooldownSec
}

/**
 * Model ids providers have retired → the id that replaces them. Keyed by
 * host so an id is only rewritten on the backend it belonged to. Applied
 * to `backend.model` and `backend.fastModel` on every boot (idempotent).
 *
 * Why: the wizard / Settings persist the then-current default into
 * `backend.model`, and a saved id always wins over the tier table in
 * lightweight-models.ts — so updating the table alone never moves an
 * existing user off a dead id.
 */
const RETIRED_MODELS: { host: (url: string) => boolean; map: (id: string) => string | null }[] = [
  {
    // Kimi: k2-preview line retired 2026-05-25; kimi-k2.5, kimi-latest and
    // all moonshot-v1-* retired by 2026-08-31.
    host: (u) => u.includes('moonshot.cn') || u.includes('moonshot.ai'),
    map: (id) =>
      /^(kimi-k2-(turbo-preview|0905-preview|0711-preview|thinking(-turbo)?)|kimi-k2\.5|kimi-latest|kimi-thinking-preview|moonshot-v1-.*)$/.test(
        id,
      )
        ? 'kimi-k2.6'
        : null,
  },
  {
    // Doubao: the 1.5 vision line we shipped is gone from Ark entirely, and
    // the Seed 2.0 260215 snapshots are marked 即将下线 (Ark model list,
    // 2026-09). Map to the Seed 2.1 snapshot of the same size class.
    host: (u) => u.includes('volces.com') || u.includes('ark.cn-beijing'),
    map: (id) => {
      if (/^doubao-1-5-vision-pro-32k/.test(id) || /^doubao-seed-2-0-(lite|mini)-260215$/.test(id))
        return 'doubao-seed-2-1-lite-260915'
      if (/^doubao-1-5-/.test(id) || id === 'doubao-seed-2-0-pro-260215')
        return 'doubao-seed-2-1-pro-260915'
      return null
    },
  },
  {
    // DeepSeek 2026-07 rename: flash is `deepseek-flash`; the old names
    // are still aliased server-side but slated to go.
    host: (u) => u.includes('deepseek.com'),
    map: (id) => {
      if (/^(deepseek-chat|deepseek-v4-flash(-vision-exp)?)$/.test(id)) return 'deepseek-flash'
      if (id === 'deepseek-reasoner') return 'deepseek-v4-pro'
      return null
    },
  },
]

export function migrateRetiredModels(raw: Record<string, unknown>): boolean {
  const b = raw.backend as Record<string, unknown> | undefined
  if (!b || typeof b !== 'object' || typeof b.baseUrl !== 'string') return false
  const rule = RETIRED_MODELS.find((r) => r.host(b.baseUrl as string))
  if (!rule) return false
  let changed = false
  for (const field of ['model', 'fastModel'] as const) {
    const id = b[field]
    if (typeof id !== 'string' || !id) continue
    const next = rule.map(id)
    if (next && next !== id) {
      b[field] = next
      changed = true
    }
  }
  return changed
}

/** All pre-parse migrations, in order. Mutates `raw`; true if anything changed. */
export function runConfigMigrations(raw: Record<string, unknown>): boolean {
  const before = JSON.stringify(raw)
  migrateProactiveLegacyKnobs(raw)
  migrateRetiredModels(raw)
  return JSON.stringify(raw) !== before
}

/**
 * Parse on-disk config without ever throwing. A strict `configSchema.parse`
 * at boot turned any single bad field (hand edit, an enum tightened in a
 * later release, a truncated write) into "app won't start, forever".
 * Instead: try the whole thing; on failure salvage section by section, and
 * inside a failing section field by field, defaulting only what's broken.
 * `dropped` lists the paths that fell back to defaults.
 */
export function parseConfigLenient(raw: unknown): { config: Config; dropped: string[] } {
  const full = configSchema.safeParse(raw)
  if (full.success) return { config: full.data, dropped: [] }

  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const out: Record<string, unknown> = {}
  const dropped: string[] = []
  for (const [key, sectionSchema] of Object.entries(configSchema.shape)) {
    const val = src[key]
    const whole = (sectionSchema as z.ZodTypeAny).safeParse(val)
    if (whole.success) {
      out[key] = whole.data
      continue
    }
    let inner: z.ZodTypeAny = sectionSchema as z.ZodTypeAny
    if (inner instanceof z.ZodDefault) inner = inner._def.innerType
    if (inner instanceof z.ZodObject && val && typeof val === 'object') {
      const salvaged: Record<string, unknown> = {}
      for (const [field, fieldSchema] of Object.entries(inner.shape as Record<string, z.ZodTypeAny>)) {
        const r = fieldSchema.safeParse((val as Record<string, unknown>)[field])
        if (r.success) salvaged[field] = r.data
        else dropped.push(`${key}.${field}`)
      }
      const again = (sectionSchema as z.ZodTypeAny).safeParse(salvaged)
      if (again.success) {
        out[key] = again.data
        continue
      }
    }
    dropped.push(key)
    // Omit → the section's own .default({}) fills it in below.
  }
  return { config: configSchema.parse(out), dropped }
}
