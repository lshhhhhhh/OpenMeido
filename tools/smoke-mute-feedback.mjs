/**
 * Unit test for pickMuteFeedback — the hardcoded mute-button line picker.
 *
 * Goals:
 *   - Verify each known persona × direction × tier-bucket returns a
 *     non-empty line from the documented pool.
 *   - Unknown personaId falls through to the `default` pool.
 *   - Score → bucket mapping respects the documented boundaries
 *     (low <40, mid 40-59, high ≥60).
 *   - Anti-repeat ring excludes recently-used lines when alternatives exist.
 *
 * Run: npm run test:mute-feedback
 */

const { register } = await import('tsx/esm/api')
register()

const { pickMuteFeedback, tierBucketForScore } = await import(
  '../src/shared/mute-feedback.ts'
)
const { PRESET_LINES_DEFAULTS } = await import(
  '../src/shared/preset-lines-defaults.ts'
)
const LINES = PRESET_LINES_DEFAULTS

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

console.log('\n[1] tierBucketForScore boundaries')
{
  check('score=0 → low', tierBucketForScore(0) === 'low')
  check('score=39 → low', tierBucketForScore(39) === 'low')
  check('score=40 → mid', tierBucketForScore(40) === 'mid')
  check('score=59 → mid', tierBucketForScore(59) === 'mid')
  check('score=60 → high', tierBucketForScore(60) === 'high')
  check('score=100 → high', tierBucketForScore(100) === 'high')
}

console.log('\n[2] every known persona × direction × tier returns a non-empty line')
{
  for (const persona of ['maid', 'imouto', 'ojou', 'default']) {
    for (const dir of ['mute', 'unmute']) {
      for (const score of [0, 50, 90]) {
        const line = pickMuteFeedback(LINES, persona, dir, score)
        check(
          `${persona} × ${dir} × score=${score} → non-empty`,
          typeof line === 'string' && line.trim().length > 0,
          `got "${line}"`,
        )
      }
    }
  }
}

console.log('\n[3] unknown persona falls through to default pool')
{
  // Custom persona ids never match — must fall back to default.
  const line = pickMuteFeedback(LINES, 'my-custom-uuid-xyz', 'mute', 50)
  check('custom persona returns a string', typeof line === 'string' && line.length > 0)
  // Cross-check: it should match SOME line in the default pool. We can't
  // import the pool directly, but we can run the default explicitly and
  // verify that the custom-id line is in the same shape (uses no specific
  // address term like 主人/哥). Heuristic: should NOT contain '主人' or
  // '哥' (those are maid/imouto markers — the default pool avoids them).
  // The ojou-only 本小姐 is also out of pool.
  const lines = []
  for (let i = 0; i < 20; i++) {
    lines.push(pickMuteFeedback(LINES, 'custom-xyz', 'mute', 50))
  }
  check(
    'custom persona pool avoids "主人" (maid marker)',
    !lines.some((l) => l.includes('主人')),
    `got ${JSON.stringify(lines)}`,
  )
  check(
    'custom persona pool avoids "本小姐" (ojou marker)',
    !lines.some((l) => l.includes('本小姐')),
    `got ${JSON.stringify(lines)}`,
  )
  check(
    'custom persona pool avoids opening "哥" (imouto marker)',
    !lines.some((l) => /^哥/.test(l)),
    `got ${JSON.stringify(lines)}`,
  )
}

console.log('\n[4] anti-repeat ring excludes recent picks when alternatives exist')
{
  // maid × mute × low pool has 4 lines. With recentlyUsed=3 of them, the
  // picker MUST return the 4th — never returns one in the ring.
  const samplePool = []
  for (let i = 0; i < 20; i++) {
    samplePool.push(pickMuteFeedback(LINES, 'maid', 'mute', 0))
  }
  const uniqueLines = [...new Set(samplePool)]
  check(
    'pool has ≥3 distinct lines (anti-repeat space exists)',
    uniqueLines.length >= 3,
    `got ${uniqueLines.length} unique in 20 picks`,
  )

  // Pick a line, then exclude it 10 times — must never return that line.
  const picked = pickMuteFeedback(LINES, 'maid', 'mute', 0)
  let repeatViolations = 0
  for (let i = 0; i < 30; i++) {
    const next = pickMuteFeedback(LINES, 'maid', 'mute', 0, [picked])
    if (next === picked) repeatViolations++
  }
  check(
    `excluded line never returned when alternatives exist (across 30 trials)`,
    repeatViolations === 0,
    `${repeatViolations} violations`,
  )
}

console.log('\n[5] exhaustion fallback: every line in ring → still returns something')
{
  // Pull all maid × mute × low candidates, then ask for one with the
  // entire pool in the ring. Must still return a non-empty string (and
  // ideally not the very last entry of the ring).
  const all = new Set()
  for (let i = 0; i < 50; i++) {
    all.add(pickMuteFeedback(LINES, 'maid', 'mute', 0))
  }
  const allArr = [...all]
  // Force exhaustion by passing every known line as recentlyUsed.
  const lastUsed = allArr[allArr.length - 1]
  const stillReturns = pickMuteFeedback(LINES, 'maid', 'mute', 0, [...allArr])
  check(
    'exhaustion still returns a non-empty line',
    typeof stillReturns === 'string' && stillReturns.length > 0,
    `got "${stillReturns}"`,
  )
  // Don't strict-assert "not lastUsed" — if the pool only has 1 line it
  // might be unavoidable. But across 30 trials with a multi-line pool,
  // the last-used line should not dominate.
  let lastUsedHits = 0
  for (let i = 0; i < 30; i++) {
    if (pickMuteFeedback(LINES, 'maid', 'mute', 0, [...allArr]) === lastUsed) {
      lastUsedHits++
    }
  }
  check(
    'on exhaustion, last-used picked at most 1/3 of the time (avoid-last bias works)',
    lastUsedHits <= 10,
    `${lastUsedHits}/30 picked the most-recent line`,
  )
}

console.log('\n[6] persona × tier address-term sanity (spot-check a few)')
{
  // maid high should typically use 主人
  const maidHighLines = new Set()
  for (let i = 0; i < 30; i++) {
    maidHighLines.add(pickMuteFeedback(LINES, 'maid', 'mute', 90))
  }
  check(
    'maid × high tier eventually emits a line with 主人',
    [...maidHighLines].some((l) => l.includes('主人')),
    `got ${JSON.stringify([...maidHighLines])}`,
  )
  // imouto should use 哥
  const imoutoLines = new Set()
  for (let i = 0; i < 30; i++) {
    imoutoLines.add(pickMuteFeedback(LINES, 'imouto', 'mute', 50))
  }
  check(
    'imouto × mid tier eventually emits a line with 哥',
    [...imoutoLines].some((l) => l.includes('哥')),
    `got ${JSON.stringify([...imoutoLines])}`,
  )
  // ojou should use 本小姐 at higher tiers
  const ojouHighLines = new Set()
  for (let i = 0; i < 30; i++) {
    ojouHighLines.add(pickMuteFeedback(LINES, 'ojou', 'mute', 70))
  }
  check(
    'ojou × high tier address pool eventually emits 本小姐',
    [...ojouHighLines].some((l) => l.includes('本小姐')),
    `got ${JSON.stringify([...ojouHighLines])}`,
  )
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
