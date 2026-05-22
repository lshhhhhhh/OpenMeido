#!/usr/bin/env node
/**
 * Real-agent smoke test for the baked-emotion path. Verifies that:
 *   1. The model actually emits `<emo>X</emo>` at the end of its reply
 *      when the system prompt instructs it to.
 *   2. The label is one of the 8 valid emotions (not "中性" / "无" / other).
 *   3. The filter strips `<emo>...</emo>` cleanly from the displayed text.
 *   4. extractBakedEmotion() pulls out the same label.
 *
 * Per testing-discipline memory: DeepSeek by default (cheap + fast).
 *
 * Run: node --env-file=.env --import tsx tools/smoke-baked-emotion.mjs
 */

import { generateText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'

import { EMOTIONS } from '../src/shared/live2d-models.ts'
import { createTextDeltaFilter } from '../src/main/chat-text-filter.ts'

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

// System prompt is a stripped-down version of what chat.ts builds. The
// emotion-tag section is the part under test — kept verbatim from
// chat.ts so a divergence between test and prod is impossible without
// updating one or the other.
const SYSTEM_PROMPT =
  `你是用户的私人女仆小晴。说话亲切，称呼用户为"主人"，1-2 句话。\n` +
  `\n` +
  `# 表情标签（最终回复结尾必须输出）\n` +
  `**最终回复**说完正文后，在文本最末尾追加一个表情标签 \`<emo>X</emo>\`，X 从下面 8 个里选一个，对应**你这句话此刻的情绪**：\n` +
  `开心 / 害羞 / 无语 / 难过 / 慌张 / 震惊 / 尴尬 / 得意\n` +
  `规则：\n` +
  `- 这个标签**不会展示**给主人，只用来同步 Live2D 表情。\n` +
  `- 必须从 8 个里选一个，没有"中性"。日常应答 = 害羞 / 开心 / 得意 之间挑，不要总是同一个。\n` +
  `- 格式严格：\`<emo>害羞</emo>\`，紧贴在正文最后一个字之后或者下一行，不要包在其它符号里。`

// Same regex as chat.ts:extractBakedEmotion.
const BAKED_EMOTION_RE = /<emo>\s*([^<>\s]+)\s*<\/emo>/i
function extractBakedEmotion(raw) {
  const m = raw.match(BAKED_EMOTION_RE)
  if (!m) return null
  const label = m[1].trim()
  if (EMOTIONS.includes(label)) return label
  return null
}

const CASES = [
  { user: '主人来了！', hint: 'greeting — should be warm' },
  { user: '帮我记一下下午三点开会', hint: 'task — likely 害羞/得意' },
  { user: '你做的真好', hint: 'praise — likely 害羞' },
  { user: '你又算错了…', hint: 'mild scold — likely 慌张/难过/尴尬' },
  { user: '今天的天气怎么样', hint: 'small talk' },
]

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(ok ? `  ✅ ${name}` : `  ❌ ${name} :: ${detail}`)
}

async function runOne(c, i) {
  console.log(`\n[${i + 1}/${CASES.length}] user="${c.user}" (${c.hint})`)
  const { text } = await generateText({
    model,
    system: SYSTEM_PROMPT,
    prompt: c.user,
    temperature: 0.7,
  })
  const trimmed = text.trim()
  console.log(`  raw reply: ${trimmed}`)

  // 1. Tag present.
  const matched = trimmed.match(BAKED_EMOTION_RE)
  check(`#${i + 1} reply contains <emo>...</emo>`, !!matched, `raw=${trimmed.slice(0, 80)}`)
  if (!matched) return

  // 2. Label valid.
  const label = matched[1].trim()
  const labelValid = EMOTIONS.includes(label)
  check(`#${i + 1} label "${label}" is in the 8-emotion vocab`, labelValid)

  // 3. Filter strips tag from displayed text.
  const filter = createTextDeltaFilter()
  const filtered = filter.process(trimmed).emit + filter.flush().emit
  const stillHasTag = /<emo>|<\/emo>/i.test(filtered)
  check(
    `#${i + 1} filter strips <emo> from displayed text`,
    !stillHasTag,
    `filtered=${filtered.slice(0, 80)}`,
  )

  // 4. extractBakedEmotion returns the same label.
  const extracted = extractBakedEmotion(trimmed)
  check(
    `#${i + 1} extractBakedEmotion returns same label`,
    extracted === label,
    `got=${extracted} expected=${label}`,
  )
}

async function main() {
  console.log(`Running baked-emotion smoke against DeepSeek\n`)
  for (let i = 0; i < CASES.length; i++) {
    try {
      await runOne(CASES[i], i)
    } catch (err) {
      check(`#${i + 1} did not crash`, false, err.message ?? String(err))
    }
  }
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
}

main().catch((err) => {
  console.error('crashed:', err)
  process.exit(1)
})
