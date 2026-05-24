#!/usr/bin/env node
/**
 * Unit smoke for the Kimi $web_search SSE filter.
 *
 * Verifies filterSseLine drops chunks that only carry a
 * `type: 'builtin_function'` tool_call (which Moonshot emits when
 * the model auto-triggered server-side search), keeps content and
 * normal function tool_call chunks untouched, and surgically
 * removes ONLY the builtin_function entries when they appear
 * alongside other content in the same delta.
 *
 * Pure function test — no LLM, no fetch. Runs in ~20ms.
 *
 * Run: node --import tsx tools/smoke-kimi-search-stream.mjs
 */

import { filterSseLine } from '../src/main/chat/kimi-search-stream.ts'

let pass = 0
let fail = 0
const t = (ok, label, detail = '') => {
  if (ok) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label}`)
    if (detail) console.log(`      ${detail}`)
  }
}

console.log('\n[non-data lines pass through]')
t(filterSseLine('') === '', 'empty string')
t(filterSseLine('event: ping') === 'event: ping', 'non-data event line')
t(filterSseLine(':comment') === ':comment', 'SSE comment line')

console.log('\n[data: [DONE] pass through]')
t(filterSseLine('data: [DONE]') === 'data: [DONE]', '[DONE] sentinel')

console.log('\n[malformed JSON pass through]')
t(
  filterSseLine('data: {not json') === 'data: {not json',
  'invalid JSON returns original line',
)

console.log('\n[content-only chunks pass through untouched]')
{
  const line = 'data: ' + JSON.stringify({ choices: [{ delta: { content: '你好' } }] })
  t(filterSseLine(line) === line, 'content-only chunk unchanged')
}

console.log('\n[normal function tool_call passes through]')
{
  const line =
    'data: ' +
    JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [{ id: 'a', type: 'function', function: { name: 'readFile' } }],
          },
        },
      ],
    })
  t(filterSseLine(line) === line, 'normal function tool_call preserved')
}

console.log('\n[builtin_function-only chunk → dropped]')
{
  const line =
    'data: ' +
    JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              { id: 'srch_1', type: 'builtin_function', function: { name: '$web_search' } },
            ],
          },
        },
      ],
    })
  t(filterSseLine(line) === null, 'returns null (drop whole chunk)')
}

console.log('\n[mixed content + builtin_function → builtin_function stripped]')
{
  const line =
    'data: ' +
    JSON.stringify({
      choices: [
        {
          delta: {
            content: '基于最新搜索结果：',
            tool_calls: [
              { id: 'srch_1', type: 'builtin_function', function: { name: '$web_search' } },
            ],
          },
        },
      ],
    })
  const got = filterSseLine(line)
  t(typeof got === 'string', 'returns string (mutated, not dropped)')
  if (typeof got === 'string') {
    const parsed = JSON.parse(got.slice(6))
    const delta = parsed.choices[0].delta
    t(delta.content === '基于最新搜索结果：', 'content preserved')
    t(delta.tool_calls === undefined, 'empty tool_calls removed')
  }
}

console.log('\n[mixed function + builtin_function tool_calls → only builtin_function stripped]')
{
  const line =
    'data: ' +
    JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              { id: 'a', type: 'function', function: { name: 'readFile' } },
              { id: 'srch_1', type: 'builtin_function', function: { name: '$web_search' } },
              { id: 'b', type: 'function', function: { name: 'readEmail' } },
            ],
          },
        },
      ],
    })
  const got = filterSseLine(line)
  t(typeof got === 'string', 'returns string')
  if (typeof got === 'string') {
    const tcs = JSON.parse(got.slice(6)).choices[0].delta.tool_calls
    t(Array.isArray(tcs) && tcs.length === 2, `2 tool_calls remain (got ${tcs?.length})`)
    t(
      tcs.every((tc) => tc.type === 'function'),
      'remaining tool_calls are all type=function',
    )
  }
}

console.log('\n[finish_reason chunk passes through]')
{
  const line = 'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })
  t(filterSseLine(line) === line, 'finish_reason chunk preserved (even though delta is empty)')
}

console.log('\n[choices without delta → preserved]')
{
  const line = 'data: ' + JSON.stringify({ choices: [{ index: 0 }] })
  t(filterSseLine(line) === line, 'choice without delta passes through')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
