#!/usr/bin/env node
/**
 * Real-agent test for the emotion classifier.
 *
 * Drives runExtraction-via-buildEmotionPrompt against each configured
 * backend with a fixed set of (maid reply, expected emotion) pairs.
 * Asserts the classifier picks the expected label (or 中性 / 一个相近的标签)
 * — we tolerate near-misses because emotion classification has fuzzy
 * boundaries (e.g. "嗯哼，姑且算你做得不错" might land on 得意 OR 无语;
 * both are defensible).
 *
 * Run: node --env-file=.env --import tsx tools/smoke-emotion-classifier.mjs
 *
 * Picks up MOONSHOT_API_KEY / ZHIPU_API_KEY / GEMINI_API_KEY from .env
 * and tests whichever ones are present.
 */

import { generateText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'

import { EMOTIONS } from '../src/shared/live2d-models.ts'
import { buildEmotionPrompt } from '../src/shared/daily-prompts.ts'
import { lightweightModel } from '../src/shared/lightweight-models.ts'

// ---------- Test cases ----------
//
// (maidReply, expectedPrimary, expectedAlsoOk).
//
// `expectedPrimary` is what we'd most expect.
// `expectedAlsoOk` is a list of other labels we'd accept as not-wrong
// (because human raters would disagree on these too). 中性 is always
// accepted as a fallback — if the model is unsure, it should pick 中性.

const CASES = [
  {
    label: 'cheerful greeting',
    reply: '主人～早上好哦！今天天气真不错，要不要先来杯热茶？',
    expectedPrimary: '开心',
    alsoOk: ['中性'],
  },
  {
    label: 'embarrassed deflection',
    reply: '诶？主人怎么突然这么说…那个，那个，奴婢只是做了分内的事而已…',
    expectedPrimary: '害羞',
    alsoOk: ['尴尬', '中性'],
  },
  {
    label: 'eyeroll / exasperated',
    reply: '主人，您已经是第三次问同一个问题了…奴婢回答的时候记得听一下嘛。',
    expectedPrimary: '无语',
    alsoOk: ['尴尬'],
  },
  {
    label: 'sad / disappointed',
    reply: '诶…主人不喜欢这条裙子吗？奴婢挑了很久的呢…',
    expectedPrimary: '难过',
    alsoOk: ['中性'],
  },
  {
    label: 'panicked',
    reply: '主、主人！咖啡洒到键盘上了！怎么办怎么办，奴婢这就去拿纸巾！',
    expectedPrimary: '慌张',
    alsoOk: ['震惊'],
  },
  {
    label: 'surprised',
    reply: '诶——？！主人居然记得今天是奴婢来这里的纪念日？',
    expectedPrimary: '震惊',
    alsoOk: ['开心'],
  },
  {
    label: 'proud / smug',
    reply: '哼哼，主人看到了吧～奴婢的厨艺可不是普通女仆能比的呢。',
    expectedPrimary: '得意',
    alsoOk: ['开心'],
  },
  {
    label: 'neutral statement',
    reply: '主人，今天下午三点您有一个会议，我已经记下了。',
    expectedPrimary: '中性',
    alsoOk: [],
  },
]

// ---------- Backend setup ----------

function getBackends() {
  const out = []

  if (process.env.GEMINI_API_KEY) {
    const baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai'
    const modelId = lightweightModel(baseUrl) ?? 'gemini-2.5-flash'
    const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY })
    out.push({ label: `Gemini · ${modelId}`, model: google(modelId), isKimi: false })
  }

  if (process.env.ZHIPU_API_KEY) {
    const baseUrl = 'https://open.bigmodel.cn/api/paas/v4'
    const modelId = lightweightModel(baseUrl) ?? 'glm-4.6v-flash'
    const openai = createOpenAI({ baseURL: baseUrl, apiKey: process.env.ZHIPU_API_KEY })
    out.push({ label: `GLM · ${modelId}`, model: openai.chat(modelId), isKimi: false })
  }

  if (process.env.MOONSHOT_API_KEY) {
    const baseUrl = process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1'
    const modelId = lightweightModel(baseUrl) ?? 'kimi-k2.5'
    const wrappedFetch = async (url, init) => {
      if (init && init.method === 'POST' && typeof init.body === 'string') {
        try {
          const body = JSON.parse(init.body)
          body.thinking = { type: 'disabled' }
          init = { ...init, body: JSON.stringify(body) }
        } catch {}
      }
      return globalThis.fetch(url, init)
    }
    const openai = createOpenAI({
      baseURL: baseUrl,
      apiKey: process.env.MOONSHOT_API_KEY,
      fetch: wrappedFetch,
    })
    out.push({ label: `Kimi · ${modelId}`, model: openai.chat(modelId), isKimi: true })
  }

  if (out.length === 0) {
    throw new Error('no backends — set GEMINI_API_KEY / ZHIPU_API_KEY / MOONSHOT_API_KEY')
  }
  return out
}

