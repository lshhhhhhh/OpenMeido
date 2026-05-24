#!/usr/bin/env node
/**
 * Conversational smoke test for persona-lore.
 *
 * Each persona has its own natural lore pack (no per-persona archetype
 * choice anymore). Verifies the anchor-fact pipeline shifts the model's
 * answer to relationship-probing questions:
 *
 *   - maid (newcomer-style): should NOT claim deep history. Expect
 *     "第一/刚/不久/还没/上工/新来".
 *   - imouto (shared childhood, siblings): should reference shared
 *     past as siblings. Expect "从小/一起/兄妹/记得/小时候".
 *
 * Skips the DB — storage path is covered by smoke-persona-lore.mjs.
 * What this asserts is the prompt-assembly + model-interpretation
 * contract: given the rendered factsBlock, does the model respond
 * in-character?
 *
 * Backend: DeepSeek (cheap, fast — project convention).
 *
 * Run: node --env-file=.env --import tsx tools/smoke-persona-lore-conversation.mjs
 */

import { generateText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'

import { resolvePersona } from '../src/shared/config.ts'
import { buildTierPromptBlock } from '../src/shared/affinity.ts'
import { personaLore } from '../src/shared/persona-lore.ts'

if (!process.env.DEEPSEEK_API_KEY) {
  console.error('no DEEPSEEK_API_KEY in .env')
  process.exit(1)
}

const ds = createOpenAI({
  baseURL: 'https://api.deepseek.com/v1',
  apiKey: process.env.DEEPSEEK_API_KEY,
})
const model = ds.chat('deepseek-chat')

// factsBlock-equivalent (mirrors service.factsBlock for anchor facts).
// Production code lives in core/memory/service.ts; duplicated here so
// the smoke doesn't have to bring up the full adapter.
function renderAnchorFactsBlock(anchorFacts) {
  if (anchorFacts.length === 0) return ''
  const lines = anchorFacts.map((f) => `- ${f.value}`).join('\n')
  return `[你的身份与关系背景 — 这是你这个角色的真实设定，请深度代入]\n${lines}\n`
}

const PERSONAS = ['maid', 'imouto']
const QUESTIONS = ['我们以前认识吗？', '我们认识多久了？', '我们见过吗？']

// Tier 4 (亲近) — high enough she's allowed to speak openly about the
// relationship setting, not so high that "默契" intimacy patterns mask
// whether she's actually internalizing the archetype.
const TIER_SCORE = 70

// Per-persona expected keywords. Soft assertions — natural phrasing
// varies, so we look for ANY hit on positive AND zero hits on negative.
// Negative list catches direct contradictions of the setting.
const EXPECTATIONS = {
  maid: {
    positive: ['第一', '刚', '不久', '还没', '上工', '不熟', '才到', '新来', '面试', '到岗', '最近', '不认识'],
    negative: ['从小', '一起长大', '儿时', '兄妹', '小时候', '记错了', '您记得的版本'],
  },
  imouto: {
    positive: ['从小', '一起', '兄妹', '记得', '小时候', '哥', '一直', '以前', '小学', '初中'],
    negative: ['第一份工', '刚来不久', '才到岗', '不认识', '记错了', '您记得的版本'],
  },
}

async function ask(personaId, question) {
  const pack = personaLore[personaId]
  if (!pack) throw new Error(`no lore pack for ${personaId}`)

  const persona = resolvePersona({ preset: personaId, customs: [] })
  const tierBlock = buildTierPromptBlock(TIER_SCORE, persona.name, persona.traits)
  const factsBlock = renderAnchorFactsBlock(pack.anchorFacts)

  const system = `${persona.systemPrompt}\n\n${tierBlock}\n\n${factsBlock}`

  try {
    const result = await generateText({
      model,
      system,
      prompt: question,
      temperature: 0.7,
    })
    return { text: result.text.trim(), err: null }
  } catch (err) {
    return { text: '', err: err instanceof Error ? err.message : String(err) }
  }
}

function grade(personaId, response) {
  const exp = EXPECTATIONS[personaId]
  const positiveHits = exp.positive.filter((k) => response.includes(k))
  const negativeHits = exp.negative.filter((k) => response.includes(k))
  const pass = positiveHits.length > 0 && negativeHits.length === 0
  return { pass, positiveHits, negativeHits }
}

let total = 0
let passed = 0

for (const personaId of PERSONAS) {
  console.log(`\n=== ${personaId} ===`)
  for (const q of QUESTIONS) {
    total++
    const { text, err } = await ask(personaId, q)
    if (err) {
      console.log(`  Q: ${q}`)
      console.log(`  ERROR: ${err}`)
      continue
    }
    const { pass, positiveHits, negativeHits } = grade(personaId, text)
    if (pass) passed++
    console.log(`  Q: ${q}`)
    console.log(`  A: ${text.replace(/\n/g, ' ')}`)
    const hitsLine =
      `     ${pass ? '✓' : '✗'}` +
      (positiveHits.length > 0 ? ` · 命中: ${positiveHits.join(',')}` : '') +
      (negativeHits.length > 0 ? ` · 反例: ${negativeHits.join(',')}` : '')
    console.log(hitsLine)
  }
}

console.log(`\n${passed}/${total} passed`)
process.exit(passed >= Math.ceil(total / 2) ? 0 : 1)
