/**
 * AI pipeline for the main process. Reads config every call so settings
 * changes apply immediately. Persists every turn to episodic memory and
 * injects retrieved context (recent window + semantic top-K) into the
 * model's message list before sending.
 */

import { createOpenAI } from '@ai-sdk/openai'
import { streamText, tool, type CoreMessage } from 'ai'
import { z } from 'zod'

import type { ChatEvent, ChatEventBody } from '../shared/ipc.js'
import { resolvePersona } from '../shared/config.js'
import { getConfig, resolveApiKey } from './config.js'
import { addEpisode, retrieve } from './memory/store.js'
import type { Episode } from './memory/episodic.js'

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

/**
 * Convert stored episodes into CoreMessage turns. Recent + recalled lists
 * are merged then sorted by id (creation order) so the model sees a coherent
 * timeline. Each recalled episode is silently included as a normal turn —
 * we deliberately don't mark them "from memory" to keep the model's voice
 * consistent.
 */
function episodesToMessages(episodes: Episode[]): CoreMessage[] {
  return episodes
    .slice()
    .sort((a, b) => a.id - b.id)
    .map((e) => ({
      role: e.speaker === 'user' ? 'user' : 'assistant',
      content: e.text,
    }))
}

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

    // Fire-and-forget the user-turn write. We don't await it — the model
    // call doesn't depend on storage finishing, and a slow embedding API
    // shouldn't block the user's reply latency.
    void addEpisode('user', userText, cfg)

    // Pull context BEFORE the model call so the retrieved messages can be
    // interleaved. retrieve() awaits embedding for the query, so this is
    // the one place where we do wait.
    const { recent, recalled } = await retrieve(userText, cfg)
    const historyMessages = episodesToMessages([...recalled, ...recent])

    const persona = resolvePersona(cfg.persona)
    const provider = createOpenAI({ baseURL: cfg.backend.baseUrl, apiKey })
    const now = new Date().toISOString()

    const messages: CoreMessage[] = [
      ...historyMessages,
      { role: 'user', content: userText },
    ]

    const result = streamText({
      model: provider(cfg.backend.model),
      temperature: 1,
      system:
        `${persona.systemPrompt}\n\n` +
        `[功能说明 — 不要让用户察觉]\n` +
        `当前时间：${now}\n` +
        `用户希望被提醒时（"提醒我..."、"...时叫我"等），调用 setReminder 工具。` +
        `工具调用后用人物语气自然回复一两句确认。\n` +
        `历史对话中可能包含很久以前的内容，请只在自然相关时引用，不要强行触发。`,
      messages,
      tools: { setReminder },
      maxSteps: 3,
    })

    // Accumulate the full assistant text so we can persist it after streaming.
    let assistantText = ''

    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta':
          assistantText += part.textDelta
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
          break
      }
    }

    // Persist the assistant reply if there was any visible text. Skip empty
    // replies (pure tool-call turns with no text content add no memory value
    // and would just clutter recall).
    if (assistantText.trim()) {
      void addEpisode('assistant', assistantText, cfg)
    }

    localEmit({ type: 'done' })
  } catch (err) {
    localEmit({
      type: 'error',
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
