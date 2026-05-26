#!/usr/bin/env node
/**
 * Diagnostic: does GLM web_search actually work the way we inject it?
 *
 * Replicates the production path — createOpenAI(bigmodel.cn) + a fetch
 * wrapper that appends {type:'web_search', web_search:{enable:true}} to
 * the request body (via transformOpenAIBody injectGlmSearch). Then asks
 * a time-sensitive question and reports whether it errors, and whether
 * the answer looks grounded (fresh info) vs a "I can't browse" refusal.
 *
 * Tests three configs to isolate the failure:
 *   A) web_search only (no function tools)
 *   B) web_search + our function tools (production shape)
 *   C) no web_search at all (control — does the model just refuse?)
 *
 * Run: node --env-file=.env --import tsx tools/smoke-glm-search.mjs
 */
import { generateText, stepCountIs, tool } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'

import { transformOpenAIBody } from '../src/main/openai-compat-body.ts'

if (!process.env.ZHIPU_API_KEY) {
  console.error('no ZHIPU_API_KEY in .env')
  process.exit(1)
}

const MODEL = process.env.GLM_TEST_MODEL || 'glm-5.1'
const PROMPT = '现在比特币价格大概多少美元？用最新数据回答。'

function makeModel(injectSearch) {
  const wrappedFetch = async (url, init) => {
    if (init && init.method === 'POST' && typeof init.body === 'string') {
      try {
        const body = JSON.parse(init.body)
        if (injectSearch) transformOpenAIBody(body, { injectGlmSearch: true })
        // Log the outgoing tools array so we can see exactly what GLM receives.
        console.log('  → request tools:', JSON.stringify(body.tools ?? null))
        init = { ...init, body: JSON.stringify(body) }
      } catch (e) {
        console.log('  (body parse failed:', e.message, ')')
      }
    }
    const res = await globalThis.fetch(url, init)
    if (!res.ok) {
      const txt = await res.clone().text().catch(() => '')
      console.log(`  ← HTTP ${res.status}: ${txt.slice(0, 400)}`)
    }
    return res
  }
  const openai = createOpenAI({
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: process.env.ZHIPU_API_KEY,
    fetch: wrappedFetch,
  })
  return openai.chat(MODEL)
}

// Our real function tools (a subset) — to test mixing with web_search.
const fnTools = {
  readWebPage: tool({
    description: '抓取一个网页，提取正文。url 必须是 http(s) 完整 URL。',
    inputSchema: z.object({ url: z.string() }),
    execute: async ({ url }) => ({ error: 'test stub — not actually fetching ' + url }),
  }),
  readClipboard: tool({
    description: '读剪贴板',
    inputSchema: z.object({}),
    execute: async () => ({ text: '' }),
  }),
}

async function run(label, { injectSearch, withFnTools }) {
  console.log(`\n=== ${label} ===`)
  try {
    const result = await generateText({
      model: makeModel(injectSearch),
      temperature: 0.6,
      system: '你是用户的女仆助手。问到时效性话题时直接联网搜索后回答，不要说做不到。',
      prompt: PROMPT,
      tools: withFnTools ? fnTools : undefined,
      stopWhen: stepCountIs(6),
      maxRetries: 0,
    })
    const text = result.text.trim()
    console.log(`  reply (${text.length} chars): ${text.slice(0, 300)}`)
    // Heuristic: grounded answers cite a number + recent framing; refusals
    // say "无法/不能/没有联网/无法获取实时".
    const refused = /无法|不能联网|没有联网|无法获取|实时.*做不到|我无法访问/.test(text)
    const hasNumber = /\d{4,}|\$|\d+\s*美元|万美元/.test(text)
    console.log(`  → ${refused ? '❌ 像是拒绝/做不到' : hasNumber ? '✓ 像是给了具体数据' : '? 不确定'}`)
  } catch (err) {
    console.log(`  THREW: ${err instanceof Error ? err.message : String(err)}`)
  }
}

console.log(`Model: ${MODEL} · Prompt: "${PROMPT}"`)
await run('A) web_search 单独（无函数工具）', { injectSearch: true, withFnTools: false })
await run('B) web_search + 函数工具（生产形态）', { injectSearch: true, withFnTools: true })
await run('C) 无 web_search（对照）', { injectSearch: false, withFnTools: true })
console.log('\n完成。')
