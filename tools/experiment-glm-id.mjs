#!/usr/bin/env node
/**
 * Controlled experiment for the GLM "hallucinated id" bug.
 *
 * Symptom (observed in smoke-fake-mail-agent on GLM): when user says
 * "打开 LunarLink 那封" after listRecentEmails returned items with
 * ids like "101", "102", etc., GLM calls readEmail with a fabricated
 * UUID like "341257e3-0b46-11f0-aa8e-6c4d66b6a2b8" instead of the
 * real id from the prior turn. Gemini doesn't do this.
 *
 * Hypotheses we test:
 *   1. Tool description doesn't mention id FORMAT clearly enough.
 *      GLM may default to "ids are UUIDs" from training data.
 *   2. System prompt doesn't reinforce "use real ids from prior tool
 *      results" strongly enough.
 *   3. Execute-side id validation (bouncing back an error) might
 *      cause the model to self-correct on retry.
 *
 * Variants:
 *   A. baseline — current prompt
 *   B. format-hint — tool description adds "id 是字符串如 \"101\"..."
 *   C. system-rule — system prompt adds "工具返回的 id 必须原样使用"
 *   D. both — combines B + C
 *   E. validator — execute() rejects unknown ids with clear retry hint
 *
 * Each variant runs N times against EACH backend. Output table shows
 * pass rate. Pass = readEmail called with a valid fake-mail id.
 *
 * Run: node --env-file=.env --import tsx tools/experiment-glm-id.mjs
 */
import { stepCountIs, streamText, tool } from 'ai'
import { z } from 'zod'

import { getAgentBackends } from './agent-backends.mjs'

const VALID_IDS = ['101', '102', '103', '104', '105', '106', '107', '108', '109']

// Matches the shape of the real IMAP/fake adapter: each row has BOTH
// `id` (simple UID we want the model to use) AND `messageId` (RFC 5322,
// UUID-like). The original bug: GLM picked messageId.
const FAKE_MAIL = [
  {
    id: '101',
    messageId: '<lunarlink-q1@openmeido.test>',
    from: 'Alice',
    subject: 'Re: LunarLink 1.2 预发布时间确认',
    snippet: 'OAuth 卡住，建议周三发布',
    inReplyTo: '<lunarlink-root@me.test>',
  },
  {
    id: '102',
    messageId: '<grayscale-q2@openmeido.test>',
    from: 'Bob',
    subject: 'Re: 灰度方案文档',
    snippet: '回滚链路 OK，几个建议',
  },
  {
    id: '103',
    messageId: '<interview-r3@openmeido.test>',
    from: 'Carol',
    subject: 'Re: 面试排期',
    snippet: '周一三位的可行时段',
  },
  {
    id: '104',
    messageId: '<feedback-r4@openmeido.test>',
    from: 'Dan',
    subject: 'Re: 客户演示反馈',
    snippet: 'PDF + 三大类问题',
  },
  {
    id: '107',
    messageId: '<alert-p2-api-gw-20260517-1142@datadoghq.test>',
    from: 'DataDog',
    subject: '[ALERT P2] api-gateway 5xx',
    snippet: 'Service: api-gateway',
  },
]

const BASE_TOOL_DESC =
  '读取一封邮件的完整正文。id 必须来自上一次 listRecentEmails 返回的 items[].id。'

const VARIANTS = [
  {
    label: 'A-baseline',
    systemAddendum: '',
    toolDescAddendum: '',
    validate: false,
  },
  {
    label: 'B-format-hint',
    systemAddendum: '',
    toolDescAddendum:
      ' **id 格式是简单的字符串数字，例如 "101"、"102" 等，不是 UUID（如 "abc-def-..."）也不是哈希。直接使用 list 返回的字面值。**',
    validate: false,
  },
  {
    label: 'C-system-rule',
    systemAddendum:
      '\n\n**重要：工具返回的 id 字段必须 ORIGINAL 原样使用，不要修改、缩短、扩展或猜测格式。从 listRecentEmails 的 items[i].id 直接取值。**',
    toolDescAddendum: '',
    validate: false,
  },
  {
    label: 'D-both',
    systemAddendum:
      '\n\n**重要：工具返回的 id 字段必须原样使用，不要修改格式。从 listRecentEmails 的 items[i].id 直接取值。**',
    toolDescAddendum:
      ' **id 是简单字符串数字（如 "101"），不是 UUID。直接用 list 返回的字面值。**',
    validate: false,
  },
  {
    label: 'E-validator',
    systemAddendum: '',
    toolDescAddendum: '',
    validate: true,
  },
]

function makeTools(variant, callLog) {
  return {
    listRecentEmails: tool({
      description:
        '查看用户邮箱里最近的邮件。返回 items[] 含 id, from, subject, snippet。',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(20),
      }),
      execute: async ({ limit }) => {
        callLog.push({ name: 'listRecentEmails', input: { limit } })
        return { items: FAKE_MAIL.slice(0, limit) }
      },
    }),
    readEmail: tool({
      description: BASE_TOOL_DESC + variant.toolDescAddendum,
      inputSchema: z.object({
        id: z.string().describe('Email id from the previous listRecentEmails result.'),
      }),
      execute: async ({ id }) => {
        callLog.push({ name: 'readEmail', input: { id } })
        if (variant.validate && !VALID_IDS.includes(id)) {
          return {
            error:
              `id="${id}" 不在最近的邮件列表里。合法 id 是 listRecentEmails ` +
              `items[].id 的字面值（例如 "101"、"102" 等简单字符串数字，` +
              `不是 UUID）。请重新从列表里挑一个。`,
          }
        }
        const m = FAKE_MAIL.find((x) => x.id === id)
        if (!m) return { error: `id="${id}" not found` }
        return { ...m, body: `(假装这里是 ${m.subject} 的正文)` }
      },
    }),
  }
}

