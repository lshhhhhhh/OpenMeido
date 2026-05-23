/**
 * Pure-function tests for the Day-1 onboarding screen-peek decision
 * logic. The actual peek body (screen capture + LLM call + broadcast)
 * is integration code that only runs inside Electron with an LLM
 * configured — this smoke covers the boolean seams that decide WHETHER
 * we ever get there.
 *
 * Run: npm run test:onboarding-peek
 */

const { register } = await import('tsx/esm/api')
register()

const {
  shouldScheduleOnboardingPeek,
  shouldFireOnboardingPeek,
  pickOnboardingDelayMs,
  ONBOARDING_DELAY_MIN_MS,
  ONBOARDING_DELAY_MAX_MS,
} = await import('../src/shared/onboarding.ts')
const { configSchema } = await import('../src/shared/config.ts')

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

/** Build a fully-validated config by starting from Zod defaults and
 *  patching just the fields a test cares about. Keeps each case
 *  declarative without dozens of lines of boilerplate. */
function cfg(overrides = {}) {
  const base = configSchema.parse({})
  return {
    ...base,
    proactive: { ...base.proactive, ...(overrides.proactive ?? {}) },
    onboarding: { ...base.onboarding, ...(overrides.onboarding ?? {}) },
  }
}

console.log('\n[1] shouldScheduleOnboardingPeek — happy path')
{
  const result = shouldScheduleOnboardingPeek(cfg())
  check('default fresh config returns null (schedule it)', result === null, `got ${result}`)
}

console.log('\n[2] shouldScheduleOnboardingPeek — opt-outs')
{
  const alreadyFired = shouldScheduleOnboardingPeek(
    cfg({ onboarding: { firstScreenPeekFired: true } }),
  )
  check(
    'flag already true → already-fired',
    alreadyFired === 'already-fired',
    `got ${alreadyFired}`,
  )

  const muted = shouldScheduleOnboardingPeek(cfg({ proactive: { mode: 'mute' } }))
  check('mode=mute → mute-mode', muted === 'mute-mode', `got ${muted}`)

  const screenOff = shouldScheduleOnboardingPeek(
    cfg({ proactive: { includeScreen: false } }),
  )
  check(
    'includeScreen=false → screen-disabled',
    screenOff === 'screen-disabled',
    `got ${screenOff}`,
  )
}

console.log('\n[3] shouldScheduleOnboardingPeek — chatty mode counts as scheduled')
{
  const chatty = shouldScheduleOnboardingPeek(cfg({ proactive: { mode: 'chatty' } }))
  check('mode=chatty schedules normally', chatty === null, `got ${chatty}`)
}

console.log('\n[4] shouldScheduleOnboardingPeek — already-fired beats other reasons')
{
  // A user who completed onboarding then later muted should NOT be
  // re-onboarded if they unmute — the flag has terminal priority.
  const both = shouldScheduleOnboardingPeek(
    cfg({
      onboarding: { firstScreenPeekFired: true },
      proactive: { mode: 'mute', includeScreen: false },
    }),
  )
  check('flag+mute+screen-off → already-fired wins', both === 'already-fired', `got ${both}`)
}

console.log('\n[5] shouldFireOnboardingPeek — clean window fires')
{
  const greetingTs = 1_000_000
  const result = shouldFireOnboardingPeek({
    greetingTs,
    // Both before greeting → user hasn't typed since, maid hasn't re-spoken.
    lastUserAt: greetingTs - 5_000,
    lastAssistantAt: greetingTs - 1_000,
  })
  check('clean post-greeting window returns null (fire)', result === null, `got ${result}`)
}

console.log('\n[6] shouldFireOnboardingPeek — user activity aborts')
{
  const greetingTs = 1_000_000
  const result = shouldFireOnboardingPeek({
    greetingTs,
    lastUserAt: greetingTs + 10_000, // user typed 10s after greeting
    lastAssistantAt: greetingTs - 1_000,
  })
  check(
    'user typed since greeting → user-already-chatted',
    result === 'user-already-chatted',
    `got ${result}`,
  )
}

console.log('\n[7] shouldFireOnboardingPeek — assistant re-speech aborts')
{
  const greetingTs = 1_000_000
  // Another proactive remark fired in the window (unlikely but possible if
  // cadence is dense and the user is idle for a long time).
  const result = shouldFireOnboardingPeek({
    greetingTs,
    lastUserAt: greetingTs - 5_000,
    lastAssistantAt: greetingTs + 20_000,
  })
  check(
    'assistant spoke again since greeting → assistant-already-spoke-again',
    result === 'assistant-already-spoke-again',
    `got ${result}`,
  )
}

console.log('\n[8] shouldFireOnboardingPeek — equal timestamps fire (not "after")')
{
  // Edge: greetingTs === lastAssistantAt because greeting itself updates
  // noteAssistantActivity() right before scheduleOnboardingPeek is called.
  // That parity must NOT abort — it's exactly the moment we want to seize.
  const greetingTs = 1_000_000
  const result = shouldFireOnboardingPeek({
    greetingTs,
    lastUserAt: greetingTs - 5_000,
    lastAssistantAt: greetingTs, // exactly equal (greeting set it)
  })
  check(
    'lastAssistantAt === greetingTs returns null (the greeting itself is OK)',
    result === null,
    `got ${result}`,
  )
}

console.log('\n[9] pickOnboardingDelayMs — bounded')
{
  check(`rand=0 → MIN (${ONBOARDING_DELAY_MIN_MS})`, pickOnboardingDelayMs(() => 0) === ONBOARDING_DELAY_MIN_MS)
  check(`rand=1 → MAX (${ONBOARDING_DELAY_MAX_MS})`, pickOnboardingDelayMs(() => 1) === ONBOARDING_DELAY_MAX_MS)
  const mid = pickOnboardingDelayMs(() => 0.5)
  check(
    `rand=0.5 lands inside [MIN, MAX]`,
    mid >= ONBOARDING_DELAY_MIN_MS && mid <= ONBOARDING_DELAY_MAX_MS,
    `got ${mid}`,
  )
  // Distribution sanity — 500 samples never escape.
  let escapes = 0
  for (let i = 0; i < 500; i++) {
    const v = pickOnboardingDelayMs()
    if (v < ONBOARDING_DELAY_MIN_MS || v > ONBOARDING_DELAY_MAX_MS) escapes++
  }
  check('500 random samples all bounded', escapes === 0, `${escapes} escapes`)
}

console.log('\n[10] config schema default — onboarding starts unfired')
{
  const base = configSchema.parse({})
  check(
    'configSchema.parse({}).onboarding.firstScreenPeekFired === false',
    base.onboarding.firstScreenPeekFired === false,
    `got ${base.onboarding.firstScreenPeekFired}`,
  )
}

console.log(`\n[done] ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
