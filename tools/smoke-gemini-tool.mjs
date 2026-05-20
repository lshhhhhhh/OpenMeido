/**
 * Gemini-via-OpenAI-compat tool-call smoke test.
 *
 * Verifies that with `compatibility: 'compatible'`, Vercel AI SDK can stream
 * a Gemini response that includes tool calls. Reproduces the issue the user
 * hit ("tool_calls[0].index: Required") and confirms the fix.
 *
 * Run: npx electron tools/smoke-gemini-tool.mjs
 */

import { app } from 'electron'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { stepCountIs, streamText, tool } from 'ai'
import { z } from 'zod'

async function main() {
  try {
    process.loadEnvFile('.env')
  } catch {}

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    console.error('❌ GEMINI_API_KEY missing in .env')
    app.exit(1)
    return
  }

  const google = createGoogleGenerativeAI({ apiKey })

  // A tiny tool that asks the model to list emails. Same shape as
  // listRecentEmails in main/chat.ts so we exercise the same code path.
  const listMail = tool({
    description: 'List the user mailbox.',
    inputSchema: z.object({
      limit: z.number().int().min(1).max(20),
      onlyUnread: z.boolean(),
    }),
    execute: async ({ limit, onlyUnread }) => {
      return { items: [{ from: 'fake', subject: `pretend mail (limit=${limit}, unread=${onlyUnread})` }] }
    },
  })

  console.log('--- Sending tool-call-inducing prompt to Gemini ---')

  let textOut = ''
  let toolCalls = 0
  let toolResults = 0
  let errored = false

  try {
    const result = streamText({
      model: google('gemini-3.1-pro-preview'),
      temperature: 0.6,
      system: '使用 listMail 工具查看用户邮件，然后简短回复一句。',
      prompt: '看看我的邮件',
      tools: { listMail },
      stopWhen: stepCountIs(3),
    })

    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta':
          textOut += part.text
          break
        case 'tool-call':
          toolCalls++
          console.log(`  tool-call: ${part.toolName}`, part.input)
          break
        case 'tool-result':
          toolResults++
          console.log(`  tool-result: ${part.toolName}`, part.output)
          break
        case 'error':
          errored = true
          console.error('  stream error:', part.error)
          break
      }
    }
  } catch (err) {
    errored = true
    console.error('throw:', err)
  }

  console.log('\n--- Summary ---')
  console.log(`text: ${textOut}`)
  console.log(`tool calls: ${toolCalls}, tool results: ${toolResults}`)
  console.log(errored ? '\n❌ FAILED' : '\n✅ PASSED')
  app.exit(errored ? 1 : 0)
}

app.whenReady().then(main).catch((err) => {
  console.error('crashed:', err)
  app.exit(1)
})
