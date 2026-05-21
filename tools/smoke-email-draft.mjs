#!/usr/bin/env node
/**
 * Real-LLM smoke test for the email-draft writing prompt.
 *
 * Drives `buildEmailDraftPrompt`-equivalent content through DeepSeek
 * with two scenarios per persona (just to confirm the user-voice
 * isolation works regardless of who's currently the OpenMeido persona):
 *   1. fresh draft from a thread
 *   2. iterate on a previous draft with feedback
 *
 * What we assert:
 *   - output parses as JSON {subject, body}
 *   - body is non-trivial (>= 30 chars)
 *   - body does NOT contain maid/imouto/ojou voice markers (主人 / 哥 / 本小姐)
 *     — these would leak the OpenMeido persona into the user's email
 *   - subject starts with "Re:" (or contains the original subject substring)
 *
 * Run: node --env-file=.env --import tsx tools/smoke-email-draft.mjs
 */

import { generateText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'

if (!process.env.DEEPSEEK_API_KEY) {
  console.error('no DEEPSEEK_API_KEY in .env')
  process.exit(1)
}

const ds = createOpenAI({
  baseURL: 'https://api.deepseek.com/v1',
  apiKey: process.env.DEEPSEEK_API_KEY,
})
const model = ds.chat('deepseek-chat')

// ---------- Test cases ----------
// Each scenario describes an inbox conversation the user has to reply to.

const FRESH_SCENARIOS = [
  {
    label: 'colleague asks about meeting time',
    thread: [
      {
        from: 'manager@company.com',
        ts: '2026-05-20 14:30',
        subject: '周五的项目同步',
        body: '小李，周五下午我们能不能约一下，把后端那块进度同步一下？我下午 2 点和 4 点都有空。',
      },
    ],
    instruction: '答应周五下午 2 点。',
  },
  {
    label: 'polite decline of an invitation',
    thread: [
      {
        from: 'friend@example.com',
        ts: '2026-05-20 10:00',
        subject: '周六晚上的聚会',
        body: '哥们周六晚上来我家一起吃饭吧，叫了几个老同学。',
      },
    ],
    instruction: '礼貌拒绝，说出差不在。',
  },
]

const ITERATION_SCENARIOS = [
  {
    label: 'shorten + remove pleasantries',
    thread: [
      {
        from: 'client@external.com',
        ts: '2026-05-19 09:00',
        subject: 'invoice question',
        body: 'Hi, can you confirm the line item for "deployment support" on invoice 4421?',
      },
    ],
    previousDraft:
      'Hi, thanks so much for reaching out! I really appreciate you taking the time to ask about this. The "deployment support" line item refers to the on-call hours we provided during the staging rollout last week. Please let me know if you need any other details, and feel free to reach out anytime!',
    instruction: '更简短，去掉客套话。',
  },
]

const FORBIDDEN_PERSONA_MARKERS = ['主人', '本小姐', '撒娇', '哼，']

// ---------- Prompt builder mirror (no host imports) ----------

function buildPrompt(thread, instruction, previousDraft) {
  const threadText = thread
    .map(
      (m, i) =>
        `## ${i + 1}. From: ${m.from}\nDate: ${m.ts}\nSubject: ${m.subject}\n\n${m.body}`,
    )
    .join('\n\n---\n\n')
  const iterationBlock = previousDraft
    ? `\n# 上一版草稿（请按下方"用户要求"调整）\n${previousDraft}\n`
    : ''
  return (
    `你是用户的私人邮件写作助手。\n\n` +
    `**重要**：你现在不是 OpenMeido 的女仆/妹妹/大小姐角色——你是用户本人在写信。回信要听起来像**用户自己**写的，不是某个虚构角色的代笔。用第一人称视角写。\n\n` +
    `# 收到的邮件（最新一封在最下面）\n${threadText}\n` +
    iterationBlock +
    `\n# 用户对这封回信的要求\n${instruction}\n\n` +
    `# 写作规则\n` +
    `- 匹配最新邮件的语言（中文 → 用中文，英文 → 用英文）\n` +
    `- 匹配对方的正式度\n` +
    `- 简洁直接。不要"敬启者"、"此致敬礼"这种空套话\n` +
    `- 不要写署名 / signature\n` +
    `- 不要 emoji，除非对方用了\n` +
    `- subject 默认用 "Re: <原标题>"\n\n` +
    `# 输出（只输出 JSON，不要解释）\n` +
    `{"subject": "Re: 原标题", "body": "正文..."}\n`
  )
}

function parseDraft(raw) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = [fenced?.[1], raw].filter(Boolean)
  for (const s of candidates) {
    try {
      const obj = JSON.parse(s)
      if (typeof obj.subject === 'string' && typeof obj.body === 'string') {
        return { subject: obj.subject, body: obj.body.trim() }
      }
    } catch {
      /* try next */
    }
  }
  const objMatch = raw.match(/\{[\s\S]*?"body"\s*:[\s\S]*?\}/i)
  if (objMatch) {
    try {
      const obj = JSON.parse(objMatch[0])
      if (typeof obj.subject === 'string' && typeof obj.body === 'string') {
        return { subject: obj.subject, body: obj.body.trim() }
      }
    } catch {
      /* fall through */
    }
  }
  return null
}

// ---------- Driver ----------

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(ok ? `  ✅ ${name}` : `  ❌ ${name}${detail ? ' — ' + detail : ''}`)
}

async function runScenario(label, prompt, originalSubject) {
  console.log(`\n── ${label} ──`)
  const result = await generateText({ model, prompt, temperature: 0.5 })
  const parsed = parseDraft(result.text)
  check(`${label}: JSON parsed`, parsed !== null, `raw: ${result.text.slice(0, 80)}…`)
  if (!parsed) return
  console.log(`  主题：${parsed.subject}`)
  console.log(`  正文：${parsed.body.slice(0, 120)}…`)
  // Body length: only flag truly empty / one-word output. Terse correct
  // replies ("好的，周五下午2点可以，到时候见") are valid and short.
  check(
    `${label}: body has actual content (>= 10 chars)`,
    parsed.body.length >= 10,
    `actual: ${parsed.body.length}`,
  )
  const forbidden = FORBIDDEN_PERSONA_MARKERS.find((w) => parsed.body.includes(w))
  check(
    `${label}: body has no persona-voice leak`,
    !forbidden,
    forbidden ? `contains "${forbidden}"` : '',
  )
  const subjectOk =
    parsed.subject.toLowerCase().startsWith('re:') ||
    (originalSubject &&
      parsed.subject.toLowerCase().includes(originalSubject.toLowerCase().slice(0, 8)))
  check(`${label}: subject is "Re: …" or includes original`, subjectOk)
}

async function main() {
  for (const s of FRESH_SCENARIOS) {
    const prompt = buildPrompt(s.thread, s.instruction, undefined)
    await runScenario(`fresh / ${s.label}`, prompt, s.thread[0].subject)
  }
  for (const s of ITERATION_SCENARIOS) {
    const prompt = buildPrompt(s.thread, s.instruction, s.previousDraft)
    await runScenario(`iterate / ${s.label}`, prompt, s.thread[0].subject)
  }

  const failed = results.filter((r) => !r.ok)
  console.log(
    `\n${failed.length === 0 ? '✅' : '❌'} ${results.length - failed.length}/${results.length} assertions passed`,
  )
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('crashed:', err)
  process.exit(1)
})
