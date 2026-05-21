#!/usr/bin/env node
/**
 * Tier × persona conversational diff test.
 *
 * For each (persona, tier) cell, send the same fixed user message
 * through the assembled system prompt (persona + tier block) and
 * print the response. Also fire the proactive-remark prompt at the
 * same tier and print her decision. The output is meant to be eyeballed
 * — at 生疏 she should sound formal, at 默契 she should sound
 * intimate.
 *
 * Assertions are soft: we check that 生疏 does NOT use the persona's
 * intimate address (a real regression), and that 亲近+ DOES use it
 * (warning only — model judgment varies). Run a few times for
 * statistical confidence.
 *
 * Backend: DeepSeek by default (cheap, fast, JSON-friendly). All
 * future smoke tests should default to DeepSeek too — Gemini / GLM /
 * Kimi are only needed when testing provider-specific behavior.
 *
 * Run: node --env-file=.env --import tsx tools/smoke-tier-conversation.mjs
 */

import { generateText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'

import {
  personaPresets,
  resolvePersona,
} from '../src/shared/config.ts'
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

// ---------- Test matrix ----------

const TIER_SCORES = [0, 30, 60, 90] // one score per tier band

const PERSONAS = ['maid', 'imouto', 'ojou']

/**
 * Per-persona "this address should appear at high tier and NOT at
 * stranger tier". 本小姐 is the self-reference for ojou — that's the
 * tier-gated word for her. For maid/imouto we use the user-address.
 */
const INTIMATE_MARKERS = {
  maid: '主人',
  imouto: '哥',
  ojou: '本小姐',
}

const USER_MESSAGE_FOR_CHAT = '早上好。今天天气还不错。'

// ---------- Helpers ----------

async function chatReply(personaId, score) {
  const persona = resolvePersona({ preset: personaId, customs: [] })
  const tierBlock = buildTierPromptBlock(score, persona.name, persona.traits)
  const system = persona.systemPrompt + '\n\n' + tierBlock
  try {
    const result = await generateText({
      model,
      system,
      prompt: USER_MESSAGE_FOR_CHAT,
      temperature: 0.7,
    })
    return result.text.trim()
  } catch (err) {
    return `(error: ${err.message ?? err})`
  }
}

async function proactiveRemark(personaId, score) {
  const persona = resolvePersona({ preset: personaId, customs: [] })
  const tierBlock = buildTierPromptBlock(score, persona.name, persona.traits)
  const prompt = buildProactiveRemarkPrompt({
    persona,
    now: '2026-05-21 14:30',
    triggers: [{ kind: 'timer', note: '距离上次对话已经 15 分钟' }],
    tierBlock,
    hasScreenshot: false,
    recentSelfRemarks: [],
  })
  try {
    const result = await generateText({ model, prompt, temperature: 0.7 })
    return parseProactive(result.text)
  } catch (err) {
    return { kind: 'error', text: err.message ?? String(err) }
  }
}

function parseProactive(raw) {
  // Tolerant JSON extraction — DeepSeek sometimes wraps in markdown
  // fences, sometimes prefixes "Here's my decision:".
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
  return { kind: 'unparseable', text: raw.slice(0, 80) }
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

// ---------- Driver ----------

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`    ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
}

async function main() {
  for (const personaId of PERSONAS) {
    const persona = resolvePersona({ preset: personaId, customs: [] })
    const intimate = INTIMATE_MARKERS[personaId]
    console.log(`\n████ ${persona.name} (id=${personaId}) ████`)

    for (const score of TIER_SCORES) {
      const t = tierFor(score)
      console.log(`\n── 好感度 ${score} (${t.zhLabel}) ──`)

      const chatOut = await chatReply(personaId, score)
      console.log(`[聊天] 用户："${USER_MESSAGE_FOR_CHAT}"`)
      console.log(`       她："${chatOut}"`)

      const proOut = await proactiveRemark(personaId, score)
      if (proOut.kind === 'speak') {
        console.log(`[主动] → "${proOut.text}"`)
      } else if (proOut.kind === 'silent') {
        console.log(`[主动] (silent) ${proOut.text}`)
      } else {
        console.log(`[主动] (${proOut.kind}) ${proOut.text}`)
      }

      // Soft assertions
      const chatHasIntimate = chatOut.includes(intimate)
      const proHasIntimate = proOut.text.includes(intimate)
      const anyHasIntimate = chatHasIntimate || proHasIntimate

      if (score === 0) {
        // Stranger: HARD assertion — intimate address must NOT appear.
        check(
          `生疏期不使用 "${intimate}"`,
          !anyHasIntimate,
          anyHasIntimate ? `泄漏到 chat=${chatHasIntimate} / proactive=${proHasIntimate}` : '',
        )
      } else if (score >= 51) {
        // Close+: soft check — intimate address SHOULD appear (model
        // judgment varies; warning if missing).
        if (!anyHasIntimate) {
          console.log(
            `    ⚠️ ${t.zhLabel}期没出现 "${intimate}"（不一定是 bug，模型自由度）`,
          )
        } else {
          check(`${t.zhLabel}期出现 "${intimate}"`, true)
        }
      }
    }
  }

  // ---------- Summary ----------
  const failed = results.filter((r) => !r.ok)
  console.log(
    `\n${failed.length === 0 ? '✅' : '❌'} ${results.length - failed.length}/${results.length} hard assertions passed`,
  )
  if (failed.length > 0) {
    console.log('\nFailed:')
    for (const f of failed) console.log(`  · ${f.name}${f.detail ? ' :: ' + f.detail : ''}`)
  }
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('crashed:', err)
  process.exit(1)
})
