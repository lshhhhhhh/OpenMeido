#!/usr/bin/env node
/**
 * LIVE provider matrix — the "is our model table still true?" check.
 *
 * For every provider with a key in .env, runs the app's own model choices
 * (shared/lightweight-models.ts) through the app's own request plumbing
 * (llm-fetch.ts body quirks + retry, native Google provider for Gemini):
 *
 *   chat    perf model + a function tool → the tool actually gets called
 *   side    lightweight model, one-line reply (thinking off where we do that)
 *   vision  side-task vision pick reads a solid red PNG → answer says 红
 *
 * Costs a few cents per full run. Opt-in, not part of test:all. Run it
 * whenever touching lightweight-models.ts, and every few months — provider
 * lineups churn (that's how v0.3.5 ended up calling retired Kimi ids).
 *
 * Run: npm run test:provider-matrix            (all configured providers)
 *      PROVIDERS=deepseek,qwen npm run test:provider-matrix
 */
import zlib from 'node:zlib'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { generateText, streamText, stepCountIs, tool } from 'ai'
import { z } from 'zod'

const {
  performanceModel,
  lightweightModel,
  pickSideTaskModel,
  resolveTemperature,
} = await import('../src/shared/lightweight-models.ts')
const { makeProviderFetch, fetchWithTransientRetry } = await import('../src/main/llm-fetch.ts')

const PROVIDERS = [
  { id: 'openai', url: 'https://api.openai.com/v1', key: 'OPENAI_API_KEY' },
  { id: 'gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai', key: 'GEMINI_API_KEY' },
  { id: 'glm', url: 'https://open.bigmodel.cn/api/paas/v4', key: 'ZHIPU_API_KEY' },
  { id: 'deepseek', url: 'https://api.deepseek.com/v1', key: 'DEEPSEEK_API_KEY' },
  { id: 'qwen', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', key: 'DASHSCOPE_API_KEY' },
  { id: 'kimi', url: process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1', key: 'MOONSHOT_API_KEY' },
  { id: 'doubao', url: 'https://ark.cn-beijing.volces.com/api/v3', key: 'ARK_API_KEY' },
  { id: 'anthropic', url: 'https://api.anthropic.com/v1', key: 'ANTHROPIC_API_KEY' },
]
const only = process.env.PROVIDERS?.split(',').map((s) => s.trim())

/** Same per-host flags as chat/run.ts + chat-host.ts. */
function modelFor(p, modelId, { side }) {
  const apiKey = process.env[p.key]
  if (p.url.includes('googleapis.com')) {
    return createGoogleGenerativeAI({ apiKey, fetch: fetchWithTransientRetry })(modelId)
  }
  const thinksByDefault = ['moonshot', 'deepseek', 'bigmodel', 'volces'].some((h) => p.url.includes(h))
  const isKimi = p.url.includes('moonshot')
  const isDoubao = p.url.includes('volces')
  return createOpenAI({
    baseURL: p.url,
    apiKey,
    fetch: makeProviderFetch({
      isKimi,
      isDeepSeek: p.url.includes('deepseek'),
      disableThinking: side ? thinksByDefault : isDoubao,
      isOpenAI: p.url.includes('openai.com'),
      isQwen: p.url.includes('dashscope'),
    }),
  }).chat(modelId)
}

function redPng(w = 64, h = 64) {
  const crcT = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcT[n] = c >>> 0
  }
  const crc = (b) => {
    let c = 0xffffffff
    for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (t, d) => {
    const l = Buffer.alloc(4)
    l.writeUInt32BE(d.length)
    const td = Buffer.concat([Buffer.from(t), d])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([l, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([255, 0, 0], y * (w * 3 + 1) + 1 + x * 3)
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

let passed = 0
let failed = 0
const report = (ok, label, detail) => {
  ok ? passed++ : failed++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
}
const errText = (e) => String(e?.responseBody ?? e?.message ?? e).replace(/\s+/g, ' ').slice(0, 160)
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

for (const p of PROVIDERS) {
  if (only && !only.includes(p.id)) continue
  if (!process.env[p.key]) {
    console.log(`\n[${p.id}] skip — no ${p.key}`)
    continue
  }
  const perf = performanceModel(p.url)
  const fast = lightweightModel(p.url)
  const vis = pickSideTaskModel({ baseUrl: p.url, userModel: perf, needVision: true })
  console.log(`\n[${p.id}] chat=${perf} side=${fast} vision=${vis}`)
  // Kimi's trial tier allows 3 requests/min — space the calls out.
  const gap = p.id === 'kimi' ? 21_000 : 0

  try {
    let called = false
    const r = streamText({
      model: modelFor(p, perf, { side: false }),
      temperature: resolveTemperature(perf, 0.6),
      maxRetries: 0,
      system: '你是助手。需要时直接调用工具，完成后用一句话回复。',
      messages: [{ role: 'user', content: '帮我加个待办：买牛奶' }],
      tools: {
        addTask: tool({
          description: '添加一条待办事项',
          inputSchema: z.object({ title: z.string() }),
          execute: async ({ title }) => {
            called = /牛奶/.test(title)
            return { ok: true, id: 1 }
          },
        }),
      },
      stopWhen: stepCountIs(3),
    })
    let text = ''
    let streamErr = null
    for await (const part of r.fullStream) {
      if (part.type === 'text-delta') text += part.text
      if (part.type === 'error') streamErr = part.error
    }
    report(called && !streamErr, 'chat: tool called', streamErr ? errText(streamErr) : `reply="${text.trim().slice(0, 40)}"`)
  } catch (e) {
    report(false, 'chat: tool called', errText(e))
  }
  await pause(gap)

  try {
    const r = await generateText({
      model: modelFor(p, fast, { side: true }),
      temperature: resolveTemperature(fast, 0.2),
      maxRetries: 0,
      prompt: '只回复两个字：你好',
    })
    report(r.text.trim().length > 0, 'side: one-line reply', `"${r.text.trim().slice(0, 30)}"`)
  } catch (e) {
    report(false, 'side: one-line reply', errText(e))
  }
  await pause(gap)

  try {
    const r = await generateText({
      model: modelFor(p, vis, { side: true }),
      temperature: resolveTemperature(vis, 0.2),
      maxRetries: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '这张图是什么颜色？只回答颜色。' },
            { type: 'image', image: redPng(), mediaType: 'image/png' },
          ],
        },
      ],
    })
    report(/红|red/i.test(r.text), 'vision: sees the red image', `"${r.text.trim().slice(0, 30)}"`)
  } catch (e) {
    report(false, 'vision: sees the red image', errText(e))
  }
  await pause(gap)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
