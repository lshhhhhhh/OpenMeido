#!/usr/bin/env node
/**
 * LIVE smoke: Kimi `$web_search` end to end through the real Vercel AI SDK
 * and our provider fetch (llm-fetch.ts → kimi-search-stream.ts). Costs a
 * few thousand tokens (search results are billed as input). Opt-in — not
 * part of test:all.
 *
 * Needs MOONSHOT_API_KEY in .env. Endpoint defaults to the international
 * platform; set KIMI_BASE_URL=https://api.moonshot.cn/v1 for a mainland key.
 *
 * Run: npm run test:kimi-search-live
 */
import { createOpenAI } from '@ai-sdk/openai'
import { streamText, tool, stepCountIs } from 'ai'
import { z } from 'zod'

const { makeProviderFetch } = await import('../src/main/llm-fetch.ts')

if (!process.env.MOONSHOT_API_KEY) {
  console.log('skip: MOONSHOT_API_KEY not set')
  process.exit(0)
}

const openai = createOpenAI({
  baseURL: process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1',
  apiKey: process.env.MOONSHOT_API_KEY,
  fetch: makeProviderFetch({ injectKimiSearch: true, isKimi: true }),
})
const result = streamText({
  model: openai.chat('kimi-k2.6'),
  temperature: 0.6,
  maxRetries: 0,
  system: '你是助手。时效性问题直接联网搜索后回答，一句话。',
  messages: [{ role: 'user', content: '今天最新的一条国际科技新闻是什么？联网查一下，一句话回答。' }],
  // An ordinary function tool alongside search, like the real chat path.
  tools: {
    addTask: tool({
      description: '添加待办',
      inputSchema: z.object({ title: z.string() }),
      execute: async () => ({ ok: true }),
    }),
  },
  stopWhen: stepCountIs(4),
})

let text = ''
let streamError = null
for await (const part of result.fullStream) {
  if (part.type === 'text-delta') text += part.text
  else if (part.type === 'error') streamError = part.error
}
const finish = await result.finishReason
console.log('reply :', JSON.stringify(text))
console.log('finish:', finish)
if (streamError) console.log('error :', streamError?.message ?? streamError)

const ok = !streamError && text.trim().length > 0 && finish === 'stop'
console.log(ok ? '\n✓ Kimi search round-trip produced a grounded reply' : '\n✗ Kimi search round-trip failed')
process.exit(ok ? 0 : 1)
