#!/usr/bin/env node
/**
 * Unit tests for the pure affinity engine (shared/affinity.ts).
 *
 * Covers: per-turn clamp, cold-start damping, rolling median, daily cap
 * clipping, score bounds, decay floor. No I/O, no LLM — runs in < 50ms.
 *
 * Run: node --import tsx tools/smoke-affinity-guardrails.mjs
 */

import assert from 'node:assert/strict'

import {
  AFFINITY_DECAY_FLOOR,
  AFFINITY_MAX,
  AFFINITY_MIN,
  applyDecay,
  applyDeltaWithGuardrails,
  buildTierPromptBlock,
  tierFor,
} from '../src/shared/affinity.ts'

const results = []
const check = (name, fn) => {
  try {
    fn()
    results.push({ name, ok: true })
    console.log(`  ✅ ${name}`)
  } catch (err) {
    results.push({ name, ok: false, detail: err.message ?? String(err) })
    console.log(`  ❌ ${name}\n    ${err.message ?? err}`)
  }
}

// ---------- tierFor ----------

console.log('\n████ tierFor ████\n')

check('0 maps to tier1', () => {
  assert.equal(tierFor(0).tier, 'tier1')
  assert.equal(tierFor(0).zhLabel, 'Lv.1')
})
check('19 still tier1 (inclusive upper)', () => {
  assert.equal(tierFor(19).tier, 'tier1')
})
check('20 jumps to tier2', () => {
  assert.equal(tierFor(20).tier, 'tier2')
})
check('39 still tier2', () => {
  assert.equal(tierFor(39).tier, 'tier2')
})
check('40 jumps to tier3', () => {
  assert.equal(tierFor(40).tier, 'tier3')
})
check('59 still tier3', () => {
  assert.equal(tierFor(59).tier, 'tier3')
})
check('60 jumps to tier4', () => {
  assert.equal(tierFor(60).tier, 'tier4')
})
check('79 still tier4', () => {
  assert.equal(tierFor(79).tier, 'tier4')
})
check('80 jumps to tier5', () => {
  assert.equal(tierFor(80).tier, 'tier5')
})
check('100 still tier5', () => {
  assert.equal(tierFor(100).tier, 'tier5')
})
check('clamps out-of-range high', () => {
  assert.equal(tierFor(500).tier, 'tier5')
})
check('clamps out-of-range low', () => {
  assert.equal(tierFor(-50).tier, 'tier1')
})

// ---------- Per-turn clamp ----------

console.log('\n████ Per-turn clamp ████\n')

check('huge positive delta clipped to +2', () => {
  const r = applyDeltaWithGuardrails({
    currentScore: 50,
    rawDelta: 50,
    lifetimeTurns: 100,
    todayAbsDelta: 0,
    recentDeltas: [],
  })
  assert.equal(r.effectiveDelta, 2)
  assert.equal(r.finalScore, 52)
  assert.match(r.note ?? '', /per-turn clamp/)
})
check('huge negative delta clipped to -2', () => {
  const r = applyDeltaWithGuardrails({
    currentScore: 50,
    rawDelta: -50,
    lifetimeTurns: 100,
    todayAbsDelta: 0,
    recentDeltas: [],
  })
  assert.equal(r.effectiveDelta, -2)
  assert.equal(r.finalScore, 48)
})
check('NaN delta becomes 0', () => {
  const r = applyDeltaWithGuardrails({
    currentScore: 50,
    rawDelta: NaN,
    lifetimeTurns: 100,
    todayAbsDelta: 0,
    recentDeltas: [],
  })
  assert.equal(r.effectiveDelta, 0)
  assert.equal(r.finalScore, 50)
})

// ---------- Cold-start damping ----------

console.log('\n████ Cold-start damping ████\n')

check('cold-start halves +2 to +1', () => {
  const r = applyDeltaWithGuardrails({
    currentScore: 10,
    rawDelta: 2,
    lifetimeTurns: 5,
    todayAbsDelta: 0,
    recentDeltas: [],
  })
  // 2 × 0.5 = 1 (truncated)
  assert.equal(r.effectiveDelta, 1)
})
check('cold-start halves -2 to -1', () => {
  const r = applyDeltaWithGuardrails({
    currentScore: 10,
    rawDelta: -2,
    lifetimeTurns: 5,
    todayAbsDelta: 0,
    recentDeltas: [],
  })
  assert.equal(r.effectiveDelta, -1)
})
check('cold-start does NOT kick in after threshold', () => {
  const r = applyDeltaWithGuardrails({
    currentScore: 50,
    rawDelta: 2,
    lifetimeTurns: 30,
    todayAbsDelta: 0,
    recentDeltas: [],
  })
  assert.equal(r.effectiveDelta, 2)
})

// ---------- Rolling median ----------

console.log('\n████ Rolling median ████\n')

