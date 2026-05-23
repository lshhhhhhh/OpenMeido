/**
 * Integration test for MiniMax adapter's RESPONSE handling.
 *
 * smoke-tts-minimax-body pins the OUTBOUND request shape;
 * this one pins the INBOUND decode path:
 *   - hex-encoded audio bytes → base64 (the trickiest piece — every
 *     other provider sends base64, MiniMax sends hex)
 *   - base_resp.status_code != 0 → throw with the server's message
 *   - missing data.audio → throw with a useful hint
 *   - empty buffer → throw
 *
 * Uses a global-fetch monkey-patch so no real network call happens.
 *
 * Run: npm run test:tts-minimax-decode
 */

const { register } = await import('tsx/esm/api')
register()

const { synthesizeMinimax } = await import('../src/main/tts/minimax.ts')

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
  groupId: 'group_test',
  model: 'speech-02-hd',
  voiceId: 'female-shaonv',
  speed: 1.0,
  volume: 1.0,
  pitch: 0,
}

// Helper: install a fake fetch that returns a canned response, then
// restore the original. Returns whatever the call (or throw) produced.
const realFetch = globalThis.fetch
async function withFakeFetch(response, body, cfg = baseCfg) {
  globalThis.fetch = async () => response
  try {
    return { result: await synthesizeMinimax(body, cfg), err: null }
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

console.log('\n[1] success path: hex audio → base64 mp3')
{
  // Known bytes: [0xff, 0xfa, 0x90, 0x44, 0x00] — first 5 bytes of a real
  // mp3 header. Encoded as hex string MiniMax-style.
  const realBytes = Buffer.from([0xff, 0xfa, 0x90, 0x44, 0x00, 0x01, 0x02, 0x03])
  const hexAudio = realBytes.toString('hex')
  const { result, err } = await withFakeFetch(
    jsonResponse({
      data: { audio: hexAudio, status: 2 },
      base_resp: { status_code: 0, status_msg: 'success' },
    }),
    '你好世界',
  )
  check('no error thrown', err === null, err ? String(err.message) : '')
  check('returns object with base64 + mimeType', result && typeof result.base64 === 'string' && typeof result.mimeType === 'string')
  check('mimeType is audio/mpeg', result?.mimeType === 'audio/mpeg')
  check(
    'base64 round-trips back to the original bytes (hex was decoded correctly)',
    Buffer.from(result?.base64 ?? '', 'base64').equals(realBytes),
  )
}

console.log('\n[2] hex with whitespace / commas is still decoded')
{
  const realBytes = Buffer.from([0xff, 0xab, 0xcd])
  const messyHex = 'ff , ab\n cd  '
  const { result, err } = await withFakeFetch(
    jsonResponse({
      data: { audio: messyHex, status: 2 },
      base_resp: { status_code: 0 },
    }),
    'x',
  )
  check('messy hex decodes without error', err === null, err ? String(err.message) : '')
  check('messy hex decodes to expected bytes', Buffer.from(result?.base64 ?? '', 'base64').equals(realBytes))
}

console.log('\n[3] business error (base_resp.status_code != 0) throws with message')
{
  const { result, err } = await withFakeFetch(
    jsonResponse({
      base_resp: { status_code: 1004, status_msg: 'authentication failed' },
    }),
    'x',
  )
  check('no result returned', result === null)
  check('error thrown', err !== null)
  check('error mentions business status code', err && /1004/.test(String(err.message)), `got "${err?.message}"`)
  check('error mentions server status_msg', err && /authentication failed/.test(String(err.message)))
}

console.log('\n[4] missing data.audio throws a useful error')
{
  const { err } = await withFakeFetch(
    jsonResponse({
      data: { status: 2 }, // no audio
      base_resp: { status_code: 0 },
    }),
    'x',
  )
  check('error thrown', err !== null)
  check(
    'error hints about voice_id / model',
    err && /data\.audio|voice_id|model/.test(String(err.message)),
    `got "${err?.message}"`,
  )
}

console.log('\n[5] HTTP non-200 surfaces server body in error')
{
  const { err } = await withFakeFetch(
    new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }),
    'x',
  )
  check('error thrown on HTTP 401', err !== null)
  check('error mentions HTTP status', err && /401/.test(String(err.message)), `got "${err?.message}"`)
}

console.log('\n[6] empty hex audio throws (not a silent success)')
{
  const { err } = await withFakeFetch(
    jsonResponse({
      data: { audio: '', status: 2 },
      base_resp: { status_code: 0 },
    }),
    'x',
  )
  check('error thrown on empty audio', err !== null)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
