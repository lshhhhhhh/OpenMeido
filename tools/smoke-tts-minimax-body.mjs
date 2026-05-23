/**
 * Unit test for MiniMax T2A v2 request shape.
 *
 * No live API call — we only verify `buildMinimaxRequest` produces the URL
 * + headers + body the docs specify. This catches the easy regressions:
 * wrong endpoint per region, missing GroupId query, malformed
 * voice_setting / audio_setting, accidentally renaming `Bearer ` to
 * something else.
 *
 * Run: npm run test:tts-minimax-body
 */

const { register } = await import('tsx/esm/api')
register()

const { buildMinimaxRequest } = await import('../src/main/tts/minimax.ts')

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

const baseCfg = {
  region: 'cn',
  baseUrl: '',
  apiKey: 'mm-test-key',
  groupId: 'group_1234567890',
  model: 'speech-02-hd',
  voiceId: 'female-shaonv',
  speed: 1.0,
  volume: 1.0,
  pitch: 0,
}

console.log('\n[1] mainland (region=cn) request shape')
{
  const req = buildMinimaxRequest('你好世界', baseCfg)
  check(
    'URL points at api.minimaxi.com',
    req.url.startsWith('https://api.minimaxi.com/v1/t2a_v2'),
    `got ${req.url}`,
  )
  check(
    'URL carries GroupId query param',
    req.url.includes(`GroupId=${baseCfg.groupId}`),
    `got ${req.url}`,
  )
  check(
    'Authorization header is "Bearer <key>" with space',
    req.headers.Authorization === `Bearer ${baseCfg.apiKey}`,
    `got ${req.headers.Authorization}`,
  )
  check('Content-Type header is JSON', req.headers['Content-Type'] === 'application/json')
  check('body.model is speech-02-hd', req.body.model === 'speech-02-hd')
  check('body.text is the input', req.body.text === '你好世界')
  check('body.stream is false (non-streaming)', req.body.stream === false)
  check(
    'body.voice_setting.voice_id is the preset',
    req.body.voice_setting.voice_id === 'female-shaonv',
  )
  check(
    'body.voice_setting carries speed/vol/pitch',
    req.body.voice_setting.speed === 1.0 &&
      req.body.voice_setting.vol === 1.0 &&
      req.body.voice_setting.pitch === 0,
  )
  check(
    'body.audio_setting requests mp3 mono 32kHz',
    req.body.audio_setting.format === 'mp3' &&
      req.body.audio_setting.channel === 1 &&
      req.body.audio_setting.sample_rate === 32000,
  )
}

console.log('\n[2] global (region=global) routes to api.minimax.io')
{
  const req = buildMinimaxRequest('hello', { ...baseCfg, region: 'global' })
  check(
    'URL points at api.minimax.io',
    req.url.startsWith('https://api.minimax.io/v1/t2a_v2'),
    `got ${req.url}`,
  )
}

console.log('\n[3] explicit baseUrl override beats region default')
{
  const req = buildMinimaxRequest('hi', {
    ...baseCfg,
    region: 'cn',
    baseUrl: 'https://api.minimax.chat',
  })
  check(
    'override host wins over region default',
    req.url.startsWith('https://api.minimax.chat/v1/t2a_v2'),
    `got ${req.url}`,
  )
}

console.log('\n[4] required-field validation')
{
  try {
    buildMinimaxRequest('x', { ...baseCfg, apiKey: '' })
    check('empty apiKey throws', false, 'no throw')
  } catch (err) {
    check('empty apiKey throws', /API key/.test(String(err.message)))
  }
  try {
    buildMinimaxRequest('x', { ...baseCfg, groupId: '' })
    check('empty groupId throws', false, 'no throw')
  } catch (err) {
    check('empty groupId throws', /GroupId/.test(String(err.message)))
  }
  try {
    buildMinimaxRequest('x', { ...baseCfg, voiceId: '   ' })
    check('blank voiceId throws', false, 'no throw')
  } catch (err) {
    check('blank voiceId throws', /voice_id|音色/.test(String(err.message)))
  }
}

console.log('\n[5] custom voice_id (clone) flows through unchanged')
{
  const req = buildMinimaxRequest('x', {
    ...baseCfg,
    voiceId: 'cloned_user_voice_abc123',
  })
  check(
    'custom voice_id survives builder',
    req.body.voice_setting.voice_id === 'cloned_user_voice_abc123',
  )
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
