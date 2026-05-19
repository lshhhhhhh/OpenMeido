#!/usr/bin/env node
/**
 * Smoke test for the pure-logic pieces of notif-host:
 *   - passesAllowlist (substring matching, case-insensitive, empty=allow-all)
 *   - parseDecision (tolerates fenced JSON / preamble / bogus shapes)
 *
 * NOT covered: the PowerShell child process + WinRT subscription — those
 * need a real Windows toast to fire and can't be unit-tested. Run the app,
 * fire a Windows toast (e.g. `New-BurntToastNotification` or just let
 * Slack ping you), and watch [notif] in the dev log.
 *
 * Run with: npm run test:notif-parse
 */
import { passesAllowlist, parseDecision } from '../src/main/notif-utils.ts'

let pass = 0
let fail = 0

function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
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

console.log('\n[passesAllowlist]')
eq('exact match', passesAllowlist('QQ', ['QQ']), true)
eq('case-insensitive', passesAllowlist('qq', ['QQ']), true)
eq('substring match', passesAllowlist('腾讯QQ', ['QQ']), true)
eq('multi-entry, second hits', passesAllowlist('Microsoft Outlook', ['QQ', 'Outlook']), true)
eq('no match', passesAllowlist('Spotify', ['QQ', 'WeChat']), false)
eq('empty list = allow all', passesAllowlist('Anything', []), true)
eq('chinese entry', passesAllowlist('微信', ['微信']), true)
eq('empty string entry filtered out', passesAllowlist('Spotify', ['']), false)
eq('partial chinese substring', passesAllowlist('腾讯微信桌面版', ['微信']), true)

console.log('\n[parseDecision]')
eq(
  'plain JSON object',
  parseDecision('{"should_speak": true, "comment": "主人有人找你", "reason": "QQ消息"}'),
  { shouldSpeak: true, reason: 'QQ消息', comment: '主人有人找你' },
)
eq(
  'should_speak false',
  parseDecision('{"should_speak": false, "reason": "广告"}'),
  { shouldSpeak: false, reason: '广告', comment: '' },
)
eq(
  'fenced json codeblock',
  parseDecision('```json\n{"should_speak": true, "comment": "看到了"}\n```'),
  { shouldSpeak: true, reason: '', comment: '看到了' },
)
eq(
  'bare fenced (no language)',
  parseDecision('```\n{"should_speak": false, "reason": "no signal"}\n```'),
  { shouldSpeak: false, reason: 'no signal', comment: '' },
)
eq(
  'preamble + object',
  parseDecision('Sure, here is the answer:\n{"should_speak": true, "comment": "上钩"}'),
  { shouldSpeak: true, reason: '', comment: '上钩' },
)
eq(
  'missing should_speak → null',
  parseDecision('{"comment": "no decision"}'),
  null,
)
eq(
  'invalid should_speak type → null',
  parseDecision('{"should_speak": "yes"}'),
  null,
)
eq(
  'unparseable garbage → null',
  parseDecision('not json at all'),
  null,
)
eq(
  'empty string → null',
  parseDecision(''),
  null,
)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
