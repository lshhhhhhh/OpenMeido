#!/usr/bin/env node
/**
 * Unit tests for the pure affinity engine (shared/affinity.ts).
 *
 * Covers: per-turn clamp, rolling median, daily cap clipping,
 * score bounds, decay floor. No I/O, no LLM — runs in < 50ms.
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
  curveDelta,
  diminishingFactor,
  tierFor,
} from '../src/shared/affinity.ts'

// Tolerance for floating-point comparisons — the diminishing curve
// introduces irrationals (sqrt) so exact equality breaks.
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps

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

check('huge positive delta clipped to +2 (at score 0 → no curve)', () => {
  // currentScore=0 zeroes out the diminishing curve so we can isolate
  // the per-turn clamp behavior. Curve interaction is exercised in the
  // dedicated curve section below.
  const r = applyDeltaWithGuardrails({
    currentScore: 0,
    rawDelta: 50,
    todayAbsDelta: 0,
    recentDeltas: [],
  })
  assert.equal(r.effectiveDelta, 2)
  assert.equal(r.finalScore, 2)
  assert.match(r.note ?? '', /per-turn clamp/)
})
check('huge negative delta clipped to -2', () => {
  const r = applyDeltaWithGuardrails({
    currentScore: 50,
    rawDelta: -50,
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
    todayAbsDelta: 0,
    recentDeltas: [],
  })
  assert.equal(r.effectiveDelta, 0)
  assert.equal(r.finalScore, 50)
})

// ---------- Float-mode passthrough ----------

console.log('\n████ Float passthrough ████\n')

// Cold-start damping removed (2026-05-21): the rolling-median + daily
// cap already filter outliers; cold-start was redundant AND its
// integer truncation silently ate every +1. Score is now a plain
// float, UI rounds at display.
check('+1 at score 0 passes through cleanly (curve factor=1)', () => {
  const r = applyDeltaWithGuardrails({
    currentScore: 0,
    rawDelta: 1,
    todayAbsDelta: 0,
    recentDeltas: [],
  })
  assert.equal(r.effectiveDelta, 1)
})
check('+2 at low score nearly full (curve barely dampens)', () => {
  // Curve at score=0 is factor=1, so +2 passes through 2.0. At score=5
  // factor=(1-0.05)^0.5 ≈ 0.9747 → effective ≈ 1.949.
  const r = applyDeltaWithGuardrails({
    currentScore: 5,
    rawDelta: 2,
    todayAbsDelta: 0,
    recentDeltas: [],
  })
  assert.ok(approx(r.effectiveDelta, 2 * Math.sqrt(0.95)))
})
check('-1 single delta passes through cleanly', () => {
  const r = applyDeltaWithGuardrails({
    currentScore: 5,
    rawDelta: -1,
    todayAbsDelta: 0,
    recentDeltas: [],
  })
  assert.equal(r.effectiveDelta, -1)
})
check('fractional delta preserved at score 0', () => {
  // currentScore=0 means curve factor=1; 0.5 stays 0.5 (no truncation).
  const r = applyDeltaWithGuardrails({
    currentScore: 0,
    rawDelta: 0.5,
    todayAbsDelta: 0,
    recentDeltas: [],
  })
  assert.equal(r.effectiveDelta, 0.5)
})
// ---------- Rolling median ----------

console.log('\n████ Rolling median ████\n')

check('isolated +2 surrounded by 0s is dampened to 0', () => {
  // Sample: [2, 0, 0] → sorted [0, 0, 2] → median 0
  const r = applyDeltaWithGuardrails({
    currentScore: 0,
    rawDelta: 2,
    todayAbsDelta: 0,
    recentDeltas: [0, 0],
  })
  assert.equal(r.effectiveDelta, 0, 'a one-off positive among quiet turns should not move score')
})
check('sustained +1 with +2 incoming gives +1 (at score 0)', () => {
  // Sample: [2, 1, 1] → sorted [1, 1, 2] → median 1
  const r = applyDeltaWithGuardrails({
    currentScore: 0,
    rawDelta: 2,
    todayAbsDelta: 0,
    recentDeltas: [1, 1],
  })
  assert.equal(r.effectiveDelta, 1)
})
check('median doesn\'t apply with fewer than 2 prior deltas (at score 0)', () => {
  const r = applyDeltaWithGuardrails({
    currentScore: 0,
    rawDelta: 2,
    todayAbsDelta: 0,
    recentDeltas: [1], // only 1 prior
  })
  assert.equal(r.effectiveDelta, 2)
})
check('sign-flip guard: -1 against [+1,+1] zeroes out, not flips to +1', () => {
  // Before the guard this was the bug: median([−1, +1, +1]) = +1, so a
  // "she's annoyed" verdict got turned into a positive move.
  const r = applyDeltaWithGuardrails({
    currentScore: 10,
    rawDelta: -1,
    todayAbsDelta: 0,
    recentDeltas: [1, 1],
  })
  assert.equal(r.effectiveDelta, 0)
  assert.match(r.note ?? '', /sign-flip/)
})
check('sign-flip guard: +1 against [−1,−1] zeroes out, not flips to −1', () => {
  const r = applyDeltaWithGuardrails({
    currentScore: 10,
    rawDelta: 1,
    todayAbsDelta: 0,
    recentDeltas: [-1, -1],
  })
  assert.equal(r.effectiveDelta, 0)
  assert.match(r.note ?? '', /sign-flip/)
})
check('same-sign median still smooths (no spurious zero-out)', () => {
  // +2 against [+1,+1] → median +1, applied normally. No sign flip.
  const r = applyDeltaWithGuardrails({
    currentScore: 0,
    rawDelta: 2,
    todayAbsDelta: 0,
    recentDeltas: [1, 1],
  })
  assert.equal(r.effectiveDelta, 1)
})

// ---------- Daily cap ----------

console.log('\n████ Daily cap ████\n')

check('at cap → delta blocked (at score 0)', () => {
  const r = applyDeltaWithGuardrails({
    currentScore: 0,
    rawDelta: 2,
    todayAbsDelta: 10,
    recentDeltas: [],
  })
  assert.equal(r.effectiveDelta, 0)
  assert.match(r.note ?? '', /daily cap/)
})
check('partial remaining → delta clipped to remaining (at score 0)', () => {
  const r = applyDeltaWithGuardrails({
    currentScore: 0,
    rawDelta: 2,
    todayAbsDelta: 9,
    recentDeltas: [],
  })
  // Daily cap clips +2 → +1; curve at score 0 is factor 1 → stays +1.
  assert.equal(r.effectiveDelta, 1)
})
check('over cap blocks negative too', () => {
  // Negative deltas pass through the curve unchanged, so the daily cap
  // is the only thing in play here regardless of currentScore.
  const r = applyDeltaWithGuardrails({
    currentScore: 50,
    rawDelta: -2,
    todayAbsDelta: 10,
    recentDeltas: [],
  })
  assert.equal(r.effectiveDelta, 0)
})

// ---------- Score bounds ----------

console.log('\n████ Score bounds ████\n')

check('approaches MAX asymptotically but does not exceed', () => {
  // Diminishing curve at 99 makes a +2 raw delta worth ~0.632 effective.
  // So final lands ~99.632, well under 100. The hard ceiling at 100
  // still applies for any pathological case (e.g. score=100 + tiny add).
  const r = applyDeltaWithGuardrails({
    currentScore: 99,
    rawDelta: 2,
    todayAbsDelta: 0,
    recentDeltas: [],
  })
  assert.ok(r.finalScore < AFFINITY_MAX)
  assert.ok(r.finalScore > 99)
})
check('hard ceiling holds even if score already at MAX', () => {
  const r = applyDeltaWithGuardrails({
    currentScore: AFFINITY_MAX,
    rawDelta: 2,
    todayAbsDelta: 0,
    recentDeltas: [],
  })
  assert.equal(r.finalScore, AFFINITY_MAX)
  assert.equal(r.effectiveDelta, 0)
})
check('cannot go below MIN (0)', () => {
  const r = applyDeltaWithGuardrails({
    currentScore: 1,
    rawDelta: -2,
    todayAbsDelta: 0,
    recentDeltas: [],
  })
  assert.equal(r.finalScore, AFFINITY_MIN)
})

// ---------- Diminishing-returns curve ----------

console.log('\n████ Diminishing returns ████\n')

check('factor is 1.0 at score 0', () => {
  assert.ok(approx(diminishingFactor(0), 1))
})
check('factor is 0 at score 100', () => {
  assert.ok(approx(diminishingFactor(100), 0))
})
check('factor decreases monotonically with score', () => {
  const samples = [0, 20, 40, 60, 80, 95, 100]
  let prev = Infinity
  for (const s of samples) {
    const f = diminishingFactor(s)
    assert.ok(f <= prev, `factor at ${s} (${f}) should be <= factor at previous (${prev})`)
    prev = f
  }
})
check('curveDelta passes negative through unchanged', () => {
  assert.equal(curveDelta(-1, 80), -1)
  assert.equal(curveDelta(-2, 95), -2)
})
check('curveDelta at score 80 gives ~45% of raw +1', () => {
  assert.ok(approx(curveDelta(1, 80), Math.sqrt(0.2)))
})
check('engine applies curve to positive deltas (score 80 +2 → ~0.89)', () => {
  // Curve: factor = (1 - 80/100)^0.5 = sqrt(0.2) ≈ 0.4472
  // +2 → 2 * 0.4472 ≈ 0.8944
  const r = applyDeltaWithGuardrails({
    currentScore: 80,
    rawDelta: 2,
    todayAbsDelta: 0,
    recentDeltas: [],
  })
  assert.ok(approx(r.effectiveDelta, 2 * Math.sqrt(0.2)))
  assert.match(r.note ?? '', /curve/)
})
check('engine leaves negative deltas alone even at high score', () => {
  const r = applyDeltaWithGuardrails({
    currentScore: 95,
    rawDelta: -2,
    todayAbsDelta: 0,
    recentDeltas: [],
  })
  assert.equal(r.effectiveDelta, -2)
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
