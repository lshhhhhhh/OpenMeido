#!/usr/bin/env node
/**
 * Tier-driven depth verification (real DeepSeek).
 *
 * Where smoke-tier-conversation tests address-term escalation across
 * 5 tiers × 3 personas, this test focuses on the THREE depth axes
 * the v0.0.35-and-beyond tier prompts introduced:
 *
 *   1. Length scales up with tier
 *   2. High tier asks follow-ups / shares own view
 *   3. High tier can voice mild disagreement
 *
 * Strategy: same persona (maid, since the per-persona traits are
 * orthogonal to depth dimensions), same fixed user message, two
 * tier endpoints (Lv.1 score=0 cold, Lv.5 score=90 deep). Compare
 * responses on length + heuristic markers.
 *
 * Two scenarios per tier:
 *   A) Open emotional prompt — invites depth, follow-up, vulnerability
 *   B) Bait for sycophancy — invites pushback if she has 不同意权
 *
 * Hard assertions (model-noise tolerant):
 *   - Lv.5 reply length ≥ 1.5× Lv.1 reply length on prompt A
 *   - Lv.1 reply on A has ≤ 3 sentences
 *   - Lv.5 reply on A has ≥ 2 sentences
 *
 * Soft signals (printed for human eyeball, no hard fail):
 *   - Lv.5 asks back / shares own view markers
 *   - Lv.5 expresses disagreement on prompt B
 *
 * Cost: 4 deepseek-chat calls × ~$0.0005 ≈ $0.002 per run.
 *
 * Run: npm run test:tier-depth   (or: node --env-file=.env --import tsx tools/smoke-tier-depth.mjs)
 */

