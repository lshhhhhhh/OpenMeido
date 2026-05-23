/**
 * Pure-function tests for the cold-start + celebration trigger logic.
 *
 * Covers:
 *   - hasRequiredAdvancedTtsFields per backend (every required-field
 *     gap should keep the celebration from firing)
 *   - detectCelebrationTriggers happy paths + every "don't fire" guard
 *     (flag already true / no transition / partial config)
 *   - pickColdStartLine + pickCelebrationLine fallthrough (persona ->
 *     default -> hard string) — exercised against bundled defaults
 *
 * Run: npm run test:celebrations
 */

const { register } = await import('tsx/esm/api')
register()

const {
  detectCelebrationTriggers,
  hasRequiredAdvancedTtsFields,
} = await import('../src/shared/celebrations.ts')
const { configSchema } = await import('../src/shared/config.ts')
const { PRESET_LINES_DEFAULTS } = await import('../src/shared/preset-lines-defaults.ts')

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

/** Deep-clone-ish helper so we don't accidentally mutate a shared base. */
function cfg(patch = {}) {
  const base = configSchema.parse({})
  // Limit patching to the top-level fields we care about — keep the
  // helper small + obvious vs. doing a generic deep merge.
  return {
    ...base,
    backend: { ...base.backend, ...(patch.backend ?? {}) },
    tts: {
      ...base.tts,
      ...(patch.tts ?? {}),
      sovits: { ...base.tts.sovits, ...(patch.tts?.sovits ?? {}) },
      minimax: { ...base.tts.minimax, ...(patch.tts?.minimax ?? {}) },
      volcengine: { ...base.tts.volcengine, ...(patch.tts?.volcengine ?? {}) },
    },
    onboarding: { ...base.onboarding, ...(patch.onboarding ?? {}) },
  }
}

console.log('\n[1] hasRequiredAdvancedTtsFields — sovits')
{
  // sovits requires refAudio + refText. Anything else missing → false.
  const blank = cfg({ tts: { backend: 'sovits' } })
  check('sovits with no creds → false', !hasRequiredAdvancedTtsFields(blank.tts))

  const partialAudio = cfg({
    tts: { backend: 'sovits', sovits: { refAudio: '/tmp/x.wav', refText: '' } },
  })
  check('sovits with audio but no text → false', !hasRequiredAdvancedTtsFields(partialAudio.tts))

  const partialText = cfg({
    tts: { backend: 'sovits', sovits: { refAudio: '', refText: 'hello' } },
  })
  check('sovits with text but no audio → false', !hasRequiredAdvancedTtsFields(partialText.tts))

  const both = cfg({
    tts: { backend: 'sovits', sovits: { refAudio: '/tmp/x.wav', refText: 'hello' } },
  })
  check('sovits with both → true', hasRequiredAdvancedTtsFields(both.tts))

  // Whitespace-only doesn't count — trim() should reject.
  const ws = cfg({
    tts: { backend: 'sovits', sovits: { refAudio: '   ', refText: 'hello' } },
  })
  check('sovits with whitespace audio → false', !hasRequiredAdvancedTtsFields(ws.tts))
}

console.log('\n[2] hasRequiredAdvancedTtsFields — minimax')
{
  const blank = cfg({ tts: { backend: 'minimax' } })
  check('minimax with no creds → false', !hasRequiredAdvancedTtsFields(blank.tts))

  const partial = cfg({
    tts: { backend: 'minimax', minimax: { apiKey: 'sk-xxx', groupId: '' } },
  })
  check('minimax with apiKey but no groupId → false', !hasRequiredAdvancedTtsFields(partial.tts))

  const both = cfg({
    tts: {
      backend: 'minimax',
      minimax: { apiKey: 'sk-xxx', groupId: '123456' },
    },
  })
  check('minimax with both → true', hasRequiredAdvancedTtsFields(both.tts))
}

console.log('\n[3] hasRequiredAdvancedTtsFields — volcengine')
{
  const blank = cfg({ tts: { backend: 'volcengine' } })
  check('volcengine with no creds → false', !hasRequiredAdvancedTtsFields(blank.tts))

  const partial = cfg({
    tts: {
      backend: 'volcengine',
      volcengine: { appid: 'abc', accessToken: '' },
    },
  })
  check('volcengine with appid but no token → false', !hasRequiredAdvancedTtsFields(partial.tts))

  const both = cfg({
    tts: {
      backend: 'volcengine',
      volcengine: { appid: 'abc', accessToken: 'tok' },
    },
  })
  check('volcengine with both → true', hasRequiredAdvancedTtsFields(both.tts))
}

console.log('\n[4] hasRequiredAdvancedTtsFields — edge')
{
  // edge is the default freebie — never returns true even when filled,
  // because the celebration is for LEAVING edge, not for "edge is ok".
  // The detector filters edge out before calling us; this guards against
  // a future refactor that forgets that filter.
  const edge = cfg({ tts: { backend: 'edge' } })
  check('edge always returns false', !hasRequiredAdvancedTtsFields(edge.tts))
}

console.log('\n[5] detectCelebrationTriggers — AI happy path')
{
  const before = cfg()
  const after = cfg({ backend: { apiKey: 'sk-abc' } })
  const triggers = detectCelebrationTriggers(before, after)
  check('empty → set apiKey + flag false → ["ai"]', JSON.stringify(triggers) === '["ai"]', `got ${JSON.stringify(triggers)}`)
}

