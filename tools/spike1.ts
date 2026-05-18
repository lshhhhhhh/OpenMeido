/**
 * Spike 1 — Headless AI pipeline check.
 *
 * Goal: prove the Vercel AI SDK + OpenAI + tool-calling round-trip works
 * end-to-end in a plain Node process, before any Electron/UI gets involved.
 *
 * What it does:
 *   1. Asks gpt-5.4-mini to set a reminder.
 *   2. Model emits a tool call (setReminder).
 *   3. Our local handler "executes" the tool (just logs + returns success).
 *   4. Model sees the tool result and produces a natural-language reply.
 *
 * Run:   npm run spike1
 * Needs: OPENAI_API_KEY in .env (loaded by `node --env-file=.env`)
 */

import { openai } from '@ai-sdk/openai'
import { generateText, tool } from 'ai'
import { z } from 'zod'

// In-memory reminder store — Spike only. Real impl will persist.
const reminders: Array<{ id: number; at: string; message: string }> = []

const setReminder = tool({
  description:
    'Schedule a local reminder. Use this whenever the user asks to be reminded ' +
    'about something at a specific time or after a delay.',
  parameters: z.object({
    at: z
      .string()
      .describe(
        'ISO 8601 datetime when the reminder should fire ' +
          '(e.g. "2026-05-17T15:30:00+08:00"). Always include a timezone offset.',
      ),
    message: z.string().describe('Short text shown to the user when the reminder fires.'),
  }),
  execute: async ({ at, message }) => {
    const id = reminders.length + 1
    reminders.push({ id, at, message })
    console.log(`  [tool] setReminder → id=${id} at=${at} msg=${JSON.stringify(message)}`)
    return { ok: true, id, scheduled_for: at }
  },
})

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not set. Did you run via `npm run spike1`?')
  }

  const now = new Date().toISOString()
  const userPrompt = '提醒我五分钟后喝水'

  console.log(`> user: ${userPrompt}`)
  console.log(`  (now = ${now})\n`)

  const result = await generateText({
    model: openai('gpt-5-mini'),
    // gpt-5.x reasoning models only accept default temperature=1
    temperature: 1,
    system:
      `You are OpenMeido, a helpful Japanese-maid-flavored productivity assistant. ` +
      `Current time: ${now}. ` +
      `When the user wants to be reminded of something, ALWAYS call the setReminder tool. ` +
      `Reply in the user's language.`,
    prompt: userPrompt,
    tools: { setReminder },
    // Let the SDK loop: call tool → feed result back → final text.
    maxSteps: 3,
  })

  console.log('\n--- final assistant reply ---')
  console.log(result.text || '(no text — model only returned tool calls)')
  console.log('\n--- summary ---')
  console.log(`steps:        ${result.steps.length}`)
  console.log(`tool calls:   ${result.steps.flatMap((s) => s.toolCalls).length}`)
  console.log(`reminders:    ${JSON.stringify(reminders, null, 2)}`)
  console.log(`finish reason: ${result.finishReason}`)
}

main().catch((err: unknown) => {
  console.error('Spike 1 failed:', err)
  process.exit(1)
})
