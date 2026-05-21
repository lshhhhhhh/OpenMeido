#!/usr/bin/env node
/**
 * Elaborate-mode proactive remark preview.
 *
 * For each (persona × tier) cell at non-stranger tiers, force
 * `elaborate=true` and print what she says. Lets the user eyeball the
 * occasional "she opens up a bit" surprise without having to roll the
 * dice many times in dev.
 *
 * Run: node --env-file=.env --import tsx tools/smoke-elaborate-proactive.mjs
 */

import { generateText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'

import { resolvePersona } from '../src/shared/config.ts'
import { buildTierPromptBlock, tierFor } from '../src/shared/affinity.ts'
import { buildProactiveRemarkPrompt } from '../src/shared/daily-prompts.ts'

if (!process.env.DEEPSEEK_API_KEY) {
  console.error('no DEEPSEEK_API_KEY in .env')
  process.exit(1)
}

const ds = createOpenAI({
  baseURL: 'https://api.deepseek.com/v1',
  apiKey: process.env.DEEPSEEK_API_KEY,
})
const model = ds.chat('deepseek-chat')

// Non-stranger tiers — elaborate is gated to 0% at stranger by design.
const TIER_SCORES = [30, 60, 90]
const PERSONAS = ['maid', 'imouto', 'ojou']

// A few different trigger contexts so we see variety rather than always
// "15 minutes since last chat".
const TRIGGER_SCENARIOS = [
  { kind: 'timer', note: '距离上次对话 15 分钟' },
  { kind: 'idle', note: '用户已经 10 分钟没动鼠标了' },
]

// Mock memory: when --grounded is passed, we inject these so the model
// has actual material to anchor on. Without them elaborate falls back
// to invention (the failure mode the user observed). Compare side-by-side.
const MOCK_FACTS = `已知关于用户的事:
- user.profile.name: 林涛
- user.profile.job: 后端工程师，最近在做 GraphQL 网关重构
- user.hobby: 喜欢看推理小说，特别是东野圭吾
- user.routine: 习惯凌晨编码，咖啡只喝拿铁
- user.recent.struggle: 上周提过想戒咖啡但没成功`

const MOCK_RECENT_USER = [
  '帮我看看这段 schema 怎么改才不会破坏现有 query',
  '我今晚想试试不喝咖啡能不能撑到一点',
  '推荐个轻松点的小说？最近脑子有点累',
  '又熬夜了，明早会议十点',
]

const GROUNDED = process.argv.includes('--grounded')

async function generate(personaId, score, scenario) {
  const persona = resolvePersona({ preset: personaId, customs: [] })
  const tierBlock = buildTierPromptBlock(score, persona.name, persona.traits)
  const prompt = buildProactiveRemarkPrompt({
    persona,
    now: '2026-05-21 14:30',
    triggers: [scenario],
    tierBlock,
    hasScreenshot: false,
    recentSelfRemarks: [],
    elaborate: true,
    factsBlock: GROUNDED ? MOCK_FACTS : undefined,
    recentUserMessages: GROUNDED ? MOCK_RECENT_USER : undefined,
  })
  try {
    const result = await generateText({
      model,
      prompt,
      temperature: 0.8, // higher than the standard 0.7 — we want variety
    })
    return parseProactive(result.text)
  } catch (err) {
    return { kind: 'error', text: err.message ?? String(err) }
  }
}

function parseProactive(raw) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = [fenced?.[1], extractObject(raw)].filter(Boolean)
  for (const s of candidates) {
    try {
      const obj = JSON.parse(s)
      if (typeof obj.should_speak !== 'boolean') continue
      return obj.should_speak
        ? { kind: 'speak', text: String(obj.comment ?? '').trim() }
        : { kind: 'silent', text: String(obj.reason ?? '').trim() }
    } catch {
      /* try next */
    }
  }
  return { kind: 'unparseable', text: raw.slice(0, 200) }
}

function extractObject(s) {
  const start = s.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inString) {
      if (escape) escape = false
      else if (c === '\\') escape = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}') {
      if (--depth === 0) return s.slice(start, i + 1)
    }
  }
  return null
}

async function main() {
  console.log(
    GROUNDED
      ? '████ 模式：GROUNDED（注入 mock facts + recent user messages）████'
      : '████ 模式：UNGROUNDED（没有 memory 注入，纯 persona+tier 想象）████',
  )
  console.log('用 --grounded 切换。\n')
  for (const personaId of PERSONAS) {
    const persona = resolvePersona({ preset: personaId, customs: [] })
    console.log(`\n████ ${persona.name} (${personaId}) — 展开模式 ████`)
    for (const score of TIER_SCORES) {
      const t = tierFor(score)
      console.log(`\n── 好感度 ${score} (${t.zhLabel}) ──`)
      for (const scenario of TRIGGER_SCENARIOS) {
        const out = await generate(personaId, score, scenario)
        const len = out.text.length
        const label = `[${scenario.kind}: ${scenario.note}]`
        if (out.kind === 'speak') {
          console.log(`${label}  ${len}字`)
          console.log(`  → ${out.text}`)
        } else if (out.kind === 'silent') {
          console.log(`${label}  (silent) ${out.text}`)
        } else {
          console.log(`${label}  (${out.kind}) ${out.text}`)
        }
      }
    }
  }
}

main().catch((err) => {
  console.error('crashed:', err)
  process.exit(1)
})
