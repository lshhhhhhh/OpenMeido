#!/usr/bin/env node
/**
 * Routing test for email-draft iteration.
 *
 * Tests the **path the renderer's UI takes** when the user clicks
 * "改一版" on a draft card:
 *   1. App.tsx builds a chat message containing replyToUid +
 *      previousBody + feedback.
 *   2. The chat loop is supposed to route that message to the
 *      `draftEmailReply` tool with arguments {uid, instruction,
 *      previousDraft}.
 *
 * This test exercises step 2 in isolation: it sends the iteration
 * message verbatim to DeepSeek with the `draftEmailReply` tool
 * exposed, and asserts the model calls the tool AND passes the
 * three arguments in their expected places.
 *
 * The tool's `execute` is a stub that records the call — we don't
 * actually re-draft. The goal is to verify ROUTING, not output
 * quality (output quality has its own test).
 *
 * Run: node --env-file=.env --import tsx tools/smoke-email-draft-routing.mjs
 */

import { generateText, tool, stepCountIs } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'

if (!process.env.DEEPSEEK_API_KEY) {
  console.error('no DEEPSEEK_API_KEY in .env')
  process.exit(1)
}

const ds = createOpenAI({
  baseURL: 'https://api.deepseek.com/v1',
  apiKey: process.env.DEEPSEEK_API_KEY,
})
const model = ds.chat('deepseek-chat')

// ---------- Capture stub: same schema + description as the real tool ----------

let lastCall = null

const draftEmailReply = tool({
  description:
    '帮用户起草一封回信。用于用户说"帮我回这封"、"草稿一下回复"、"写一版回复"、"再改一版"等场景。\n' +
    '内部会自动读取邮件 + 走 thread 上下文，调一次 LLM 用**用户本人的口吻**写一份草稿，' +
    '然后通过 side-channel 把草稿放进聊天里作为可复制 + 可改稿的卡片。\n' +
    '**id 来源**：跟 readEmail 一样，必须用 listRecentEmails 返回的真实 id。\n' +
    '**改稿**：用户说"再改一版，更简短/更正式/加一句确认时间"时，把上一次草稿的 body 作为 `previousDraft` 传回来，' +
    '加上用户的反馈作为 `instruction`。返回新草稿替换聊天里的旧卡片。',
  inputSchema: z.object({
    uid: z.string().describe('要回复的邮件 id（来自 listRecentEmails）'),
    instruction: z.string().optional().describe('可选：用户对回复内容的具体要求'),
    previousDraft: z.string().optional().describe('改稿时传：上一版草稿的正文'),
  }),
  execute: async (args) => {
    lastCall = args
    return {
      ok: true,
      cardId: `draft-${args.uid}-test`,
      note: '草稿已经放进聊天里。',
    }
  },
})

// ---------- The iteration message format App.tsx produces ----------

const FIRST_BODY = `林总你好，

我们这边的进度按计划走，本周内可以交付。需要我提前发个状态文档给你吗？

谢谢`

const ITERATION_MESSAGE =
  `请重新拟一版回信。要回的邮件 id 是 42。` +
  `用户的修改意见：更简短，去掉客套话\n\n` +
  `上一版正文（请基于这版调整）：\n${FIRST_BODY}`

// ---------- Test ----------

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(ok ? `  ✅ ${name}` : `  ❌ ${name}${detail ? ' — ' + detail : ''}`)
}

async function main() {
  console.log('████ Iteration message → draftEmailReply tool routing ████\n')
  console.log('User message sent to the chat loop:')
  console.log('---')
  console.log(ITERATION_MESSAGE)
  console.log('---\n')

  // System prompt mirrors what chat.ts would inject (minimal version).
  const system =
    '你是一个能调用工具帮用户处理工作的助手。' +
    '当用户提到要写邮件草稿、改邮件草稿、或者引用了 "邮件 id" + "上一版正文" 时，必须调用 draftEmailReply 工具。' +
    '不要自己直接写草稿——必须走工具。'

  let result
  try {
    result = await generateText({
      model,
      system,
      prompt: ITERATION_MESSAGE,
      tools: { draftEmailReply },
      stopWhen: stepCountIs(3),
      temperature: 0.2,
    })
  } catch (err) {
    check('generateText did not throw', false, err.message ?? String(err))
    process.exit(1)
  }

  // Routing assertions.
  check('tool was called', lastCall !== null)
  if (!lastCall) {
    console.log('\nDeepSeek text output (no tool call):')
    console.log(result.text.slice(0, 300))
    process.exit(1)
  }

  console.log('\nCaptured tool call args:')
  console.log(JSON.stringify(lastCall, null, 2).slice(0, 600))

  check('uid passed correctly', lastCall.uid === '42', `got "${lastCall.uid}"`)
  check(
    'instruction contains feedback signal',
    typeof lastCall.instruction === 'string' &&
      (lastCall.instruction.includes('简短') ||
        lastCall.instruction.includes('客套')),
    `got "${lastCall.instruction}"`,
  )
  check(
    'previousDraft is set',
    typeof lastCall.previousDraft === 'string' && lastCall.previousDraft.length > 20,
    `got length ${lastCall.previousDraft?.length ?? 0}`,
  )
  check(
    'previousDraft contains the original body text',
    typeof lastCall.previousDraft === 'string' &&
      lastCall.previousDraft.includes('按计划走'),
    'expected to contain "按计划走" from original body',
  )

  const failed = results.filter((r) => !r.ok)
  console.log(
    `\n${failed.length === 0 ? '✅' : '❌'} ${results.length - failed.length}/${results.length} routing assertions passed`,
  )
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('crashed:', err)
  process.exit(1)
})
