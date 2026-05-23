/**
 * Mute-toggle feedback line picker.
 *
 * Pure function. The data pool (per-persona × direction × tier-bucket
 * lines) is no longer baked into this file — it comes in via the
 * `lines` argument so callers can swap in user-edited overrides loaded
 * from %APPDATA%/openmeido/lines.json.
 *
 * See `src/shared/preset-lines-defaults.ts` for the bundled defaults
 * and `src/main/lines-host.ts` for how user overrides get merged.
 *
 * Why hardcoded over LLM-generated (still applies):
 *   1. **Latency is self-defeating** — clicking mute = wanting silence
 *      *now*; a 500-1500ms LLM round-trip is the opposite of that.
 *   2. **Failure mode is bad** — network hiccup means no feedback at
 *      all; user can't tell if mute fired.
 *   3. **Tokens for trivial flavor** — UI ack lines don't need
 *      conditional reasoning.
 *
 * Variety comes from a small pool (4-6 alternates per bucket) plus a
 * recently-used ring that excludes the last 3 picks.
 */

import type {
  MuteDirection,
  PresetLines,
  TierBucket,
} from './preset-lines-defaults.js'

export type { MuteDirection, TierBucket } from './preset-lines-defaults.js'

/**
 * Map the 5-tier affinity scale to a 3-bucket pool. Writing 5 versions
 * of every line was over-engineering — tier1+2 share "cold / formal",
 * tier4+5 share "warm / familiar", tier3 stands alone as the middle.
 */
export function tierBucketForScore(score: number): TierBucket {
  if (score < 40) return 'low'
  if (score < 60) return 'mid'
  return 'high'
}

/**
 * Pick a feedback line.
 *
 * @param lines Loaded preset lines (defaults merged with user overrides).
 * @param personaId One of the built-in ids (`maid` / `imouto` / `ojou`)
 *                  OR any custom string — falls through to the `default`
 *                  pool when no matching key exists.
 * @param direction `mute` or `unmute`.
 * @param score Affinity score 0-100; maps to a tier bucket internally.
 * @param recentlyUsed Caller-maintained ring of recent picks; the
 *                     function excludes lines in here unless the pool
 *                     was fully consumed.
 */
export function pickMuteFeedback(
  lines: PresetLines,
  personaId: string,
  direction: MuteDirection,
  score: number,
  recentlyUsed: string[] = [],
): string {
  // Defensive: if for some reason the lines structure is corrupt /
  // missing the default fallback, return a neutral placeholder rather
  // than throw. The caller would have hard time recovering mid-click.
  const pool = lines.mute[personaId] ?? lines.mute.default
  if (!pool) return '...'
  const bucket = tierBucketForScore(score)
  const candidates = pool[direction]?.[bucket] ?? []
  if (candidates.length === 0) return '...'

  const fresh = candidates.filter((line) => !recentlyUsed.includes(line))
  if (fresh.length > 0) {
    return fresh[Math.floor(Math.random() * fresh.length)]!
  }
  // Whole pool was in the ring. Pick anything except the very last one
  // to at least avoid the most-recent dup.
  const lastUsed = recentlyUsed[recentlyUsed.length - 1]
  const avoidLast = candidates.filter((line) => line !== lastUsed)
  const fallback = avoidLast.length > 0 ? avoidLast : candidates
  return fallback[Math.floor(Math.random() * fallback.length)]!
}
