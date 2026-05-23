/**
 * Unit test for the preset lines host — file loading + merge logic.
 *
 * `lines-host.ts` uses `app.getPath('userData')` which requires
 * Electron. To run this test under plain Node we exercise the
 * load+merge math through a tiny helper that mirrors `initLines` but
 * takes the path as an argument. That way the file IO behavior is
 * tested directly without standing up an Electron window.
 *
 * Covers:
 *   - File missing → bundled defaults
 *   - Valid full override → user values used
 *   - Partial override (one persona, one bucket) → that bucket
 *     overridden, everything else from defaults
 *   - Corrupt JSON → fallback to defaults (no throw)
 *   - Empty arrays in override → fall back to defaults for that bucket
 *     (preserves the "delete to reset" UX)
 *
 * Run: npm run test:lines-host
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { register } = await import('tsx/esm/api')
register()

const { PRESET_LINES_DEFAULTS } = await import(
  '../src/shared/preset-lines-defaults.ts'
)
const { presetLinesSchema } = await import(
  '../src/shared/preset-lines-schema.ts'
)
const { pickMuteFeedback } = await import('../src/shared/mute-feedback.ts')

let passed = 0
let failed = 0

function check(label, cond, extra = '') {
  if (cond) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`)
    failed++
  }
}

// Port of lines-host's merge logic for direct testing without
// app.getPath. Mirrors the production merge in src/main/lines-host.ts.
function mergeOnDefaults(override) {
  const muteOverride = override?.mute ?? {}
  const muteDefaults = PRESET_LINES_DEFAULTS.mute
  const merged = { mute: { ...muteDefaults } }
  for (const personaId of Object.keys({ ...muteDefaults, ...muteOverride })) {
    const def = muteDefaults[personaId]
    const ov = muteOverride[personaId]
    if (!ov) {
      if (def) merged.mute[personaId] = def
      continue
    }
    const base = def ?? muteDefaults.default
    merged.mute[personaId] = {
      mute: {
        low: ov.mute?.low && ov.mute.low.length > 0 ? ov.mute.low : base.mute.low,
        mid: ov.mute?.mid && ov.mute.mid.length > 0 ? ov.mute.mid : base.mute.mid,
        high: ov.mute?.high && ov.mute.high.length > 0 ? ov.mute.high : base.mute.high,
      },
      unmute: {
        low: ov.unmute?.low && ov.unmute.low.length > 0 ? ov.unmute.low : base.unmute.low,
        mid: ov.unmute?.mid && ov.unmute.mid.length > 0 ? ov.unmute.mid : base.unmute.mid,
        high: ov.unmute?.high && ov.unmute.high.length > 0 ? ov.unmute.high : base.unmute.high,
      },
    }
  }
  return merged
}

const { readFileSync } = await import('node:fs')

// Read+parse+merge the same way initLines does. Returns the merged
// PresetLines or null on any failure (which production maps to
// "fallback to defaults").
function loadFile(path) {
  try {
    const raw = readFileSync(path, 'utf8')
    const json = JSON.parse(raw)
    const parsed = presetLinesSchema.parse(json)
    return mergeOnDefaults(parsed)
  } catch {
    return null
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'openmeido-lines-test-'))
const path = join(tmp, 'lines.json')

console.log('\n[1] file missing → defaults (no throw, no merge)')
{
  const result = loadFile(path) // file doesn't exist
  check('returns null on missing file', result === null)
  // Production maps null → use PRESET_LINES_DEFAULTS verbatim.
  const line = pickMuteFeedback(PRESET_LINES_DEFAULTS, 'maid', 'mute', 50)
  check('picker still works with defaults', typeof line === 'string' && line.length > 0)
}

console.log('\n[2] full valid override is taken')
{
  const override = {
    mute: {
      maid: {
        mute: {
          low: ['custom-low-1', 'custom-low-2'],
          mid: ['custom-mid-1'],
          high: ['custom-high-1'],
        },
        unmute: {
          low: ['u-low'],
          mid: ['u-mid'],
          high: ['u-high'],
        },
      },
    },
  }
  writeFileSync(path, JSON.stringify(override))
  const merged = loadFile(path)
  check('loaded successfully', merged !== null)
  // Pick from the overridden pool — must come from override, not defaults.
  const lines = new Set()
  for (let i = 0; i < 30; i++) {
    lines.add(pickMuteFeedback(merged, 'maid', 'mute', 0)) // low bucket
  }
  check(
    'maid × mute × low only returns override values',
    [...lines].every((l) => ['custom-low-1', 'custom-low-2'].includes(l)),
    `got ${JSON.stringify([...lines])}`,
  )
  // Personas NOT in override should still come from defaults.
  const imoutoLine = pickMuteFeedback(merged, 'imouto', 'mute', 50)
  check(
    'imouto (not in override) falls back to bundled defaults',
    PRESET_LINES_DEFAULTS.mute.imouto.mute.mid.includes(imoutoLine),
    `got ${imoutoLine}`,
  )
}

console.log('\n[3] partial override — single bucket replaced, rest defaulted')
{
  const override = {
    mute: {
      maid: {
        mute: {
          high: ['only-high-was-changed'],
          // low + mid omitted → should stay defaults
        },
      },
    },
  }
  writeFileSync(path, JSON.stringify(override))
  const merged = loadFile(path)
  check('merge succeeded', merged !== null)
  // high override visible
  const highLines = new Set()
  for (let i = 0; i < 10; i++) {
    highLines.add(pickMuteFeedback(merged, 'maid', 'mute', 90))
  }
  check('maid × mute × high uses override', highLines.has('only-high-was-changed') && highLines.size === 1)
  // low + mid still defaulted
  const lowLine = pickMuteFeedback(merged, 'maid', 'mute', 0)
  check(
    'maid × mute × low still from defaults',
    PRESET_LINES_DEFAULTS.mute.maid.mute.low.includes(lowLine),
    `got ${lowLine}`,
  )
  // unmute completely untouched → all defaults
  const unmuteLine = pickMuteFeedback(merged, 'maid', 'unmute', 50)
  check(
    'maid × unmute untouched (defaults)',
    PRESET_LINES_DEFAULTS.mute.maid.unmute.mid.includes(unmuteLine),
    `got ${unmuteLine}`,
  )
}

console.log('\n[4] corrupt JSON → null (production falls back to defaults)')
{
  writeFileSync(path, '{not valid json at all }}')
  const merged = loadFile(path)
  check('corrupt JSON returns null', merged === null)
}

console.log('\n[5] empty array in override → defaults for that bucket')
{
  // User clears the high bucket to "[]" expecting reset. We treat
  // empty array as "user wants defaults here", not "no lines at all"
  // (preserves the "delete the bucket to reset" mental model).
  const override = {
    mute: {
      maid: {
        mute: {
          high: [],
        },
      },
    },
  }
  writeFileSync(path, JSON.stringify(override))
  const merged = loadFile(path)
  check('merge succeeded', merged !== null)
  const lines = new Set()
  for (let i = 0; i < 15; i++) {
    lines.add(pickMuteFeedback(merged, 'maid', 'mute', 90))
  }
  // Should match the BUNDLED defaults for high, not produce '...'
  const defaultHighs = new Set(PRESET_LINES_DEFAULTS.mute.maid.mute.high)
  check(
    'empty override array falls back to defaults',
    [...lines].every((l) => defaultHighs.has(l)),
    `got ${JSON.stringify([...lines])}`,
  )
}

console.log('\n[6] schema strips unknown fields gracefully (no throw)')
{
  // User typo / future fields not in current schema. Zod by default
  // strips unknowns — we want it to silently drop them, not crash.
  const override = {
    mute: {
      maid: {
        mute: {
          low: ['ok'],
          // Note: arbitrary garbage key. Should be stripped, not crash.
          XXX_garbage_key: 'whatever',
        },
      },
    },
    unrelated_top_level: 'ignored',
  }
  writeFileSync(path, JSON.stringify(override))
  const merged = loadFile(path)
  check('garbage keys do not crash the loader', merged !== null)
  if (merged) {
    const line = pickMuteFeedback(merged, 'maid', 'mute', 0)
    check('legitimate field still works', line === 'ok')
  }
}

console.log('\n[7] custom persona id falls through to default pool')
{
  writeFileSync(path, JSON.stringify({ mute: {} })) // empty
  const merged = loadFile(path)
  const line = pickMuteFeedback(merged, 'custom-persona-uuid', 'mute', 50)
  check(
    'custom persona id uses "default" pool',
    PRESET_LINES_DEFAULTS.mute.default.mute.mid.includes(line),
    `got ${line}`,
  )
}

// Cleanup
rmSync(tmp, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
