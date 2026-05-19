#!/usr/bin/env node
/**
 * Real-agent test for Gemini Search Grounding.
 *
 * Asks the model questions that REQUIRE post-training-cutoff info
 * (recent news, weather "today", live sports scores) and asserts:
 *
 *   1. With searchEnabled, the response includes grounding metadata
 *      (the SDK surfaces source URLs after streaming completes).
 *   2. Without searchEnabled, the model declines or hedges (no
 *      grounding metadata is present).
 *
 * GLM is intentionally not tested here yet — its web_search uses a
 * provider-specific tool shape we haven't wired up. Once that lands,
 * a parallel scenario can be added.
 *
 * Run: node --env-file=.env --import tsx tools/smoke-search-agent.mjs
 */
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { stepCountIs, streamText } from 'ai'

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    console.log(`  ❌ ${name} :: ${detail}`)
  }
}

async function ask(model, prompt, tools = {}) {
  let visible = ''
  let providerMetadata = null
  const result = streamText({
    model,
    temperature: 1,
    system: '你是一个简洁的助手。回答用 1-2 句话。如果用到搜索，简短引用一下来源。',
    prompt,
    tools,
    stopWhen: stepCountIs(4),
    maxRetries: 0,
  })
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') visible += part.text
    else if (part.type === 'error') {
      throw part.error instanceof Error ? part.error : new Error(String(part.error))
    }
  }
  // Provider metadata (grounding sources, etc.) lives on the final result.
  // We await the same promise the SDK gives back to read it.
  try {
    providerMetadata = await result.providerMetadata
  } catch {
    /* not all models populate it; treat as absent */
  }
  return { visible, providerMetadata }
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    console.error('GEMINI_API_KEY missing')
    process.exit(1)
  }
  const google = createGoogleGenerativeAI({ apiKey })
  const modelName = 'gemini-2.5-flash'

  // ---------- WITH grounding ----------
  console.log(`\n=== Backend: ${modelName} with googleSearch tool ===`)
  {
    const model = google(modelName)
    const tools = { google_search: google.tools.googleSearch({}) }
    const { visible, providerMetadata } = await ask(
      model,
      '2026 年 5 月谁是美国总统？回答最新的信息，不要凭训练数据猜。',
      tools,
    )
    console.log(
      `visible: ${visible.replace(/\n/g, ' ').slice(0, 200)}${visible.length > 200 ? '…' : ''}`,
    )
    check('returned a non-empty answer', visible.trim().length > 0)
    // Grounding metadata: @ai-sdk/google attaches it via providerMetadata.google
    const gm = providerMetadata?.google?.groundingMetadata
    check(
      'providerMetadata.google.groundingMetadata is present',
      gm !== null && gm !== undefined,
      `got: ${JSON.stringify(providerMetadata?.google ?? null).slice(0, 120)}`,
    )
    const sources =
      gm?.groundingChunks?.length ?? gm?.webSearchQueries?.length ?? 0
    check(`grounding chunks / web-search queries present (got ${sources})`, sources > 0)
  }

  // ---------- WITHOUT grounding (control) ----------
  console.log(`\n=== Backend: ${modelName} WITHOUT search (control) ===`)
  {
    const model = google(modelName)
    const { visible, providerMetadata } = await ask(
      model,
      '2026 年 5 月谁是美国总统？',
      {}, // no google_search tool
    )
    console.log(
      `visible: ${visible.replace(/\n/g, ' ').slice(0, 200)}${visible.length > 200 ? '…' : ''}`,
    )
    const gm = providerMetadata?.google?.groundingMetadata
    check(
      'no grounding metadata when search tool absent',
      gm === null || gm === undefined,
      `got groundingMetadata=${JSON.stringify(gm).slice(0, 60)}`,
    )
  }

  // ---------- GLM with web_search injected via fetch wrapper ----------
  if (process.env.ZHIPU_API_KEY) {
    console.log(`\n=== Backend: GLM glm-4.6 with web_search (fetch-wrapper) ===`)
    // Reproduce the same wrapped-fetch pattern chat.ts uses, so this
    // test exercises the actual wire path that ships.
    const wrappedFetch = async (url, init) => {
      if (init && init.method === 'POST' && typeof init.body === 'string') {
        try {
          const body = JSON.parse(init.body)
          const entry = { type: 'web_search', web_search: { enable: true } }
          if (Array.isArray(body.tools)) body.tools.push(entry)
          else body.tools = [entry]
          init = { ...init, body: JSON.stringify(body) }
        } catch {}
      }
      return globalThis.fetch(url, init)
    }
    const openai = createOpenAI({
      baseURL: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: process.env.ZHIPU_API_KEY,
      fetch: wrappedFetch,
    })
    const model = openai.chat('glm-4.6')
    try {
      const { visible } = await ask(
        model,
        '请告诉我 2026 年 5 月的实时新闻——最新的中国互联网行业动态。需要最新信息。',
      )
      console.log(
        `visible: ${visible.replace(/\n/g, ' ').slice(0, 300)}${visible.length > 300 ? '…' : ''}`,
      )
      check(
        'GLM returned a non-empty answer',
        visible.trim().length > 30,
        `length=${visible.length}`,
      )
      // GLM with web_search shouldn't hedge with "I can't access realtime info."
      // If hedging occurs, search wasn't actually invoked.
      const hedgePhrases = ['无法访问', '无法获取', '我没有实时', '我无法查看实时', 'cannot access']
      const hedged = hedgePhrases.some((p) => visible.includes(p))
      check(
        'GLM did NOT hedge about realtime access (suggests search was invoked)',
        !hedged,
        `looked for: ${hedgePhrases.join(' / ')}`,
      )
    } catch (err) {
      // If GLM's API rejects the wrapped body, that's diagnostic too —
      // we want to know immediately rather than silently shipping broken.
      check(
        'GLM web_search request did not 4xx',
        false,
        err instanceof Error ? err.message : String(err),
      )
    }
  } else {
    console.log('\n(skipping GLM scenario — ZHIPU_API_KEY not in .env)')
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('crashed:', err)
  process.exit(1)
})
