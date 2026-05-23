/**
 * Integration test for the proactive engine math.
 *
 * `smoke-proactive-cadence` already verifies the cadence table; this
 * test runs the next layer up — `evaluateTriggers` — against canned
 * (idleSec, sinceAssistantSec) scenarios per mode × tier. The goal is
 * to catch regressions in the seam between cadence resolution and
 * trigger production: "auto + Lv.1 + 15 min idle → no trigger" vs
 * "auto + Lv.5 + 6 min idle → idle trigger fires".
 *
 * Doesn't run Electron — both helpers are pure once we hand them the
 * Electron-side state values.
 *
 * Run: npm run test:proactive-engine
 */

const { register } = await import('tsx/esm/api')
register()

const { cadenceFor } = await import('../src/shared/proactive-cadence.ts')
const { evaluateTriggers } = await import('../src/shared/proactive-triggers.ts')

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

// Helper: drive the engine for one tick. Returns the trigger list (empty
// if mute, gated, or no trigger conditions met).
function tickEngine({
  mode,
  tier,
  idleSec,
  idleArmed = true,
  sinceAssistantSec,
}) {
  const cadence = cadenceFor(mode, tier)
  if (!cadence) return [] // mute → engine off
  return evaluateTriggers({ cadence, idleSec, idleArmed, sinceAssistantSec, nowISO: '2026-05-22T12:00:00Z' })
}

console.log('\n[1] mute mode produces zero triggers regardless of state')
{
  for (const tier of ['tier1', 'tier2', 'tier3', 'tier4', 'tier5']) {
    // Even with absurd "user gone for 3 hours" + "no assistant for 3 hours"
    // mute must stay silent.
    const triggers = tickEngine({
      mode: 'mute',
      tier,
      idleSec: 10_800,
      sinceAssistantSec: 10_800,
    })
    check(`mute × ${tier} produces 0 triggers`, triggers.length === 0, `got ${triggers.length}`)
  }
}

console.log('\n[2] auto × Lv.1 (cold stranger) — present but measured')
{
  // tier1 since v0.1.5 rebalance: idle 10 min, timer 20 min.
  // Was previously 30/40 min — too quiet for Day-1 users staring at
  // the app after onboarding peek and getting silence for half an hour.
  // 5 min idle / 5 min silent → nothing fires.
  const quiet = tickEngine({
    mode: 'auto',
    tier: 'tier1',
    idleSec: 5 * 60,
    sinceAssistantSec: 5 * 60,
  })
  check('Lv.1 5min idle/silent → no trigger', quiet.length === 0, `got ${quiet.length}`)

  // 11 min idle, 11 min silent → idle fires (10 min threshold), timer doesn't (20 min).
  const idleOnly = tickEngine({
    mode: 'auto',
    tier: 'tier1',
    idleSec: 11 * 60,
    sinceAssistantSec: 11 * 60,
  })
  check('Lv.1 11min idle → idle trigger fires', idleOnly.some((t) => t.kind === 'idle'))
  check('Lv.1 11min silent → timer NOT fired yet (timer=20min)', !idleOnly.some((t) => t.kind === 'timer'))

  // 21 min idle / 21 min silent → both fire.
  const both = tickEngine({
    mode: 'auto',
    tier: 'tier1',
    idleSec: 21 * 60,
    sinceAssistantSec: 21 * 60,
  })
  check('Lv.1 21min idle+silent → both triggers fire', both.length === 2)
}

console.log('\n[3] auto × Lv.3 — moderate presence (8/13 min after rebalance)')
{
  // tier3 since v0.1.5: idle 8 min (480s), timer 13 min (780s).
  // 5 min — nothing.
  const quiet = tickEngine({ mode: 'auto', tier: 'tier3', idleSec: 5 * 60, sinceAssistantSec: 5 * 60 })
  check('Lv.3 5min idle/silent → no trigger', quiet.length === 0)
  // 9 min idle → idle fires (threshold 8 min). Timer threshold 13 min — not yet.
  const idleOnly = tickEngine({ mode: 'auto', tier: 'tier3', idleSec: 9 * 60, sinceAssistantSec: 9 * 60 })
  check('Lv.3 9min idle → idle fires', idleOnly.some((t) => t.kind === 'idle'))
  check('Lv.3 9min silent → timer NOT fired yet', !idleOnly.some((t) => t.kind === 'timer'))
  // 14 min — both fire.
  const both = tickEngine({ mode: 'auto', tier: 'tier3', idleSec: 14 * 60, sinceAssistantSec: 14 * 60 })
  check('Lv.3 14min idle+silent → both triggers', both.length === 2)
}