check('isolated +2 surrounded by 0s is dampened to 0', () => {
  // Sample: [2, 0, 0] → sorted [0, 0, 2] → median 0
  const r = applyDeltaWithGuardrails({
    currentScore: 50,
    rawDelta: 2,
    lifetimeTurns: 100,
    todayAbsDelta: 0,
    recentDeltas: [0, 0],
  })
  assert.equal(r.effectiveDelta, 0, 'a one-off positive among quiet turns should not move score')
})
check('sustained +1 with +2 incoming gives +1', () => {
  // Sample: [2, 1, 1] → sorted [1, 1, 2] → median 1
  const r = applyDeltaWithGuardrails({
    currentScore: 50,
    rawDelta: 2,
    lifetimeTurns: 100,
    todayAbsDelta: 0,
    recentDeltas: [1, 1],
  })
  assert.equal(r.effectiveDelta, 1)
})
check('median doesn\'t apply with fewer than 2 prior deltas', () => {
  const r = applyDeltaWithGuardrails({
    currentScore: 50,
    rawDelta: 2,
    lifetimeTurns: 100,
    todayAbsDelta: 0,
    recentDeltas: [1], // only 1 prior
  })
  assert.equal(r.effectiveDelta, 2)
})

// ---------- Daily cap ----------

console.log('\n████ Daily cap ████\n')

check('at cap → delta blocked', () => {
  const r = applyDeltaWithGuardrails({
    currentScore: 50,
    rawDelta: 2,
    lifetimeTurns: 100,
    todayAbsDelta: 10,
    recentDeltas: [],
  })
  assert.equal(r.effectiveDelta, 0)
  assert.match(r.note ?? '', /daily cap/)
})
check('partial remaining → delta clipped to remaining', () => {
  const r = applyDeltaWithGuardrails({
    currentScore: 50,
    rawDelta: 2,
    lifetimeTurns: 100,
    todayAbsDelta: 9,
    recentDeltas: [],
  })
  assert.equal(r.effectiveDelta, 1)
})
check('over cap blocks negative too', () => {
  const r = applyDeltaWithGuardrails({
    currentScore: 50,
    rawDelta: -2,
    lifetimeTurns: 100,
    todayAbsDelta: 10,
    recentDeltas: [],
  })
  assert.equal(r.effectiveDelta, 0)
})

// ---------- Score bounds ----------

console.log('\n████ Score bounds ████\n')

check('cannot exceed MAX (100)', () => {
  const r = applyDeltaWithGuardrails({
    currentScore: 99,
    rawDelta: 2,
    lifetimeTurns: 100,
    todayAbsDelta: 0,
    recentDeltas: [],
  })
  assert.equal(r.finalScore, AFFINITY_MAX)
})
check('cannot go below MIN (0)', () => {
  const r = applyDeltaWithGuardrails({
    currentScore: 1,
    rawDelta: -2,
    lifetimeTurns: 100,
    todayAbsDelta: 0,
    recentDeltas: [],
  })
  assert.equal(r.finalScore, AFFINITY_MIN)
})

// ---------- Decay ----------

console.log('\n████ Decay ████\n')

check('no decay when daysIdle = 0', () => {
  assert.equal(applyDecay(50, 0), 50)
})
check('1 day decay → -1', () => {
  assert.equal(applyDecay(50, 1), 49)
})
check('long decay floors at 30', () => {
  assert.equal(applyDecay(50, 365), AFFINITY_DECAY_FLOOR)
})
check('score already below floor is left alone', () => {
  // Cold-start zero shouldn't grow to 30 just because of decay
  assert.equal(applyDecay(0, 100), 0)
})
check('score at floor exactly is left alone (already at minimum reduction target)', () => {
  assert.equal(applyDecay(30, 5), 30)
})

// ---------- Tier prompt block ----------

console.log('\n████ Tier prompt block ████\n')

check('block mentions current score', () => {
  const b = buildTierPromptBlock(47, '小晴')
  assert.match(b, /47/)
})
check('tier1 block warns against intimate address', () => {
  const b = buildTierPromptBlock(10, '小晴')
  // Should warn about being too forward — look for distance keywords
  assert.match(b, /您|不要使用任何亲密称呼|初识/)
})
check('tier5 block enables intimate behaviors', () => {
  const b = buildTierPromptBlock(90, '小晴')
  assert.match(b, /默契|内部梗/)
})

// ---------- Summary ----------

const failed = results.filter((r) => !r.ok)
console.log(
  `\n${failed.length === 0 ? '✅' : '❌'} ${results.length - failed.length}/${results.length} assertions passed`,
)
if (failed.length > 0) {
  console.log('\nFailed:')
  for (const f of failed) console.log(`  · ${f.name} :: ${f.detail}`)
}
process.exit(failed.length === 0 ? 0 : 1)