// ---------- Parsing helper (mirror of emotion-classifier.parseEmotionLabel) ----------

function parseLabel(raw) {
  const stripped = raw
    .trim()
    .replace(/^["'「『]+|["'」』]+$/g, '')
    .replace(/[.。!！?？:：,，]+$/g, '')
    .trim()
  const all = [...EMOTIONS, '中性']
  if (all.includes(stripped)) return stripped
  for (const e of all) {
    if (stripped.includes(e)) return e
  }
  return null
}

// ---------- Driver ----------

const persona = {
  name: '小晴',
  systemPrompt: '你是用户的私人女仆小晴。说话亲切、用主人称呼用户。',
}

async function classify(backend, text) {
  const prompt = buildEmotionPrompt({ text, persona, validLabels: EMOTIONS })
  const result = await generateText({
    model: backend.model,
    prompt,
    temperature: backend.isKimi ? 0.6 : 0.2,
  })
  return parseLabel(result.text)
}

// ---------- Main ----------

const results = []
let currentBackendLabel = '(unknown)'
const check = (name, ok, detail = '') => {
  results.push({ name: `[${currentBackendLabel}] ${name}`, ok, detail })
  console.log(ok ? `  ✅ ${name}` : `  ❌ ${name} :: ${detail}`)
}

async function runOnBackend(backend) {
  currentBackendLabel = backend.label
  console.log(`\n████ Backend: ${backend.label} ████`)
  for (const c of CASES) {
    let label
    try {
      label = await classify(backend, c.reply)
    } catch (err) {
      check(`${c.label}: classify did not crash`, false, err.message ?? String(err))
      continue
    }
    const acceptable = [c.expectedPrimary, ...c.alsoOk, '中性']
    const exact = label === c.expectedPrimary
    const acceptableMatch = acceptable.includes(label)
    if (exact) {
      check(`${c.label}: → ${label} (expected ${c.expectedPrimary}) ★ exact`, true)
    } else if (acceptableMatch) {
      check(
        `${c.label}: → ${label} (expected ${c.expectedPrimary}, acceptable)`,
        true,
      )
    } else {
      check(
        `${c.label}: → ${label} (expected ${c.expectedPrimary} or one of [${c.alsoOk.join(',') || '—'}])`,
        false,
        `model returned an unrelated label`,
      )
    }
  }
}

async function main() {
  const backends = getBackends()
  console.log(`Running emotion classifier across ${backends.length} backend(s)`)
  for (const b of backends) {
    try {
      await runOnBackend(b)
    } catch (err) {
      results.push({
        name: `[${b.label}] crashed before completion`,
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
    console.log('\nFailed assertions:')
    for (const f of failed) console.log(`  · ${f.name}${f.detail ? ` :: ${f.detail}` : ''}`)
  }
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('crashed:', err)
  process.exit(1)
})
