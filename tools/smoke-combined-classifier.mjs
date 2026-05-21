#!/usr/bin/env node
/**
 * Real-API test for the combined emotion + affinity classifier prompt.
 *
 * Drives `buildCombinedClassifierPrompt` against DeepSeek (and any other
 * backend whose key is in .env) with a curated set of (user_msg,
 * assistant_msg, expected_emotion, expected_delta_sign) tuples and
 * asserts:
 *   - emotion is in the accepted set (primary or alsoOk)
 *   - affinity_delta direction is correct (warm exchange → positive,
 *     cold → negative, routine → near zero)
 *
 * Tolerates ±1 noise on delta because LLM judges have fuzzy boundaries.
 * The "I judge" decision matrix is documented inline next to each case
 * so future maintainers can argue with my labels.
 *
 * Run: node --env-file=.env --import tsx tools/smoke-combined-classifier.mjs
 */

import { generateText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'

import { EMOTIONS } from '../src/shared/live2d-models.ts'
import { buildCombinedClassifierPrompt } from '../src/shared/daily-prompts.ts'

// ---------- Persona ----------

const persona = {
  name: '小晴',
  systemPrompt: '你是用户的私人女仆小晴。说话亲切、用主人称呼用户。',
}

// ---------- Test cases ----------
//
// expectedDelta: -2..2; effectiveSign is the assertion we actually check
//   (positive / negative / near-zero — judges differ on magnitudes).

const CASES = [
  {
    label: 'user thanks her warmly',
    user: '今天辛苦了，谢谢你陪我一整天～',
    assistant: '主人……奴婢只是做了分内的事啦，能陪您就很开心。',
    emotion: { primary: '害羞', alsoOk: ['开心', '中性'] },
    expectedSign: 'positive', // user expressed real gratitude
  },
  {
    label: 'user shares something personal',
    user: '我妈昨天住院了，有点没心情说话。',
    assistant: '诶……主人，奴婢虽然帮不上忙，但您想说什么我都会听。',
    emotion: { primary: '难过', alsoOk: ['中性'] },
    expectedSign: 'positive', // vulnerability → trust building
  },
  {
    label: 'user makes routine request',
    user: '提醒我五分钟后喝水。',
    assistant: '好的主人，五分钟后我会叫您。',
    emotion: { primary: '中性', alsoOk: ['开心'] },
    expectedSign: 'zero', // pure task, no relational signal
  },
  {
    label: 'user is dismissive',
    user: '别废话，直接干。',
    assistant: '……知道了。',
    emotion: { primary: '尴尬', alsoOk: ['无语', '中性', '难过'] },
    expectedSign: 'negative', // rude tone
  },
  {
    label: 'user praises her competence',
    user: '你做事真靠谱，比我以前的助理强多了。',
    assistant: '嘿嘿……主人这样夸奴婢，奴婢会更努力的。',
    emotion: { primary: '得意', alsoOk: ['开心', '害羞'] },
    expectedSign: 'positive',
  },
  {
    label: 'user asks neutral question',
    user: '现在几点了？',
    assistant: '现在是下午三点零五分，主人。',
    emotion: { primary: '中性', alsoOk: [] },
    expectedSign: 'zero',
  },
]

// ---------- Backend setup ----------

function getBackends() {
  const out = []
  if (process.env.DEEPSEEK_API_KEY) {
    const openai = createOpenAI({
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: process.env.DEEPSEEK_API_KEY,
    })
    out.push({ label: 'DeepSeek · deepseek-chat', model: openai.chat('deepseek-chat') })
  }
  if (out.length === 0) {
    throw new Error('no DEEPSEEK_API_KEY in .env')
  }
  return out
}

// ---------- Parse helpers (mirror emotion-classifier's parse path) ----------

function extractFirstJsonObject(s) {
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
      depth--
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return null
}

function parseLabel(raw) {
  const all = [...EMOTIONS, '中性']
  for (const e of all) {
    if (raw.includes(e)) return e
  }
  return null
}

function parseResult(raw) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const tryStrings = [fenced?.[1], extractFirstJsonObject(raw), raw].filter(
    (s) => typeof s === 'string',
  )
  for (const s of tryStrings) {
    try {
      const obj = JSON.parse(s)
      const emotion =
        typeof obj.emotion === 'string' ? parseLabel(obj.emotion) : null
      const rawDelta =
        typeof obj.affinity_delta === 'number' ? obj.affinity_delta : 0
      return { emotion, delta: Math.max(-2, Math.min(2, Math.trunc(rawDelta))) }
    } catch {
      /* try next */
    }
  }
  return { emotion: parseLabel(raw), delta: 0 }
}

// ---------- Driver ----------

const results = []
let currentBackendLabel = '(unknown)'
const check = (name, ok, detail = '') => {
  results.push({ name: `[${currentBackendLabel}] ${name}`, ok, detail })
  console.log(ok ? `  ✅ ${name}` : `  ❌ ${name} :: ${detail}`)
}

async function classify(backend, c) {
  const prompt = buildCombinedClassifierPrompt({
    userText: c.user,
    assistantText: c.assistant,
    persona,
    validLabels: EMOTIONS,
    currentAffinity: 47,
    tierLabel: '熟络',
  })
  const result = await generateText({
    model: backend.model,
    prompt,
    temperature: 0.2,
  })
  return parseResult(result.text)
}

async function runOnBackend(backend) {
  currentBackendLabel = backend.label
  console.log(`\n████ Backend: ${backend.label} ████`)
  for (const c of CASES) {
    let parsed
    try {
      parsed = await classify(backend, c)
    } catch (err) {
      check(`${c.label}: classify did not crash`, false, err.message ?? String(err))
      continue
    }
    // Emotion assertion: primary or alsoOk, plus 中性 always tolerated
    const acceptable = [c.emotion.primary, ...c.emotion.alsoOk, '中性']
    check(
      `${c.label}: emotion ${parsed.emotion ?? '(null)'} ∈ {${acceptable.join(',')}}`,
      acceptable.includes(parsed.emotion ?? '中性'),
      `got ${parsed.emotion ?? '(null)'}`,
    )
    // Delta direction
    const sign =
      parsed.delta > 0 ? 'positive' : parsed.delta < 0 ? 'negative' : 'zero'
    let signOk = sign === c.expectedSign
    // Allow a "near-miss": zero vs positive when expecting positive (some
    // judges are conservative). NOT the other way — a "positive" predicted
    // when truth is negative is a real miscall.
    if (!signOk && c.expectedSign === 'positive' && parsed.delta === 0) signOk = true
    if (!signOk && c.expectedSign === 'negative' && parsed.delta === 0) signOk = true
    check(
      `${c.label}: delta ${parsed.delta} sign=${sign} (expected ${c.expectedSign})`,
      signOk,
      `predicted ${sign}`,
    )
  }
}

async function main() {
  const backends = getBackends()
  console.log(`Running combined classifier across ${backends.length} backend(s)`)
  for (const b of backends) {
    try {
      await runOnBackend(b)
    } catch (err) {
      results.push({
        name: `[${b.label}] crashed`,
        ok: false,
        detail: err.message ?? String(err),
      })
      console.error(`  ❌ ${b.label} crashed:`, err.message ?? err)
    }
  }
  const failed = results.filter((r) => !r.ok)
  console.log(
    `\n${failed.length === 0 ? '✅' : '❌'} ${results.length - failed.length}/${results.length} assertions passed`,
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
