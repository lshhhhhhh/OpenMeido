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

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('crashed:', err)
  process.exit(1)
})