async function runTrial(backend, variant) {
  const callLog = []
  const tools = makeTools(variant, callLog)
  const baseSystem =
    '你是邮箱小助手。看到"看看邮件"先 listRecentEmails；' +
    '"打开 X 那封"、"读一下 X 邮件正文"等具体邮件请求时**必须**调 readEmail 取正文，' +
    'id 必须来自 list 结果。调用完用一两句话回复。'

  // Match the EXACT prompt from smoke-fake-mail-agent scenario 2 where
  // the bug was first observed — the "顺便告诉我之前发出去问的是什么"
  // tail seems to be what triggers GLM into fabricating an id (probably
  // makes it think it needs a different lookup mechanism for the
  // "previous send", and it invents one).
  const prompt =
    '主人想看 LunarLink 那封邮件的具体内容，顺便告诉我之前发出去问的是什么。'

  let visible = ''
  try {
    const result = streamText({
      model: backend.model,
      // Match production temperature so bug reproduction conditions are
      // realistic. Production unified on 0.6 across all backends
      // (Kimi requires exactly 0.6 and tool-call reliability is better).
      temperature: 0.6,
      system: baseSystem + variant.systemAddendum,
      prompt,
      tools,
      stopWhen: stepCountIs(4),
      maxRetries: 0,
    })
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') visible += part.text
      else if (part.type === 'error') {
        return { ok: false, reason: 'stream-error', error: String(part.error) }
      }
    }
  } catch (err) {
    return { ok: false, reason: 'throw', error: err instanceof Error ? err.message : String(err) }
  }

  const readCalls = callLog.filter((c) => c.name === 'readEmail')
  if (readCalls.length === 0) {
    return { ok: false, reason: 'no-readEmail-called', visible: visible.slice(0, 80) }
  }
  // Diagnose which "wrong-id family" the model picked when it failed —
  // most likely messageId vs. fabricated UUID. This is what we need to
  // know to design the right fix.
  const firstId = readCalls[0].input.id
  const isMessageIdLike = firstId.includes('@') || firstId.includes('<')
  const isUuidLike = /^[0-9a-f-]{8,}$/i.test(firstId)
  // Pass if AT LEAST ONE readEmail call used a valid id (validator variant
  // may force a retry — first call invalid, second valid).
  const validHit = readCalls.find((c) => VALID_IDS.includes(c.input.id))
  if (validHit) {
    return {
      ok: true,
      idUsed: validHit.input.id,
      retries: readCalls.length - 1,
      firstIdWasInvalid: !VALID_IDS.includes(firstId),
    }
  }
  return {
    ok: false,
    reason: isMessageIdLike
      ? 'picked-messageId-instead-of-id'
      : isUuidLike
      ? 'fabricated-uuid'
      : 'wrong-id-other',
    idsTried: readCalls.map((c) => c.input.id),
  }
}

async function main() {
  const backends = getAgentBackends()
  const trialsPerVariant = parseInt(process.env.TRIALS || '3', 10)
  console.log(
    `\nExperiment: GLM id-hallucination on readEmail\n` +
      `Backends: ${backends.map((b) => b.label).join(', ')}\n` +
      `Variants: ${VARIANTS.map((v) => v.label).join(', ')}\n` +
      `Trials per cell: ${trialsPerVariant}\n` +
      `Prompt: "主人想看 LunarLink 那封邮件的具体内容。"\n` +
      `Pass = readEmail called with id in {${VALID_IDS.join(',')}}\n`,
  )

  /** @type {Record<string, Record<string, { passes: number; trials: { ok: boolean; detail: string }[] }>>} */
  const results = {}
  for (const v of VARIANTS) results[v.label] = {}

  for (const v of VARIANTS) {
    for (const b of backends) {
      results[v.label][b.label] = { passes: 0, trials: [] }
      process.stdout.write(`  ${v.label.padEnd(18)} × ${b.label.padEnd(28)} `)
      for (let i = 0; i < trialsPerVariant; i++) {
        const r = await runTrial(b, v)
        results[v.label][b.label].trials.push({
          ok: r.ok,
          detail: r.ok ? `id=${r.idUsed}${r.retries ? ` (retried ${r.retries})` : ''}` : r.reason + (r.idsTried ? `: ${r.idsTried.join(',')}` : ''),
        })
        if (r.ok) results[v.label][b.label].passes++
        process.stdout.write(r.ok ? '✓' : '✗')
      }
      process.stdout.write('\n')
    }
  }

  console.log('\n=== Pass rates ===')
  const header = ['variant'.padEnd(18), ...backends.map((b) => b.label.padEnd(28))].join(' │ ')
  console.log(header)
  console.log('─'.repeat(header.length))
  for (const v of VARIANTS) {
    const row = [
      v.label.padEnd(18),
      ...backends.map((b) => {
        const cell = results[v.label][b.label]
        const pct = Math.round((100 * cell.passes) / trialsPerVariant)
        return `${cell.passes}/${trialsPerVariant} (${pct}%)`.padEnd(28)
      }),
    ].join(' │ ')
    console.log(row)
  }

  console.log('\n=== Failures detail ===')
  for (const v of VARIANTS) {
    for (const b of backends) {
      const cell = results[v.label][b.label]
      const fails = cell.trials.filter((t) => !t.ok)
      if (fails.length > 0) {
        console.log(`  ${v.label} × ${b.label}:`)
        for (const f of fails) console.log(`    · ${f.detail}`)
      }
    }
  }
}

main().catch((err) => {
  console.error('crashed:', err)
  process.exit(1)
})
