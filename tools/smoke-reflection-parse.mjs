/**
 * Smoke for the reflection response parser. Tests every variant of LLM
 * output we've seen: bare array, {"facts":[]} wrapper, fenced code block,
 * preambled prose with embedded JSON, malformed JSON, empty.
 *
 * Run: node tools/smoke-reflection-parse.mjs
 */

import { parseReflectionResponse } from '../src/core/memory/reflection.ts'
// Note: ESM tools script imports a TS file. Run via `node --import tsx`
// or rename to .ts if that path doesn't work. For audit purposes the
// shape of these test cases is what matters.

const cases = [
  {
    name: 'bare array',
    input: '[{"key":"user.name","value":"小李","confidence":0.95}]',
    expectLen: 1,
  },
  {
    name: 'facts wrapper',
    input: '{"facts":[{"key":"user.pet","value":"猫","confidence":0.9}]}',
    expectLen: 1,
  },
  {
    name: 'fenced code',
    input: '```json\n[{"key":"user.job","value":"工程师","confidence":0.8}]\n```',
    expectLen: 1,
  },
  {
    name: 'preamble + array',
    input: '我提取了以下事实：\n[{"key":"user.city","value":"上海","confidence":0.7}]\n希望有用。',
    expectLen: 1,
  },
  {
    name: 'empty array',
    input: '[]',
    expectLen: 0,
  },
  {
    name: 'missing key/value rejected',
    input: '[{"foo":"bar"},{"key":"good","value":"thing","confidence":0.5}]',
    expectLen: 1,
  },
  {
    name: 'completely malformed',
    input: 'no json here at all',
    expectLen: null,
  },
  {
    name: 'invalid confidence defaults to 0.7',
    input: '[{"key":"x","value":"y","confidence":"not-a-number"}]',
    expectLen: 1,
    expectConfidence: 0.7,
  },
  {
    name: 'confidence clamps to 1.0',
    input: '[{"key":"x","value":"y","confidence":1.5}]',
    expectLen: 1,
    expectConfidence: 1.0,
  },
]

let pass = 0
let fail = 0
for (const c of cases) {
  const got = parseReflectionResponse(c.input)
  const gotLen = got === null ? null : got.length
  let ok = gotLen === c.expectLen
  if (ok && c.expectConfidence !== undefined) {
    ok = Math.abs(got[0].confidence - c.expectConfidence) < 0.001
  }
  if (ok) {
    pass++
    console.log(`  ✅ ${c.name}`)
  } else {
    fail++
    console.log(`  ❌ ${c.name} — expected len=${c.expectLen}${c.expectConfidence !== undefined ? ` conf=${c.expectConfidence}` : ''}, got len=${gotLen}${got ? ` conf=${got[0]?.confidence}` : ''}`)
  }
}

console.log(`\n${pass}/${pass + fail} parser cases passed`)
process.exit(fail > 0 ? 1 : 0)