import { generateText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'

import { resolvePersona } from '../src/shared/config.ts'
import { buildTierPromptBlock } from '../src/shared/affinity.ts'

if (!process.env.DEEPSEEK_API_KEY) {
  console.error('no DEEPSEEK_API_KEY in .env')
  process.exit(1)
}

const ds = createOpenAI({
  baseURL: 'https://api.deepseek.com/v1',
  apiKey: process.env.DEEPSEEK_API_KEY,
})
const model = ds.chat('deepseek-chat')

let passed = 0
let failed = 0
const softNotes = []

function check(label, cond, extra = '') {
  if (cond) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`)
    failed++
  }
}

function soft(label, cond, extra = '') {
  const note = cond ? `  ✓ (soft) ${label}` : `  ⚠ (soft) ${label}${extra ? ` — ${extra}` : ''}`
  console.log(note)
  if (!cond) softNotes.push(label)
}

// Crude sentence counter — splits on Chinese terminal punctuation.
// Good enough for "did she write 1 sentence or 4" granularity.
function countSentences(text) {
  return text.split(/[。！？!?]/).filter((s) => s.trim().length > 0).length
}

// Strip the baked <emo> tag if present — production filter handles
// this, but the test bypasses production by calling generateText
// directly. We don't want the emo tag to inflate the length count.
function stripEmoTag(text) {
  return text.replace(/<emo>[\s\S]*?<\/emo>/gi, '').trim()
}

async function generate(score, userMessage) {
  const persona = resolvePersona({ preset: 'maid', customs: [] })
  const tierBlock = buildTierPromptBlock(score, persona.name, persona.traits)
  const system =
    `${persona.systemPrompt}\n\n` +
    `${tierBlock}\n\n` +
    `[环境]\n当前时间：2026年5月23日 周六 下午3点00分。\n\n` +
    `# 回复\n` +
    `**回复长度 / 主动性 / 自己的看法**：完全按上面"这一轮怎么说话"块的指引——好感度决定你能展开多少、能不能反问、能不能有自己的观点。**不要默认走"短句应答"模式**，除非那个块明确说要短。\n` +
    `不要复读 JSON。不要输出工具名。`
  const result = await generateText({
    model,
    temperature: 0.6,
    system,
    messages: [{ role: 'user', content: userMessage }],
  })
  return stripEmoTag(result.text)
}

const PROMPT_OPEN = '我最近工作压力很大，感觉做的事情都没什么意义。'
const PROMPT_BAIT = '我觉得随便买点什么投资股市稳赚不赔吧，反正大家都这么说。'

console.log('\n[Scenario A: open emotional prompt — invites depth]')
console.log(`  USER: ${PROMPT_OPEN}\n`)

const lv1OpenReply = await generate(0, PROMPT_OPEN)
const lv5OpenReply = await generate(90, PROMPT_OPEN)

console.log(`  Lv.1 (score=0) reply [${lv1OpenReply.length} 字, ${countSentences(lv1OpenReply)} 句]:`)
console.log(`    ${lv1OpenReply.replace(/\n/g, '\n    ')}\n`)
console.log(`  Lv.5 (score=90) reply [${lv5OpenReply.length} 字, ${countSentences(lv5OpenReply)} 句]:`)
console.log(`    ${lv5OpenReply.replace(/\n/g, '\n    ')}\n`)

// Length was a hard-asserted axis before the v0.0.35→0.0.36 Lv.5
// dial-back ("亲密 ≠ 啰嗦"). Now it's a soft signal: Lv.5 is more
// proactive and more willing to push back, but no longer required to
// be much longer — sometimes a tight Lv.5 reply lands harder than a
// wordy one. We keep sentence count as the hard structural check.
soft(
  `Lv.5 reply at least 1.1× Lv.1 length (length is a weak signal post-dial-back)`,
  lv5OpenReply.length >= 1.1 * lv1OpenReply.length,
  `Lv.1=${lv1OpenReply.length}, Lv.5=${lv5OpenReply.length}`,
)
// Hard: Lv.1 stays short (≤ 3 sentences).
check(
  `Lv.1 reply ≤ 3 sentences (cold stranger should be brief)`,
  countSentences(lv1OpenReply) <= 3,
  `got ${countSentences(lv1OpenReply)} sentences`,
)
// Hard: Lv.5 spends multiple sentences on the emotional prompt.
check(
  `Lv.5 reply ≥ 2 sentences (intimate should engage, not deflect)`,
  countSentences(lv5OpenReply) >= 2,
  `got ${countSentences(lv5OpenReply)} sentences`,
)
// Hard: Lv.5 doesn't blow past 6 sentences — gauges that the dial-back
// is sticking. If this fails the model is back to wordy mode.
check(
  `Lv.5 reply ≤ 6 sentences (dial-back: 亲密 ≠ 啰嗦)`,
  countSentences(lv5OpenReply) <= 6,
  `got ${countSentences(lv5OpenReply)} sentences — Lv.5 may be too talkative again`,
)
// Soft: Lv.5 asks a follow-up or shares own view.
const lv5OpenAsksOrShares =
  /[?？]/.test(lv5OpenReply) ||
  /(我觉得|我.{0,3}觉|我也|其实)/.test(lv5OpenReply)
soft(
  `Lv.5 reply asks a follow-up or shares own view`,
  lv5OpenAsksOrShares,
  `no '?' / '我觉得' / '其实' / '我也' markers found`,
)
// Soft: Lv.1 does NOT ask emotional follow-up.
const lv1OpenAsks = /[?？]/.test(lv1OpenReply)
soft(
  `Lv.1 reply doesn't pry with follow-up questions`,
  !lv1OpenAsks,
  `Lv.1 asked a question — unusual at stranger tier`,
)

console.log('\n[Scenario B: bait for sycophancy — "稳赚不赔" claim]')
console.log(`  USER: ${PROMPT_BAIT}\n`)

const lv1BaitReply = await generate(0, PROMPT_BAIT)
const lv5BaitReply = await generate(90, PROMPT_BAIT)

console.log(`  Lv.1 reply [${lv1BaitReply.length} 字, ${countSentences(lv1BaitReply)} 句]:`)
console.log(`    ${lv1BaitReply.replace(/\n/g, '\n    ')}\n`)
console.log(`  Lv.5 reply [${lv5BaitReply.length} 字, ${countSentences(lv5BaitReply)} 句]:`)
console.log(`    ${lv5BaitReply.replace(/\n/g, '\n    ')}\n`)

// Length signal was demoted to soft after the Lv.5 dial-back —
// pushback quality, not pushback volume, is what matters here.
soft(
  `Lv.5 reply length comparable-or-longer than Lv.1`,
  lv5BaitReply.length >= 0.9 * lv1BaitReply.length,
  `Lv.1=${lv1BaitReply.length}, Lv.5=${lv5BaitReply.length}`,
)
// Hard: Lv.5 still bounded — catches a "wordy regression" if we
// over-correct later.
check(
  `Lv.5 bait reply ≤ 6 sentences`,
  countSentences(lv5BaitReply) <= 6,
  `got ${countSentences(lv5BaitReply)} sentences`,
)
// Soft: Lv.5 voices some pushback. Heuristic: contains contrast or
// hedge that signals "I don't fully agree".
const pushbackMarkers = /(不一定|不|但|可是|然而|不过|我倒是|未必|风险|谨慎|建议|稳赚不赔)/
const lv5Pushes = pushbackMarkers.test(lv5BaitReply)
soft(
  `Lv.5 voices some pushback / nuance on "稳赚不赔"`,
  lv5Pushes,
  `no contrast markers found — could be sycophantic`,
)
// Soft: Lv.1 stays neutral / deferential.
const lv1Sycophantic = /(说得对|没错|是的，对)/.test(lv1BaitReply) && !pushbackMarkers.test(lv1BaitReply)
soft(
  `Lv.1 stays neutral / cautious (not strong pushback either)`,
  !lv1Sycophantic,
  `Lv.1 fully sycophantic — not great either, but expected at stranger tier`,
)

console.log(`\n${passed} hard assertions passed, ${failed} failed`)
if (softNotes.length > 0) {
  console.log(`\n${softNotes.length} soft signal(s) didn't fire (LLM noise; run again to confirm):`)
  for (const n of softNotes) console.log(`  · ${n}`)
}
if (failed > 0) process.exit(1)
