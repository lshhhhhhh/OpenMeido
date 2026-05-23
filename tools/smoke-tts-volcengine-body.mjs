/**
 * Unit test for 火山引擎 大模型语音合成 request shape.
 *
 * The single thing most likely to break this provider is the literal
 * `Bearer;<token>` auth header (with the semicolon, not a space). This
 * test pins it explicitly so a well-meaning future refactor that
 * "fixes" the space won't silently break TTS for everyone.
 *
 * Also pins the app/user/audio/request body shape against the docs.
 *
 * Run: npm run test:tts-volcengine-body
 */

const { register } = await import('tsx/esm/api')
register()

const { buildVolcengineRequest } = await import('../src/main/tts/volcengine.ts')

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
  baseUrl: '',
  appid: 'app_test_123',
  accessToken: 'tok_test_xyz',
  bodyToken: '',
  cluster: 'volcano_tts',
  voiceType: 'BV700_streaming',
  speedRatio: 1.0,
}

console.log('\n[1] default request shape (大模型/豆包 cluster)')
{
  const req = buildVolcengineRequest('你好世界', baseCfg, { reqid: 'req-fixed-uuid' })
  check(
    'URL is openspeech.bytedance.com/api/v1/tts',
    req.url === 'https://openspeech.bytedance.com/api/v1/tts',
    `got ${req.url}`,
  )
  check(
    'Authorization header uses LITERAL "Bearer;<token>" (semicolon, no space)',
    req.headers.Authorization === 'Bearer;tok_test_xyz',
    `got ${JSON.stringify(req.headers.Authorization)}`,
  )
  check('Content-Type is JSON', req.headers['Content-Type'] === 'application/json')
  check('body.app.appid set', req.body.app.appid === 'app_test_123')
  check(
    'body.app.token defaults to accessToken when bodyToken empty',
    req.body.app.token === 'tok_test_xyz',
  )
  check('body.app.cluster is volcano_tts', req.body.app.cluster === 'volcano_tts')
  check('body.user.uid is "openmeido"', req.body.user.uid === 'openmeido')
  check(
    'body.audio.voice_type is BV700_streaming',
    req.body.audio.voice_type === 'BV700_streaming',
  )
  check('body.audio.encoding is mp3', req.body.audio.encoding === 'mp3')
  check('body.audio.speed_ratio is 1.0', req.body.audio.speed_ratio === 1.0)
  check(
    'body.request carries reqid + text + operation=query',
    req.body.request.reqid === 'req-fixed-uuid' &&
      req.body.request.text === '你好世界' &&
      req.body.request.text_type === 'plain' &&
      req.body.request.operation === 'query',
  )
}

console.log('\n[2] bodyToken override (rare account split)')
{
  const req = buildVolcengineRequest('hi', { ...baseCfg, bodyToken: 'separate_body_tok' })
  check(
    'header still uses accessToken (NOT bodyToken)',
    req.headers.Authorization === 'Bearer;tok_test_xyz',
    `got ${req.headers.Authorization}`,
  )
  check(
    'body.app.token uses bodyToken when set',
    req.body.app.token === 'separate_body_tok',
  )
}

console.log('\n[3] reqid auto-generates a UUID when not given')
{
  const req = buildVolcengineRequest('x', baseCfg)
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  check(
    'reqid matches UUID v4 shape',
    uuidRe.test(req.body.request.reqid),
    `got ${req.body.request.reqid}`,
  )
}

console.log('\n[4] custom baseUrl override')
{
  const req = buildVolcengineRequest('x', {
    ...baseCfg,
    baseUrl: 'https://openspeech-internal.example.com',
  })
  check(
    'override host wins',
    req.url === 'https://openspeech-internal.example.com/api/v1/tts',
    `got ${req.url}`,
  )
}

console.log('\n[5] alternate cluster (volcano_icl for 声音复刻)')
{
  const req = buildVolcengineRequest('x', {
    ...baseCfg,
    cluster: 'volcano_icl',
    voiceType: 'S_custom_cloned_voice',
  })
  check('body.app.cluster passes through', req.body.app.cluster === 'volcano_icl')
  check('custom voice_type passes through', req.body.audio.voice_type === 'S_custom_cloned_voice')
}

console.log('\n[6] required-field validation')
{
  try {
    buildVolcengineRequest('x', { ...baseCfg, appid: '' })
    check('empty appid throws', false, 'no throw')
  } catch (err) {
    check('empty appid throws', /appid/.test(String(err.message)))
  }
  try {
    buildVolcengineRequest('x', { ...baseCfg, accessToken: '' })
    check('empty accessToken throws', false, 'no throw')
  } catch (err) {
    check('empty accessToken throws', /token/.test(String(err.message)))
  }
  try {
    buildVolcengineRequest('x', { ...baseCfg, voiceType: '   ' })
    check('blank voiceType throws', false, 'no throw')
  } catch (err) {
    check('blank voiceType throws', /voice_type|音色/.test(String(err.message)))
  }
  try {
    buildVolcengineRequest('x', { ...baseCfg, cluster: '' })
    check('empty cluster throws', false, 'no throw')
  } catch (err) {
    check('empty cluster throws', /cluster/.test(String(err.message)))
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
