/**
 * Unit test for the v0.0.34 → v0.0.35 proactive config migration.
 *
 * The migration is otherwise only exercised when an old config.json
 * lands in front of the new schema at boot — by which point a bug
 * silently strips the wrong field and the user's "I disabled it"
 * preference is lost. This test pins the contract.
 *
 * Run: npm run test:proactive-migration
 */

const { register } = await import('tsx/esm/api')
register()

const { migrateProactiveLegacyKnobs } = await import(
  '../src/shared/config-migrations.ts'
)

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

const DEAD_KNOBS = [
  'enabled',
  'pollIntervalSec',
  'timerSec',
  'idleThresholdSec',
  'minSilenceSec',
  'cooldownSec',
]

console.log('\n[1] legacy enabled:false → mode:mute, dead knobs stripped')
{
  const raw = {
    proactive: {
      enabled: false,
      pollIntervalSec: 5,
      timerSec: 900,
      idleThresholdSec: 600,
      minSilenceSec: 30,
      cooldownSec: 600,
      includeScreen: true, // preserved
      excludedScreenIds: ['screen:0:0'], // preserved
    },
  }
  migrateProactiveLegacyKnobs(raw)
  const p = raw.proactive
  check('mode set to "mute"', p.mode === 'mute', `got ${p.mode}`)
  for (const k of DEAD_KNOBS) {
    check(`dead knob "${k}" stripped`, !(k in p))
  }
  check('includeScreen preserved', p.includeScreen === true)
  check('excludedScreenIds preserved', Array.isArray(p.excludedScreenIds) && p.excludedScreenIds.length === 1)
}

console.log('\n[2] legacy enabled:true → mode left absent (Zod default takes over)')
{
  const raw = {
    proactive: {
      enabled: true,
      timerSec: 900,
      idleThresholdSec: 600,
    },
  }
  migrateProactiveLegacyKnobs(raw)
  const p = raw.proactive
  check('mode NOT set (lets Zod default to "auto")', !('mode' in p))
  for (const k of DEAD_KNOBS) {
    check(`dead knob "${k}" stripped`, !(k in p))
  }
}

console.log('\n[3] existing "mode" preserved even if legacy enabled also present')
{
  const raw = {
    proactive: {
      enabled: false, // conflicting!
      mode: 'chatty',
    },
  }
  migrateProactiveLegacyKnobs(raw)
  check('mode stays "chatty" (not overwritten by enabled:false)', raw.proactive.mode === 'chatty')
  check('enabled stripped anyway', !('enabled' in raw.proactive))
}

console.log('\n[4] missing proactive key → no crash, no change')
{
  const raw = {}
  migrateProactiveLegacyKnobs(raw)
  check('no proactive key added', !('proactive' in raw))
}

console.log('\n[5] proactive present but empty → no crash, no mode added')
{
  const raw = { proactive: {} }
  migrateProactiveLegacyKnobs(raw)
  check('proactive stays empty', Object.keys(raw.proactive).length === 0)
}

console.log('\n[6] only some dead knobs (partial legacy) — all should still go')
{
  const raw = {
    proactive: {
      timerSec: 900, // only one knob left, no enabled
      includeScreen: false,
    },
  }
  migrateProactiveLegacyKnobs(raw)
  check('timerSec stripped', !('timerSec' in raw.proactive))
  check('includeScreen preserved', raw.proactive.includeScreen === false)
  check('mode NOT set (no enabled:false signal)', !('mode' in raw.proactive))
}

console.log('\n[7] non-object proactive value → no crash')
{
  const raw = { proactive: null }
  migrateProactiveLegacyKnobs(raw)
  check('null proactive left alone', raw.proactive === null)

  const raw2 = { proactive: 'not-an-object' }
  migrateProactiveLegacyKnobs(raw2)
  check('string proactive left alone', raw2.proactive === 'not-an-object')
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
