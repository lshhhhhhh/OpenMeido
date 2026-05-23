/**
 * Integration test for 火山引擎 adapter's RESPONSE handling.
 *
 * Counterpart to smoke-tts-volcengine-body — pins the inbound decode
 * path:
 *   - top-level `data` is base64 audio → renderer-ready base64 + mp3 mime
 *   - code != 3000 is a business error (ByteDance returns HTTP 200 even
 *     for "appid is bad", relying on the body code to signal trouble)
 *   - missing data field → throw
 *   - empty audio → throw
 *
 * Uses a global-fetch monkey-patch so no real network call happens.
 *
 * Run: npm run test:tts-volcengine-decode
 */

const { register } = await import('tsx/esm/api')
register()

const { synthesizeVolcengine } = await import('../src/main/tts/volcengine.ts')

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
  appid: 'app_test',
  accessToken: 'tok_test',
  bodyToken: '',
  cluster: 'volcano_tts',
  voiceType: 'BV700_streaming',
  speedRatio: 1.0,
}

const realFetch = globalThis.fetch
async function withFakeFetch(response, body, cfg = baseCfg) {
  globalThis.fetch = async () => response
  try {
    return { result: await synthesizeVolcengine(body, cfg), err: null }
  } catch (err) {
    return { result: null, err }
  } finally {
    globalThis.fetch = realFetch
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

console.log('\n[1] success path (code=3000 + base64 audio)')
{
  const realBytes = Buffer.from([0xff, 0xfa, 0x90, 0x44, 0x00, 0xde, 0xad, 0xbe, 0xef])
  const b64Audio = realBytes.toString('base64')
  const { result, err } = await withFakeFetch(
    jsonResponse({
      reqid: 'fake-uuid',
      code: 3000,
      operation: 'query',
      message: 'Success',
      sequence: -1,
      data: b64Audio,
    }),
    '你好',
  )
  check('no error thrown', err === null, err ? String(err.message) : '')
  check('mimeType is audio/mpeg', result?.mimeType === 'audio/mpeg')
  check(
    'output base64 decodes back to the same bytes the server sent',
    Buffer.from(result?.base64 ?? '', 'base64').equals(realBytes),
  )
}

console.log('\n[2] business error (code != 3000, HTTP still 200)')
{
  // Real failure mode: ByteDance returns HTTP 200 + code=4001 "invalid
  // request param" when appid + cluster don't match. We must NOT treat
  // this as success or the renderer plays a garbled JSON-string-as-audio.
  const { result, err } = await withFakeFetch(
    jsonResponse({
      reqid: 'fake-uuid',
      code: 4001,
      message: 'invalid voice_type for cluster volcano_tts',
    }),
    'x',
  )
  check('no result returned', result === null)
  check('error thrown', err !== null)
  check('error mentions code', err && /4001/.test(String(err.message)), `got "${err?.message}"`)
  check(
    'error mentions server message',
    err && /invalid voice_type/.test(String(err.message)),
  )
}

console.log('\n[3] missing data field → throw with useful hint')
{
  const { err } = await withFakeFetch(
    jsonResponse({ reqid: 'x', code: 3000, message: 'Success' }),
    'x',
  )
  check('error thrown', err !== null)
  check(
    'error mentions data / cluster / voice_type',
    err && /(data|cluster|voice_type)/.test(String(err.message)),
    `got "${err?.message}"`,
  )
}

console.log('\n[4] HTTP non-200 surfaces in error')
{
  const { err } = await withFakeFetch(
    new Response('Forbidden', { status: 403, statusText: 'Forbidden' }),
    'x',
  )
  check('error thrown on HTTP 403', err !== null)
  check('error mentions 403', err && /403/.test(String(err.message)), `got "${err?.message}"`)
}

console.log('\n[5] empty base64 audio → throw (not silent success)')
{
  const { err } = await withFakeFetch(
    jsonResponse({ reqid: 'x', code: 3000, data: '' }),
    'x',
  )
  check('error thrown on empty audio', err !== null)
}

console.log('\n[6] code field absent → treated as success (legacy / partial response shapes)')
{
  // Some ByteDance regions/products don't set `code` at all on success.
  // Adapter should not throw — only non-3000 numeric codes should fail.
  const realBytes = Buffer.from([0xff, 0xfa])
  const b64 = realBytes.toString('base64')
  const { result, err } = await withFakeFetch(
    jsonResponse({ reqid: 'x', data: b64 }),
    'x',
  )
  check('no error when code field absent + data present', err === null, err ? String(err.message) : '')
  check('audio decoded', Buffer.from(result?.base64 ?? '', 'base64').equals(realBytes))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
