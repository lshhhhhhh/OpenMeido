/**
 * Pre-Zod schema migrations.
 *
 * These run against raw on-disk JSON before configSchema.parse() is called,
 * to translate shape changes between releases without losing user intent.
 * Each migration is a pure function over a Record<string, unknown> — no
 * Electron / Node side effects — so it can be unit-tested without booting
 * the runtime.
 */

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
