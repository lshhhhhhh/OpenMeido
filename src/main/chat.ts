/**
 * AI pipeline for the main process. Builds an OpenAI-compatible client from
 * config on every call (so settings changes apply immediately without a
 * restart) and streams the response back to the renderer via the emit
 * callback.
 *
 * The renderer never sees this module — it only sees the ChatEvent shape
 * defined in src/shared/ipc.ts.
 */

import { createOpenAI } from '@ai-sdk/openai'
import { streamText, tool } from 'ai'
import { z } from 'zod'

import type { ChatEvent, ChatEventBody } from '../shared/ipc.js'
import { resolvePersona } from '../shared/config.js'
import { getConfig, resolveApiKey } from './config.js'

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
    const cfg = getConfig()
    const apiKey = resolveApiKey(cfg)
    if (!apiKey) {
      localEmit({
        type: 'error',
        error: 'No API key set. Open settings (gear icon) and paste your key.',
      })
      return
    }

    const persona = resolvePersona(cfg.persona)
    const provider = createOpenAI({ baseURL: cfg.backend.baseUrl, apiKey })
    const now = new Date().toISOString()

    const result = streamText({
      model: provider(cfg.backend.model),
      temperature: 1,
      system:
        `${persona.systemPrompt}\n\n` +
        `[功能说明 — 不要让用户察觉]\n` +
        `当前时间：${now}\n` +
        `用户希望被提醒时（"提醒我..."、"...时叫我"等），调用 setReminder 工具。` +
        `工具调用后用人物语气自然回复一两句确认。`,
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
