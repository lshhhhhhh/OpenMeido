#!/usr/bin/env node
/**
 * End-to-end agent test: drives a real Gemini chat against the fake mail
 * adapter and verifies the model actually USES the email-with-context
 * data (items[i].parent) when summarizing replies.
 *
 * Goes one level deeper than smoke-fake-mail.mjs:
 *   - shape test confirms our adapter wires up parents correctly
 *   - THIS test confirms the model reads the parent and pairs it in its
 *     reply, which is the actual user-visible payoff
 *
 * Run: node --env-file=.env --import tsx tools/smoke-fake-mail-agent.mjs
 */

import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { stepCountIs, streamText, tool } from 'ai'
import { z } from 'zod'

import { createFakeMailAdapter } from '../src/main/mail/fake-adapter.ts'

// ---------- Test rig: real adapter wired to ai-sdk tools ----------

const adapter = createFakeMailAdapter()

const listRecentEmails = tool({
  description:
    '查看用户邮箱里最近的邮件。返回 items[] 的每一项是邮件摘要（id、from、subject、snippet、ts、unread）；' +
    '**如果某条邮件是回复某封信，items[i].parent 会包含用户当初发出的那封原信的摘要**' +
    '（同样的字段），用来生成"对方说了什么 + 你之前说了什么"的成对总结。' +
    'parent === null 表示是回复但找不到原信；parent === undefined 表示这条不是回复或没查。',
  inputSchema: z.object({
    limit: z.number().int().min(1).max(20),
    onlyUnread: z.boolean(),
  }),
  execute: async ({ limit, onlyUnread }) => {
    const items = await adapter.listInbox({ limit, onlyUnread })
    return { items }
  },
})

const readEmail = tool({
  description:
    '读取一封邮件的完整正文。id 必须来自上一次 listRecentEmails 的 items[].id。' +
    '如果是回复，返回结果会包含 parent 字段（同样的全字段结构）。',
  inputSchema: z.object({ id: z.string() }),
  execute: async ({ id }) => {
    const m = await adapter.readMessage(id)
    return m ?? { error: `id="${id}" not found` }
  },
})

// ---------- Driver ----------

async function drive({ model, prompt, tools, callLog }) {
  let visible = ''
  const result = streamText({
    model,
    temperature: 1,
    system:
      '你是用户的私人女仆。回答时用主人称呼用户。' +
      '看到工具的 parent 字段时，要把"对方说了什么"和"你之前说了什么"都点出来，' +
      '帮助主人快速建立对话上下文。1-3 句话即可。',
    prompt,
    tools,
    stopWhen: stepCountIs(3),
    maxRetries: 0,
  })
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') visible += part.text
    else if (part.type === 'tool-call') {
      callLog.push({ name: part.toolName, input: part.input })
    } else if (part.type === 'error') {
      throw part.error instanceof Error ? part.error : new Error(String(part.error))
    }
  }
  return visible
}

