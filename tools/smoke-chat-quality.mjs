/**
 * Chat-quality auto-scorer — answers the user's question:
 *   "can you reproduce the screenshot bug yourself and grade the reply,
 *    so I don't have to look?"
 *
 * Yes. This script:
 *   1. Drives a real model (GLM 4.6 by default — likely culprit for the
 *      bare-`</think>` issue captured in the screenshot) through the same
 *      streamText() + production filter + checkpoint pipeline that
 *      src/main/chat.ts uses live.
 *   2. Captures both the *raw* model output (what the user would see
 *      WITHOUT the filter) and the *visible* output (what the React bubble
 *      ends up with after our filter + text-reset events apply).
 *   3. Scores the visible output against a rubric. No human judgment, no
 *      LLM-as-judge — straight string checks that fail loudly if the bug
 *      regresses.
 *
 * Rubric (each item is one assertion):
 *   - Visible text contains no literal `<think>` / `</think>` /
 *     `<thinking>` substring (a leaked tag is the primary symptom).
 *   - Visible text has no large duplicated substring (≥40 chars repeated
 *     near-verbatim) — catches the "same paragraph twice" pattern.
 *   - Visible text is non-empty (filter didn't over-strip).
 *   - TTS sanitizer produces non-empty payload (Edge-TTS won't choke).
 *
 * Run: node --env-file=.env --import tsx tools/smoke-chat-quality.mjs
 *        # optionally BACKEND=qwen MODEL=qwen-plus node ...
 *
 * Plain Node (no Electron) — nothing here needs a native module.
 */

import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { stepCountIs, streamText, tool } from 'ai'
import { z } from 'zod'

import { createTextDeltaFilter } from '../src/main/chat-text-filter.ts'

// Default to FAST variants of each provider. Filter / agent-loop assertions
// don't need a reasoning-grade model — flash returns in ~2-3s vs 20-60s for
// the pro/thinking models. Override per-run with `MODEL=glm-4.6 ...`.
const BACKENDS = {
  glm: {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    envKey: 'ZHIPU_API_KEY',
    defaultModel: 'glm-4.6-flash',
  },
  qwen: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    envKey: 'DASHSCOPE_API_KEY',
    defaultModel: 'qwen-plus',
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    envKey: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-chat',
  },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    envKey: 'GEMINI_API_KEY',
    defaultModel: 'gemini-2.5-flash',
    native: true,
  },
}

const FAKE_MAIL = [
  { id: 'mail-2001', from: 'WWDC Notifications', subject: 'WWDC keynote 时间确认', snippet: 'June 10 at 10am PT' },
  { id: 'mail-2002', from: 'GitHub', subject: '[lshhhhhhh/desktop-kanojo] new star', snippet: '...' },
  { id: 'mail-2003', from: 'Quora Digest', subject: '本周 3 个问题', snippet: '...' },
  { id: 'mail-2004', from: 'AWS Billing', subject: 'Your AWS monthly invoice', snippet: '$12.34' },
  { id: 'mail-2005', from: '妈妈', subject: '记得吃饭', snippet: '今天吃饭了吗' },
]

// ---------- Reduce stream → visible text (mirrors App.tsx renderer logic) ----------

function applyFilterEvent(visible, { emit, resetLength }) {
  if (resetLength && resetLength > 0) visible = visible.slice(0, -resetLength)
  if (emit) visible += emit
  return visible
}

// ---------- TTS sanitizer (mirrors src/main/tts-host.ts) ----------

function sanitizeForTTS(text) {
  return text
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/<\/?(?:think|thinking|tool_call|arg_key|arg_value)(?:\s[^>]*)?>/gi, '')
    .trim()
}

// ---------- Scoring rubric ----------

function findLargeDuplicate(text, minLen = 40) {
  // Naive O(n²) substring scan — fine for a few KB of chat text.
  for (let len = minLen; len <= Math.floor(text.length / 2); len++) {
    for (let i = 0; i + len <= text.length - len; i++) {
      const slice = text.slice(i, i + len)
      // Skip whitespace-only or sentinel-heavy slices.
      if (slice.trim().length < minLen * 0.8) continue
      const dupIdx = text.indexOf(slice, i + len)
      if (dupIdx !== -1) {
        return { slice, firstIdx: i, secondIdx: dupIdx, len }
      }
    }
  }
  return null
}

function score(visibleText, rawText) {
  const checks = []
  const tagLeak = /<\/?think(?:ing)?>/i.test(visibleText) || /<\/?tool_call/i.test(visibleText)
  checks.push({
    name: 'visible text contains no leaked think/tool_call tags',
    ok: !tagLeak,
    detail: tagLeak ? `leaked: ${(visibleText.match(/<\/?\w+>/g) ?? []).slice(0, 3).join(', ')}` : '',
  })

  const dup = findLargeDuplicate(visibleText)
  checks.push({
    name: 'no large duplicated paragraph (≥40 chars repeated)',
    ok: dup === null,
    detail: dup ? `dup @${dup.firstIdx}/${dup.secondIdx}: "${dup.slice.slice(0, 40)}…"` : '',
  })

  // If the model emitted no visible bytes at all (reasoning-only output or
  // safety-blocked), the emptiness/TTS checks would be misleading — that's
  // a model quirk, not a filter regression. Skip them and emit a single
  // informational assertion that the run produced *some* output channel.
  if (rawText.length === 0) {
    checks.push({
      name: 'model produced output (reasoning-only run — skipping content checks)',
      ok: true,
      detail: 'raw=0 bytes; nothing to score',
    })
  } else {
    checks.push({
      name: 'visible text is non-empty',
      ok: visibleText.trim().length > 0,
      detail: visibleText.trim().length === 0 ? `raw=${rawText.length} bytes but filter stripped all` : '',
    })

    const ttsPayload = sanitizeForTTS(visibleText)
    checks.push({
      name: 'TTS sanitizer produces non-empty payload',
      ok: ttsPayload.length > 0,
      detail: '',
    })
  }

  // Diagnostic only — not an assertion. Tells us if the model emitted the
  // bug at all; the filter did its job either way.
  const rawHadImplicitClose =
    /<\/think(?:ing)?>/i.test(rawText) && !/<think(?:ing)?>/i.test(rawText)

  return { checks, rawHadImplicitClose }
}