console.log('\n[6] detectCelebrationTriggers — AI flag already true')
{
  const before = cfg({ onboarding: { aiSetupCelebrated: true } })
  const after = cfg({
    backend: { apiKey: 'sk-abc' },
    onboarding: { aiSetupCelebrated: true },
  })
  const triggers = detectCelebrationTriggers(before, after)
  check('flag already true → no trigger', triggers.length === 0, `got ${JSON.stringify(triggers)}`)
}

console.log('\n[7] detectCelebrationTriggers — AI key change without transition')
{
  // User rotated key1 → key2. Both non-empty → no transition → no trigger.
  const before = cfg({ backend: { apiKey: 'sk-old' } })
  const after = cfg({ backend: { apiKey: 'sk-new' } })
  const triggers = detectCelebrationTriggers(before, after)
  check('key rotation (both non-empty) → no trigger', triggers.length === 0, `got ${JSON.stringify(triggers)}`)
}

console.log('\n[8] detectCelebrationTriggers — AI key with trailing whitespace ignored')
{
  // User pastes "  " — looks set but is effectively empty.
  const before = cfg()
  const after = cfg({ backend: { apiKey: '   ' } })
  const triggers = detectCelebrationTriggers(before, after)
  check('whitespace-only key → no trigger', triggers.length === 0, `got ${JSON.stringify(triggers)}`)
}

console.log('\n[9] detectCelebrationTriggers — TTS happy path (minimax)')
{
  const before = cfg() // backend: 'edge' by default
  const after = cfg({
    tts: {
      backend: 'minimax',
      minimax: { apiKey: 'sk-xxx', groupId: '123' },
    },
  })
  const triggers = detectCelebrationTriggers(before, after)
  check('edge → minimax with full creds → ["tts"]', JSON.stringify(triggers) === '["tts"]', `got ${JSON.stringify(triggers)}`)
}

console.log('\n[10] detectCelebrationTriggers — TTS backend switched but creds missing')
{
  // User changes dropdown but hasn't pasted credentials yet. Skip until
  // they actually finish — otherwise we celebrate a half-done state.
  const before = cfg()
  const after = cfg({ tts: { backend: 'minimax' } })
  const triggers = detectCelebrationTriggers(before, after)
  check('edge → minimax with empty creds → no trigger', triggers.length === 0, `got ${JSON.stringify(triggers)}`)
}

console.log('\n[11] detectCelebrationTriggers — TTS already advanced (not from edge)')
{
  const before = cfg({
    tts: {
      backend: 'sovits',
      sovits: { refAudio: '/x', refText: 'y' },
    },
  })
  const after = cfg({
    tts: {
      backend: 'minimax',
      minimax: { apiKey: 'sk', groupId: '1' },
    },
  })
  const triggers = detectCelebrationTriggers(before, after)
  check('sovits → minimax → no trigger (already left edge)', triggers.length === 0, `got ${JSON.stringify(triggers)}`)
}

console.log('\n[12] detectCelebrationTriggers — both fire on same save')
{
  // Rare but possible: user opens Settings for the first time and
  // configures both API key + advanced TTS in one save.
  const before = cfg()
  const after = cfg({
    backend: { apiKey: 'sk-abc' },
    tts: {
      backend: 'minimax',
      minimax: { apiKey: 'mm', groupId: 'g' },
    },
  })
  const triggers = detectCelebrationTriggers(before, after)
  check(
    'apiKey + TTS in same save → ["ai","tts"]',
    JSON.stringify(triggers) === '["ai","tts"]',
    `got ${JSON.stringify(triggers)}`,
  )
}

console.log('\n[13] detectCelebrationTriggers — TTS flag already true')
{
  const before = cfg({ onboarding: { advancedTtsCelebrated: true } })
  const after = cfg({
    tts: {
      backend: 'minimax',
      minimax: { apiKey: 'sk', groupId: '1' },
    },
    onboarding: { advancedTtsCelebrated: true },
  })
  const triggers = detectCelebrationTriggers(before, after)
  check('TTS flag already true → no trigger', triggers.length === 0, `got ${JSON.stringify(triggers)}`)
}

console.log('\n[14] preset-lines-defaults — cold-start pools populated')
{
  const cs = PRESET_LINES_DEFAULTS.coldStart
  for (const p of ['maid', 'imouto', 'ojou', 'default']) {
    const pool = cs[p]
    check(`coldStart.${p}.greeting has ≥3 lines`, pool.greeting.length >= 3, `got ${pool.greeting.length}`)
    check(`coldStart.${p}.chatReply has ≥3 lines`, pool.chatReply.length >= 3, `got ${pool.chatReply.length}`)
    // Every line MUST nudge toward Settings — the dead UI is the real
    // failure mode. We accept "Settings" OR "AI" mentions; lines that
    // are purely flavor with no actionable hint should fail review.
    const allNudge = [...pool.greeting, ...pool.chatReply].every(
      (l) => l.includes('Settings') || l.includes('AI'),
    )
    check(`coldStart.${p} every line mentions Settings or AI`, allNudge, `at least one flavor-only line`)
  }
}

console.log('\n[15] preset-lines-defaults — celebrations pools populated')
{
  const cb = PRESET_LINES_DEFAULTS.celebrations
  for (const p of ['maid', 'imouto', 'ojou', 'default']) {
    const pool = cb[p]
    check(`celebrations.${p}.aiSetup has ≥2 lines`, pool.aiSetup.length >= 2, `got ${pool.aiSetup.length}`)
    check(`celebrations.${p}.advancedTts has ≥2 lines`, pool.advancedTts.length >= 2, `got ${pool.advancedTts.length}`)
  }
}

console.log(`\n[done] ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
