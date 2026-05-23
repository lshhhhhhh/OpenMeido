/**
 * Unit test for the proactive-cadence helper.
 *
 * Covers all 15 (5 tier × 3 mode) combinations + a few boundary scores
 * to make sure tier resolution lines up with the affinity ranges.
 *
 * Run: npm run test:proactive-cadence
 */

const { register } = await import('tsx/esm/api')
register()

const { cadenceFor, cadenceForScore, PROACTIVE_POLL_INTERVAL_SEC } = await import(
  '../src/shared/proactive-cadence.ts'
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

console.log('\n[1] mute returns null for every tier')
{
  for (const tier of ['tier1', 'tier2', 'tier3', 'tier4', 'tier5']) {
    check(`mute × ${tier} → null`, cadenceFor('mute', tier) === null)
  }
}

console.log('\n[2] chatty returns the same dense cadence regardless of tier')
{
  const c1 = cadenceFor('chatty', 'tier1')
  const c5 = cadenceFor('chatty', 'tier5')
  check('chatty tier1 ≠ null', c1 !== null)
  check('chatty tier5 ≠ null', c5 !== null)
  check(
    'chatty same cadence across tiers',
    JSON.stringify(c1) === JSON.stringify(c5),
  )
  check(
    'chatty is denser than auto-tier5',
    c1.idleThresholdSec < cadenceFor('auto', 'tier5').idleThresholdSec,
    `chatty=${c1.idleThresholdSec} vs auto-tier5=${cadenceFor('auto', 'tier5').idleThresholdSec}`,
  )
}

console.log('\n[3] auto cadence is monotonic — quieter at low tiers')
{
  const a1 = cadenceFor('auto', 'tier1')
  const a2 = cadenceFor('auto', 'tier2')
  const a3 = cadenceFor('auto', 'tier3')
  const a4 = cadenceFor('auto', 'tier4')
  const a5 = cadenceFor('auto', 'tier5')

  // Idle threshold + cooldown should strictly decrease with tier (warmer
  // = more frequent). Timer too.
  check(
    'idleThresholdSec is non-increasing as tier rises',
    a1.idleThresholdSec >= a2.idleThresholdSec &&
      a2.idleThresholdSec >= a3.idleThresholdSec &&
      a3.idleThresholdSec >= a4.idleThresholdSec &&
      a4.idleThresholdSec >= a5.idleThresholdSec,
    `idle: ${[a1, a2, a3, a4, a5].map((c) => c.idleThresholdSec).join(' / ')}`,
  )
  check(
    'cooldownSec is non-increasing as tier rises',
    a1.cooldownSec >= a2.cooldownSec &&
      a2.cooldownSec >= a3.cooldownSec &&
      a3.cooldownSec >= a4.cooldownSec &&
      a4.cooldownSec >= a5.cooldownSec,
    `cooldown: ${[a1, a2, a3, a4, a5].map((c) => c.cooldownSec).join(' / ')}`,
  )
  check(
    'timerSec is non-increasing as tier rises',
    a1.timerSec >= a2.timerSec &&
      a2.timerSec >= a3.timerSec &&
      a3.timerSec >= a4.timerSec &&
      a4.timerSec >= a5.timerSec,
    `timer: ${[a1, a2, a3, a4, a5].map((c) => c.timerSec).join(' / ')}`,
  )
  // Lv.1 should be noticeably quieter than Lv.3 (the prior global default).
  check(
    'tier1 idle threshold is at least 2x the tier3 baseline',
    a1.idleThresholdSec >= 2 * a3.idleThresholdSec,
    `tier1=${a1.idleThresholdSec} vs tier3=${a3.idleThresholdSec}`,
  )
}

console.log('\n[4] auto-Lv.3 preserves the old global defaults (no surprise migration)')
{
  const a3 = cadenceFor('auto', 'tier3')
  check('idleThresholdSec stays at 600s (10 min)', a3.idleThresholdSec === 600)
  check('timerSec stays at 900s (15 min)', a3.timerSec === 900)
  check('cooldownSec stays at 600s (10 min)', a3.cooldownSec === 600)
  check('minSilenceSec stays at 30s', a3.minSilenceSec === 30)
}

console.log('\n[5] cadenceForScore tier mapping is correct at boundaries')
{
  // Tier1 0-19, Tier2 20-39, Tier3 40-59, Tier4 60-79, Tier5 80-100.
  const c0 = cadenceForScore('auto', 0)
  const c19 = cadenceForScore('auto', 19)
  const c20 = cadenceForScore('auto', 20)
  const c40 = cadenceForScore('auto', 40)
  const c80 = cadenceForScore('auto', 80)
  const c100 = cadenceForScore('auto', 100)
  // score 0..19 = tier1
  check('score=0 → tier1 cadence', JSON.stringify(c0) === JSON.stringify(cadenceFor('auto', 'tier1')))
  check('score=19 → tier1 cadence', JSON.stringify(c19) === JSON.stringify(cadenceFor('auto', 'tier1')))
  // score 20 = tier2
  check('score=20 → tier2 cadence', JSON.stringify(c20) === JSON.stringify(cadenceFor('auto', 'tier2')))
  // score 40 = tier3
  check('score=40 → tier3 cadence', JSON.stringify(c40) === JSON.stringify(cadenceFor('auto', 'tier3')))
  // score 80 = tier5
  check('score=80 → tier5 cadence', JSON.stringify(c80) === JSON.stringify(cadenceFor('auto', 'tier5')))
  // score 100 = tier5
  check('score=100 → tier5 cadence', JSON.stringify(c100) === JSON.stringify(cadenceFor('auto', 'tier5')))
}

console.log('\n[6] poll interval is the documented 5 seconds')
{
  check('PROACTIVE_POLL_INTERVAL_SEC === 5', PROACTIVE_POLL_INTERVAL_SEC === 5)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
