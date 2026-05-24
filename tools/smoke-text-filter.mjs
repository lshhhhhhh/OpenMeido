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
 * Feed `input` to a fresh filter in 1-3 char chunks and play back the
 * caller-side reduction the chat loop performs: append `emit`, but FIRST
 * truncate `resetLength` chars when present. Returns the final visible
 * accumulator string after flush.
 */
function streamThrough(input, opts = {}) {
  const f = createTextDeltaFilter()
  let acc = ''
  const apply = (o) => {
    if (o.resetLength && o.resetLength > 0) acc = acc.slice(0, -o.resetLength)
    if (o.emit) acc += o.emit
  }
  let i = 0
  while (i < input.length) {
    const n = 1 + (i % 3)
    apply(f.process(input.slice(i, i + n)))
    i += n
  }
  apply(f.flush())
  return acc
}

/**
 * Drives the filter with two text segments separated by a checkpoint —
 * mirrors what the chat loop does when a tool-call event arrives between
 * two text-delta segments. After the checkpoint, an implicit `</think>`
 * only rolls back text emitted SINCE the checkpoint.
 */
function streamTwoSegmentsWithCheckpoint(seg1, seg2) {
  const f = createTextDeltaFilter()
  let acc = ''
  const apply = (o) => {
    if (o.resetLength && o.resetLength > 0) acc = acc.slice(0, -o.resetLength)
    if (o.emit) acc += o.emit
  }
  const feed = (s) => {
    let i = 0
    while (i < s.length) {
      const n = 1 + (i % 3)
      apply(f.process(s.slice(i, i + n)))
      i += n
    }
  }
  feed(seg1)
  f.checkpoint()
  feed(seg2)
  apply(f.flush())
  return acc
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

console.log('\n[implicit </think> close — the GLM/Qwen3 thinking-mode bug]')
eq(
  'bare close discards prefix',
  streamThrough('好的，主人，我看看邮件。</think>主人，这是你的邮件。'),
  '主人，这是你的邮件。',
)
eq(
  'bare close at very start (no prefix)',
  streamThrough('</think>主人，邮件如下。'),
  '主人，邮件如下。',
)
eq(
  'bare </thinking> variant',
  streamThrough('计划：先列邮件再读 WWDC。</thinking>好的，主人。'),
  '好的，主人。',
)
eq(
  'screenshot repro — duplicated content with one </think>',
  streamThrough(
    '好的，主人，我这就帮您查看最近的邮件。\n\n主人，这是最近收到的五封邮件。 </think>好的，主人，我这就帮您查看最近的邮件。\n\n主人，这是最近收到的五封邮件。',
  ),
  '好的，主人，我这就帮您查看最近的邮件。\n\n主人，这是最近收到的五封邮件。',
)

console.log('\n[checkpoint semantics — step-2 reset must not wipe step-1]')
eq(
  'checkpoint protects prior step content',
  streamTwoSegmentsWithCheckpoint('你好', 'thinking...</think>答复'),
  '你好答复',
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

console.log('\n[orphan trailing backticks — model started a fence but never closed]')
eq(
  'reply ending in 3 backticks (incomplete fence opener)',
  streamThrough('好的主人，明白了。```'),
  '好的主人，明白了。',
)
eq(
  'reply ending in 2 backticks',
  streamThrough('好的主人，明白了。``'),
  '好的主人，明白了。',
)
eq(
  // The space between "。" and "```" is already emitted by the time the
  // filter sees the backtick run start (streaming holds back trailing
  // backticks but can't retroactively un-emit the space before them).
  // Acceptable: user sees an invisible trailing space, not the visually
  // obvious "```". cleanInlineText's .trim() handles the persisted form.
  'reply ending in 3 backticks + whitespace (preserves pre-backtick space)',
  streamThrough('好的，主人。 ```  '),
  '好的，主人。 ',
)
eq(
  'reply ending in 5 backticks',
  streamThrough('记下了。`````'),
  '记下了。',
)
eq(
  'single trailing backtick preserved (intentional inline-code marker)',
  streamThrough('use the ` key'),
  'use the ` key',
)
eq(
  'closed inline-code with single backticks at end preserved',
  streamThrough('试试 `foo` 函数'),
  '试试 `foo` 函数',
)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