console.log('\n[4] auto × Lv.5 is responsive (5/7 min)')
{
  // 3 min — nothing yet (idle threshold 5 min, timer 7 min).
  const quiet = tickEngine({ mode: 'auto', tier: 'tier5', idleSec: 3 * 60, sinceAssistantSec: 3 * 60 })
  check('Lv.5 3min idle/silent → no trigger', quiet.length === 0)
  // 6 min idle → idle fires.
  const idleOnly = tickEngine({ mode: 'auto', tier: 'tier5', idleSec: 6 * 60, sinceAssistantSec: 6 * 60 })
  check('Lv.5 6min idle → idle fires', idleOnly.some((t) => t.kind === 'idle'))
  // 8 min → both fire.
  const both = tickEngine({ mode: 'auto', tier: 'tier5', idleSec: 8 * 60, sinceAssistantSec: 8 * 60 })
  check('Lv.5 8min idle+silent → both triggers', both.length === 2)
}

console.log('\n[5] chatty fires fast at every tier')
{
  // chatty: idle=3min, timer=5min.
  for (const tier of ['tier1', 'tier3', 'tier5']) {
    const triggers = tickEngine({ mode: 'chatty', tier, idleSec: 4 * 60, sinceAssistantSec: 4 * 60 })
    check(`chatty × ${tier} 4min idle → idle fires`, triggers.some((t) => t.kind === 'idle'))
    // Lv.1 user with auto would have been at 30 min threshold — chatty bypasses.
  }
  // 6 min triggers timer too.
  const both = tickEngine({ mode: 'chatty', tier: 'tier1', idleSec: 6 * 60, sinceAssistantSec: 6 * 60 })
  check('chatty × Lv.1 6min idle+silent → both triggers', both.length === 2)
}

console.log('\n[6] idleArmed latch suppresses repeat idle triggers')
{
  // Even with idleSec well past threshold, idleArmed=false → no idle trigger.
  const triggers = tickEngine({
    mode: 'auto',
    tier: 'tier3',
    idleSec: 30 * 60,
    idleArmed: false,
    sinceAssistantSec: 5 * 60, // not enough for timer
  })
  check('idleArmed=false suppresses idle trigger', !triggers.some((t) => t.kind === 'idle'))
  check('idleArmed=false does NOT block timer trigger', triggers.length === 0) // timer still 15min away
  // But timer at 16 min should still fire even with idleArmed=false.
  const timerOnly = tickEngine({
    mode: 'auto',
    tier: 'tier3',
    idleSec: 30 * 60,
    idleArmed: false,
    sinceAssistantSec: 16 * 60,
  })
  check('timer fires even with idleArmed=false', timerOnly.some((t) => t.kind === 'timer'))
  check('idle still suppressed', !timerOnly.some((t) => t.kind === 'idle'))
}

console.log('\n[7] trigger notes carry usable minute counts')
{
  const triggers = tickEngine({
    mode: 'auto',
    tier: 'tier3',
    idleSec: 720, // 12 min
    sinceAssistantSec: 900, // 15 min
  })
  const idle = triggers.find((t) => t.kind === 'idle')
  const timer = triggers.find((t) => t.kind === 'timer')
  check('idle note mentions "12 分钟"', !!idle && /12 分钟/.test(idle.note), `got "${idle?.note}"`)
  check('timer note mentions "15 分钟"', !!timer && /15 分钟/.test(timer.note), `got "${timer?.note}"`)
}

console.log('\n[8] cross-cutting: warm tier responds where cold tier stays silent')
{
  // Same state → Lv.1 quiet, Lv.5 noisy.
  const state = { idleSec: 8 * 60, sinceAssistantSec: 8 * 60 }
  const lv1 = tickEngine({ mode: 'auto', tier: 'tier1', ...state })
  const lv5 = tickEngine({ mode: 'auto', tier: 'tier5', ...state })
  check('Lv.1 stays silent at 8min', lv1.length === 0, `got ${lv1.length}`)
  check('Lv.5 fires at 8min', lv5.length > 0, `got ${lv5.length}`)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
