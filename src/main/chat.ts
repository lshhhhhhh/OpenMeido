/**
 * AI pipeline for the main process. Same shape as tools/spike1.ts, but:
 *   - uses streamText (incremental output) instead of generateText
 *   - emits events through a callback so the IPC layer can forward to renderer
 *
 * The renderer never sees this module — it only sees the ChatEvent shape
 * defined in src/shared/ipc.ts.
 */

import { openai } from '@ai-sdk/openai'
import { streamText, tool } from 'ai'
import { z } from 'zod'

import type { ChatEvent, ChatEventBody } from '../shared/ipc.js'

// Spike-only in-memory reminder store. Real impl will persist to sqlite.
interface Reminder {
  id: number
  at: string
  message: string
}
const reminders: Reminder[] = []

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
    return { ok: true, id, scheduled_for: at }
  },
})

export async function runChat(
  messageId: string,
  userText: string,
  emit: (event: ChatEvent) => void,
): Promise<void> {
  const localEmit = (body: ChatEventBody): void => emit({ messageId, ...body })

  try {
    if (!process.env.OPENAI_API_KEY) {
      localEmit({ type: 'error', error: 'OPENAI_API_KEY not set in main process' })
      return
    }

    const now = new Date().toISOString()
    const result = streamText({
      model: openai('gpt-5-mini'),
      temperature: 1,
      system:
        `You are OpenMeido, a helpful Japanese-maid-flavored productivity assistant. ` +
        `Current time: ${now}. ` +
        `When the user wants to be reminded of something, ALWAYS call the setReminder tool. ` +
        `Reply in the user's language.`,
      prompt: userText,
      tools: { setReminder },
      maxSteps: 3,
    })

    // fullStream yields a typed union covering text deltas, tool calls,
    // tool results, step boundaries, and the final finish event.
    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta':
          localEmit({ type: 'text', delta: part.textDelta })
          break
        case 'tool-call':
          localEmit({ type: 'tool-call', toolName: part.toolName, args: part.args })
          break
        case 'tool-result':
          localEmit({ type: 'tool-result', toolName: part.toolName, result: part.result })
          break
        case 'error':
          localEmit({
            type: 'error',
            error: part.error instanceof Error ? part.error.message : String(part.error),
          })
          return
        default:
          // step-start / step-finish / finish — not surfaced to renderer for now
          break
      }
    }
    localEmit({ type: 'done' })
  } catch (err) {
    localEmit({
      type: 'error',
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
