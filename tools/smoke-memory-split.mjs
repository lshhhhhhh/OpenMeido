#!/usr/bin/env node
/**
 * Real-agent smoke test for the dual-track memory split.
 *
 * Scenario: user alternates between PERSONAL chat ("聊养猫") and WORK
 * tasks ("总结邮件 / 跟进 Project-A1"). After each track's reflection
 * runs, verify:
 *
 *   1. Personal reflection picks up name / pet / hobby — and NOTHING
 *      project-coded.
 *   2. Work reflection picks up project / ticket / email context — and
 *      NOTHING personal.
 *   3. Cross-contamination check: keys extracted by personal don't
 *      start with `project.` / `email.` / `task.`; keys extracted by
 *      work don't start with `user.profile.` / `user.pets.` /
 *      `user.hobbies.`.
 *
 * No real Electron, no real chat loop — exercises just reflection.ts
 * against DeepSeek with hand-crafted episode windows that mimic what
 * the chat persister would have stored.
 *
 * Run: node --env-file=.env --import tsx tools/smoke-memory-split.mjs
 */

import { generateText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'

import { reflect } from '../src/core/memory/reflection.ts'

const apiKey = process.env.DEEPSEEK_API_KEY
if (!apiKey) {
  console.error('DEEPSEEK_API_KEY not set in .env')
  process.exit(1)
}

const openai = createOpenAI({
  baseURL: 'https://api.deepseek.com/v1',
  apiKey,
})
const model = openai.chat('deepseek-v4-flash')

/** ReflectionExtractor adapter that uses DeepSeek. */
const extract = async (prompt) => {
  const { text } = await generateText({ model, prompt, temperature: 0.2 })
  return text
}

// ---------- Fixtures ----------

// Mimics what addEpisode would persist over a mixed conversation:
//   turn 1: user → personal chat
//   turn 2: assistant → reply
//   turn 3: user → work task
//   turn 4: assistant → tool calls
//   turn 5: tool → results
//   turn 6: assistant → summary
//   turn 7: user → personal chat
//   ... and so on
// Episode shape matches src/core/memory/types.ts so reflection sees
// realistic inputs.
let nextId = 1
const mk = (speaker, text, toolParts) => ({
  id: nextId++,
  ts: new Date().toISOString(),
  speaker,
  text,
  sessionId: 't',
  toolParts,
})

const allEpisodes = [
  // ─── chat: name + pet ───
  mk('user', '我叫小李，养了一只橘猫叫阿黄'),
  mk(
    'assistant',
    '小李您好，阿黄真是个可爱的名字～橘猫一般都很黏人吧？',
  ),

  // ─── work: email summary task ───
  // All identifiers below are fictitious test data — no real names,
  // project codes, vendor terms, or workflow specifics.
  mk('user', '帮我看下最近邮件，特别是 Project-A1 项目的'),
  mk(
    'assistant',
    '',
    [
      {
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'listRecentEmails',
        input: { folder: 'INBOX', limit: 5 },
      },
    ],
  ),
  mk(
    'tool',
    '',
    [
      {
        type: 'tool-result',
        toolCallId: 'c1',
        toolName: 'listRecentEmails',
        output: {
          emails: [
            { id: 'e1', from: 'alice@team.test', subject: 'Project-A1 验收加急', preview: 'SpecX 和 SpecY 的验收请加急处理' },
            { id: 'e2', from: 'bob@team.test', subject: 'Project-B2 异常项', preview: '某项指标轻微偏离需要进一步确认' },
          ],
        },
      },
    ],
  ),
  mk(
    'assistant',
    'Project-A1 项目下，alice 催 SpecX 和 SpecY 的验收（加急）；bob 那边 Project-B2 有指标偏离待确认。',
    [],
  ),

  // ─── chat: hobby ───
  mk('user', '周末又通宵玩了某 FPS 游戏，最近在练新角色的镜头风格'),
  mk('assistant', '主人这么有热情啊～高强度别忘记歇眼睛哦。'),

  // ─── work: task add ───
  mk('user', '提醒我下午三点联系 bob 跟进 Project-B2'),
  mk(
    'assistant',
    '',
    [
      {
        type: 'tool-call',
        toolCallId: 'c2',
        toolName: 'addTask',
        input: { text: '联系 bob 跟进 Project-B2', delaySeconds: 0, at: '2026-05-21T15:00:00+08:00' },
      },
    ],
  ),
  mk(
    'tool',
    '',
    [
      {
        type: 'tool-result',
        toolCallId: 'c2',
        toolName: 'addTask',
        output: { ok: true, id: 42 },
      },
    ],
  ),
  mk('assistant', '好的，已经记下：下午三点提醒主人联系 bob 跟进 Project-B2。'),

  // ─── chat: work-as-context ───
  mk('user', '我是做软件开发的，主要看代码 bug'),
  mk(
    'assistant',
    '软件开发挺硬核的呢～调 bug 估计每天都要盯着一堆日志吧。',
  ),
]

// ---------- Filters that mirror service.ts ----------

const conversational = allEpisodes.filter(
  (e) => e.speaker !== 'tool' && (!e.toolParts || e.toolParts.length === 0),
)
const workish = allEpisodes.filter(
  (e) =>
    e.speaker === 'tool' ||
    (e.toolParts && e.toolParts.length > 0) ||
    e.speaker === 'user',
)

console.log(`Total episodes: ${allEpisodes.length}`)
console.log(`  conversational (personal track input): ${conversational.length}`)
console.log(`  workish (work track input): ${workish.length}\n`)

// ---------- Run both reflections ----------

console.log('████ Personal reflection ████\n')
const personal = await reflect(conversational, extract, { kind: 'personal' })
if (!personal) {
  console.error('  ❌ personal reflection returned null')
  process.exit(1)
}
for (const f of personal) {
  console.log(`  · ${f.key} = ${f.value}  (conf ${f.confidence})`)
}
if (personal.length === 0) console.log('  (none extracted)')

console.log('\n████ Work reflection ████\n')
const work = await reflect(workish, extract, { kind: 'work' })
if (!work) {
  console.error('  ❌ work reflection returned null')
  process.exit(1)
}
for (const f of work) {
  console.log(`  · ${f.key} = ${f.value}  (conf ${f.confidence})`)
}
if (work.length === 0) console.log('  (none extracted)')

// ---------- Assertions ----------

console.log('\n████ Cross-contamination check ████\n')

const PERSONAL_PREFIXES = ['user.profile.', 'user.pets.', 'user.hobbies.', 'user.family.', 'user.work.']
const WORK_PREFIXES = ['project.', 'email.', 'task.', 'ticket.']

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(ok ? `  ✅ ${name}` : `  ❌ ${name} :: ${detail}`)
}

