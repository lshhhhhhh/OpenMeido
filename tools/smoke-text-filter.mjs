#!/usr/bin/env node
/**
 * Smoke test for the text-delta filter that strips <think> blocks + leaked
 * tool-call XML from the user-visible chat stream.
 *
 * Critical case: filter must be streaming-aware — open/close tags can
 * straddle delta boundaries. We feed each test input as a sequence of
 * 1-3 char chunks to simulate worst-case streaming.
 *
 * Run: npm run test:text-filter
 */
import { createTextDeltaFilter } from '../src/main/chat-text-filter.ts'

let pass = 0
let fail = 0

function eq(label, got, want) {
  const ok = got === want
  if (ok) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label}`)
    console.log(`      got:  ${JSON.stringify(got)}`)
    console.log(`      want: ${JSON.stringify(want)}`)
  }
}

/**
 * Feed `input` to a fresh filter in 1-3 char chunks, return concatenated
 * output + flush.
 */
function streamThrough(input) {
  const f = createTextDeltaFilter()
  let out = ''
  let i = 0
  while (i < input.length) {
    const n = 1 + (i % 3)
    out += f.process(input.slice(i, i + n))
    i += n
  }
  out += f.flush()
  return out
}

console.log('\n[plain pass-through]')
eq('no special tags', streamThrough('好的，主人。'), '好的，主人。')
eq('punctuation only', streamThrough('!@#$%^&*()'), '!@#$%^&*()')

console.log('\n[<think> blocks]')
eq(
  'single complete block',
  streamThrough('好的<think>我需要思考</think>主人'),
  '好的主人',
)
eq(
  'block at start',
  streamThrough('<think>plan: call tool</think>提醒已设置'),
  '提醒已设置',
)
eq(
  'block at end',
  streamThrough('提醒已设置<think>done</think>'),
  '提醒已设置',
)
eq(
  'unmatched open at end (drop content)',
  streamThrough('好的<think>internal still talking'),
  '好的',
)
eq(
  'multiple blocks',
  streamThrough('a<think>x</think>b<think>y</think>c'),
  'abc',
)

console.log('\n[leaked tool-call XML]')
eq(
  'standalone tags',
  streamThrough('<tool_call>setReminder</tool_call>好的'),
  '好的',
)
eq(
  'arg tags inside narration',
  streamThrough('<arg_key>limit</arg_key><arg_value>10</arg_value>设置完毕'),
  '设置完毕',
)
eq(
  'fenced html block (the exact bug from screenshot)',
  streamThrough(
    '我会帮您查看最近的邮件。\n```html\n<think>listRecentEmails\n<arg_key>limit</arg_key>\n<arg_value>10</arg_value>\n</tool_call>\n```',
  ),
  '我会帮您查看最近的邮件。\n',
)

console.log('\n[combined]')
eq(
  'think + arg leak together',
  streamThrough('<think>plan</think>好的<arg_key>x</arg_key>'),
  '好的',
)

console.log('\n[edge cases]')
eq('empty input', streamThrough(''), '')
eq(
  'almost-think (partial match, no <)',
  streamThrough('think>not a tag'),
  'think>not a tag',
)
eq(
  'angle bracket text without tag name',
  streamThrough('a < b > c'),
  'a < b > c',
)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