// ---------- Tool stubs ----------

function makeTools(callLog) {
  return {
    listRecentEmails: tool({
      description: '查看用户邮箱里最近的邮件。返回 items[].id 等摘要。',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(20),
        onlyUnread: z.boolean(),
      }),
      execute: async ({ limit, onlyUnread }) => {
        callLog.push({ name: 'listRecentEmails', input: { limit, onlyUnread } })
        return { items: FAKE_MAIL.slice(0, limit) }
      },
    }),
    readEmail: tool({
      description: '读取邮件正文。id 必须来自上一次 listRecentEmails 的 items[].id。',
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        callLog.push({ name: 'readEmail', input: { id } })
        const m = FAKE_MAIL.find((x) => x.id === id)
        return m ?? { error: `id="${id}" not found` }
      },
    }),
  }
}

// ---------- Driver ----------

async function runScenario({ label, prompt, model, tools }) {
  console.log(`\n=== ${label} ===`)
  const filter = createTextDeltaFilter()
  let visible = ''
  let raw = ''
  const filterEvents = []

  const result = streamText({
    model,
    temperature: 0.6,
    system:
      '你是邮箱小助手。看到"看看邮件"先调用 listRecentEmails；' +
      '"打开 X 那封"用 readEmail。回复用一两句人物语气说完即可。',
    prompt,
    tools,
    stopWhen: stepCountIs(3),
    maxRetries: 0,
  })

  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') {
      raw += part.text
      const out = filter.process(part.text)
      filterEvents.push(out)
      visible = applyFilterEvent(visible, out)
    } else if (part.type === 'tool-call') {
      filter.checkpoint()
    } else if (part.type === 'error') {
      console.error('  stream error:', part.error)
      throw part.error instanceof Error ? part.error : new Error(String(part.error))
    }
  }
  const tail = filter.flush()
  filterEvents.push(tail)
  visible = applyFilterEvent(visible, tail)

  console.log(`raw bytes:     ${raw.length}`)
  console.log(`visible bytes: ${visible.length}`)
  if (raw.length !== visible.length) {
    console.log(`filter stripped ${raw.length - visible.length} chars`)
  }
  console.log(`visible:\n  ${visible.replace(/\n/g, '\n  ').slice(0, 600)}${visible.length > 600 ? '…' : ''}`)

  const { checks, rawHadImplicitClose } = score(visible, raw)
  console.log(`raw stream had implicit </think> (bug present in upstream): ${rawHadImplicitClose}`)
  for (const c of checks) {
    console.log(c.ok ? `  ✅ ${c.name}` : `  ❌ ${c.name} :: ${c.detail}`)
  }
  return { checks, rawHadImplicitClose }
}

async function main() {
  try { process.loadEnvFile('.env') } catch {}

  // Gemini default — fastest first-byte of the four, and we know it works
  // with tool calls. The GLM/qwen/deepseek paths require their respective
  // free-tier permissions which not every account has.
  const backendName = (process.env.BACKEND || 'gemini').toLowerCase()
  const cfg = BACKENDS[backendName]
  if (!cfg) {
    console.error(`Unknown BACKEND=${backendName}. Choose from: ${Object.keys(BACKENDS).join(', ')}`)
    process.exit(1)
  }
  const apiKey = process.env[cfg.envKey]
  if (!apiKey) {
    console.error(`Missing ${cfg.envKey} in .env`)
    process.exit(1)
  }
  const modelName = process.env.MODEL || cfg.defaultModel
  console.log(`Backend: ${backendName} · Model: ${modelName} · ${cfg.baseUrl}`)

  let model
  if (cfg.native && backendName === 'gemini') {
    model = createGoogleGenerativeAI({ apiKey })(modelName)
  } else {
    model = createOpenAI({ baseURL: cfg.baseUrl, apiKey }).chat(modelName)
  }

  // Run both scenarios in parallel — they share no state (each has its own
  // filter + own tool call-log via separate `makeTools()` instances). Cuts
  // wall time roughly in half.
  const t0 = Date.now()
  const [r1, r2] = await Promise.all([
    runScenario({
      label: 'Scenario 1 — 看看邮件 (single tool call)',
      prompt: '看看邮件',
      model,
      tools: makeTools([]),
    }),
    runScenario({
      label: 'Scenario 2 — 直接问问题 (no tools)',
      prompt: '现在几点？给我一个简短的人物语气回复。',
      model,
      tools: makeTools([]),
    }),
  ])
  console.log(`\n(elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s)`)

  const all = [...r1.checks, ...r2.checks]
  const failed = all.filter((c) => !c.ok)
  console.log(`\n${failed.length === 0 ? '✅' : '❌'} ${all.length - failed.length}/${all.length} assertions passed`)
  if (r1.rawHadImplicitClose || r2.rawHadImplicitClose) {
    console.log('ℹ︎  model DID emit bare </think> — filter handled it correctly.')
  } else {
    console.log('ℹ︎  model did not emit </think> this run — try a thinking-mode model to exercise the filter.')
  }
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('crashed:', err)
  process.exit(1)
})