// ---------- Scoring ----------

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(ok ? `  ✅ ${name}` : `  ❌ ${name} :: ${detail}`)
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    console.error('GEMINI_API_KEY missing in .env')
    process.exit(1)
  }
  const model = createGoogleGenerativeAI({ apiKey })('gemini-2.5-flash')

  // ---------- Scenario 1: list — does the model pair at least one thread? ----------
  console.log('\n=== Scenario 1: "总结最近5封邮件" — does model pair parents? ===')
  {
    const callLog = []
    const visible = await drive({
      model,
      prompt: '主人想知道最近5封邮件的情况，请帮我总结，遇到回复要把我之前发的内容也带一下。',
      tools: { listRecentEmails, readEmail },
      callLog,
    })
    console.log(
      `Visible (${visible.length} chars):\n  ${visible.replace(/\n/g, '\n  ').slice(0, 800)}${visible.length > 800 ? '…' : ''}`,
    )

    check(
      'listRecentEmails was called',
      callLog.some((c) => c.name === 'listRecentEmails'),
      `got: ${callLog.map((c) => c.name).join(',')}`,
    )

    // The model should reference at least one threaded subject AND something
    // that ties back to the user's prior send. Keyword scan:
    //   Thread 1: "LunarLink" appears in BOTH inbound and sent
    //   Thread 2: "灰度" / "回滚" / "评审"
    //   Thread 3: "面试" / "二面" / "排期"
    //   Thread 4: "客户" / "演示" / "反馈"
    //   Thread 6: "合同" / "3.2"
    const threadKeywords = ['LunarLink', '灰度', '面试', '客户', '合同']
    const mentioned = threadKeywords.filter((k) => visible.includes(k))
    check(
      `model mentions at least 2 threaded subjects (got ${mentioned.length}: ${mentioned.join(',') || 'none'})`,
      mentioned.length >= 2,
    )

    // "用户之前说" indicator — words like "您问"/"您之前"/"主人之前"/"您发的".
    const senderHints = ['你问', '你之前', '您之前', '主人之前', '您发', '您让', '你让', '您交代', '你交代']
    const usedSenderHint = senderHints.some((h) => visible.includes(h))
    check(
      'reply uses "you previously..."-style framing (sign of parent usage)',
      usedSenderHint,
      `looked for: ${senderHints.join(' / ')}`,
    )
  }

  // ---------- Scenario 2: readEmail on a reply — model should narrate both sides ----------
  console.log('\n=== Scenario 2: "打开 LunarLink 那封" — pair on read ===')
  {
    const callLog = []
    const visible = await drive({
      model,
      prompt: '主人想看 LunarLink 那封邮件的具体内容，顺便告诉我之前发出去问的是什么。',
      tools: { listRecentEmails, readEmail },
      callLog,
    })
    console.log(
      `Visible (${visible.length} chars):\n  ${visible.replace(/\n/g, '\n  ').slice(0, 600)}${visible.length > 600 ? '…' : ''}`,
    )

    const readCall = callLog.find((c) => c.name === 'readEmail')
    check('readEmail was called', !!readCall, `got: ${callLog.map((c) => c.name).join(',')}`)
    if (readCall) {
      check(
        'readEmail id resolved to a real reply (101, 102, 103, 104, 108, or 109)',
        ['101', '102', '103', '104', '108', '109'].includes(readCall.input.id),
        `got id=${readCall.input.id}`,
      )
    }
    check('LunarLink subject is in the visible reply', visible.includes('LunarLink'))
    // The reply ("OAuth 卡住" / "周三") and the parent ("下周一" / "预发布")
    // give us discriminating tokens for each side.
    const replySide = ['OAuth', '周三', '顺延', 'Alice']
    const sentSide = ['下周一', '预发布', '进度', '问她', '问你', '问我', '你问', '问的是']
    const hasReply = replySide.some((k) => visible.includes(k))
    const hasSent = sentSide.some((k) => visible.includes(k))
    check(
      'reply text references the inbound side',
      hasReply,
      `looked for: ${replySide.join(' / ')}`,
    )
    check(
      'reply text references the sent (parent) side',
      hasSent,
      `looked for: ${sentSide.join(' / ')}`,
    )
  }

  // ---------- Scenario 3: standalone — model should NOT invent parent ----------
  console.log('\n=== Scenario 3: "看看 InfoQ 周刊那封" — control (no parent) ===')
  {
    const callLog = []
    const visible = await drive({
      model,
      prompt: '主人，看看 InfoQ 周刊那封说什么。',
      tools: { listRecentEmails, readEmail },
      callLog,
    })
    console.log(
      `Visible (${visible.length} chars):\n  ${visible.replace(/\n/g, '\n  ').slice(0, 400)}${visible.length > 400 ? '…' : ''}`,
    )
    const readCall = callLog.find((c) => c.name === 'readEmail')
    if (readCall) {
      check('readEmail id is the newsletter (106)', readCall.input.id === '106', `got ${readCall.input.id}`)
    }
    check(
      'model does NOT hallucinate "you previously sent"-style for a standalone',
      !['您之前发', '主人之前发', '你之前发', '您问', '你问的'].some((h) => visible.includes(h)),
      'model should treat this as a standalone newsletter',
    )
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