// Personal extracted something useful.
check(
  'personal extracted at least 1 fact',
  personal.length >= 1,
  `got ${personal.length}`,
)

// Personal should hit at least one of: name / pet / hobby / work-role.
const personalHitNameOrPet = personal.some(
  (f) =>
    f.key.startsWith('user.profile.') ||
    f.key.startsWith('user.pets.') ||
    f.key.startsWith('user.hobbies.') ||
    f.key.startsWith('user.work.'),
)
check('personal landed on user.* key', personalHitNameOrPet)

// Personal must NOT contain work prefixes.
const personalLeakedWork = personal.find((f) =>
  WORK_PREFIXES.some((p) => f.key.startsWith(p)),
)
check(
  'personal did NOT leak project/email/task/ticket keys',
  !personalLeakedWork,
  personalLeakedWork ? `leaked: ${personalLeakedWork.key}` : '',
)

// Work extracted something.
check('work extracted at least 1 fact', work.length >= 1, `got ${work.length}`)

// Work must NOT contain personal-trait keys (name/pet/hobby).
const workLeakedPersonal = work.find(
  (f) =>
    f.key.startsWith('user.profile.') ||
    f.key.startsWith('user.pets.') ||
    f.key.startsWith('user.hobbies.') ||
    f.key.startsWith('user.family.'),
)
check(
  'work did NOT leak user.profile/pets/hobbies/family keys',
  !workLeakedPersonal,
  workLeakedPersonal ? `leaked: ${workLeakedPersonal.key}` : '',
)

// Work should land on project/email/task prefixes.
const workHitWorkPrefix = work.some((f) =>
  WORK_PREFIXES.some((p) => f.key.startsWith(p)),
)
check('work landed on project/email/task key', workHitWorkPrefix)

// ---------- Summary ----------

const failed = results.filter((r) => !r.ok)
const passed = results.length - failed.length
console.log(
  `\n${failed.length === 0 ? '✅' : '❌'} ${passed}/${results.length} assertions passed`,
)
if (failed.length > 0) {
  console.log('\nFailed:')
  for (const f of failed) console.log(`  · ${f.name}${f.detail ? ` :: ${f.detail}` : ''}`)
}
process.exit(failed.length === 0 ? 0 : 1)
