/**
 * AI pipeline for the main process. Reads config every call so settings
 * changes apply immediately. Persists every turn to episodic memory and
 * injects retrieved context (recent window + semantic top-K) into the
 * model's message list before sending.
 */

import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import {
  stepCountIs,
  streamText,
  tool,
  type LanguageModel,
  type ModelMessage,
} from 'ai'
import { z } from 'zod'

import type { ChatEvent, ChatEventBody, ChatImageAttachment } from '../shared/ipc.js'
import { resolvePersona } from '../shared/config.js'
import { getConfig, resolveApiKey } from './config.js'
import { getMemoryService } from './memory-host.js'
import { getMailService } from './mail-host.js'
import type { Episode } from '../core/memory/types.js'

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
  inputSchema: z.object({
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

const listRecentEmails = tool({
  description:
    '查看用户邮箱里最近的邮件。用户提到"我有没有新邮件"、"最近邮件"、"某某发邮件了吗"时调用。' +
    '返回的是邮件摘要（发件人、标题、片段、时间），不是完整正文——如果用户问邮件细节，' +
    '从返回结果里挑出 id 再调 readEmail 取正文。',
  // OpenAI's strict tool schema requires every property in `properties` to
  // also appear in `required`. Zod .default() / .optional() produce
  // properties that are NOT required, and the API rejects the whole tool.
  // So both fields are mandatory here; the description tells the model
  // sensible values to use when the user didn't specify.
  inputSchema: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .describe('Number of recent messages to fetch. Use 10 unless the user asks for more.'),
    onlyUnread: z
      .boolean()
      .describe('If true, only return unread messages. Use false unless the user asks for unread only.'),
  }),
  execute: async ({ limit, onlyUnread }) => {
    const mail = getMailService()
    if (!mail) return { error: '邮箱未配置或未启用，请在设置里开启邮箱并填写 IMAP 信息。' }
    try {
      const items = await mail.listInbox({ limit, onlyUnread })
      return { items }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  },
})

const readEmail = tool({
  description:
    '读取一封邮件的完整正文。先用 listRecentEmails 拿到 id，再用这个 tool 取详情。',
  inputSchema: z.object({
    id: z.string().describe('Email id (UID) from a previous listRecentEmails result.'),
  }),
  execute: async ({ id }) => {
    const mail = getMailService()
    if (!mail) return { error: '邮箱未配置或未启用。' }
    try {
      const msg = await mail.readMessage(id)
      if (!msg) return { error: '该邮件不存在或已被删除。' }
      // Cap body length so a 200KB email doesn't blow the model context.
      const MAX_BODY = 4000
      const body = msg.body.length > MAX_BODY ? msg.body.slice(0, MAX_BODY) + '\n…[truncated]' : msg.body
      return { ...msg, body }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  },
})

/**
 * Convert stored episodes into ModelMessage turns. Recent + recalled lists
 * are merged then sorted by id (creation order) so the model sees a coherent
 * timeline. Each recalled episode is silently included as a normal turn —
 * we deliberately don't mark them "from memory" to keep the model's voice
 * consistent.
 */
function episodesToMessages(episodes: Episode[]): ModelMessage[] {
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
  images: ChatImageAttachment[] | undefined,
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

    const memory = getMemoryService()

    // Fire-and-forget the user-turn write. We don't await it — the model
    // call doesn't depend on storage finishing, and a slow embedding API
    // shouldn't block the user's reply latency.
    if (memory) void memory.addEpisode('user', userText)

    // Pull context BEFORE the model call so the retrieved messages can be
    // interleaved. retrieve() awaits embedding for the query, so this is
    // the one place where we do wait.
    const { recent, recalled } = memory
      ? await memory.retrieve(userText)
      : { recent: [], recalled: [] }
    const historyMessages = episodesToMessages([...recalled, ...recent])

    const persona = resolvePersona(cfg.persona)

    // Provider routing. Gemini's OpenAI-compat shim drops fields
    // (tool_calls[].index) that Vercel AI SDK's strict OpenAI parser
    // requires, so for Gemini we use the native Google provider instead.
    // Other endpoints (OpenAI, LM Studio, Anthropic-compat) stay on the
    // OpenAI-compatible path with relaxed validation.
    let model: LanguageModel
    if (cfg.backend.baseUrl.includes('googleapis.com')) {
      const google = createGoogleGenerativeAI({ apiKey })
      model = google(cfg.backend.model)
    } else {
      const openai = createOpenAI({
        baseURL: cfg.backend.baseUrl,
        apiKey,
      })
      model = openai(cfg.backend.model)
    }
    const now = new Date().toISOString()

    // Multimodal user turn: text + N images via Vercel AI SDK's structured
    // content array. When the user attached nothing the content stays as a
    // plain string for the common text-only case.
    const userContent =
      images && images.length > 0
        ? [
            { type: 'text' as const, text: userText },
            ...images.map((img) => ({
              type: 'image' as const,
              image: Buffer.from(img.base64, 'base64'),
              mimeType: img.mimeType,
            })),
          ]
        : userText

    const messages: ModelMessage[] = [
      ...historyMessages,
      { role: 'user', content: userContent },
    ]

    const result = streamText({
      model,
      temperature: 1,
      system:
        `${persona.systemPrompt}\n\n` +
        `[功能说明 — 不要让用户察觉]\n` +
        `当前时间：${now}\n` +
        `\n` +
        `# 你能做的全部事情（严格遵守，不要超出这个清单）\n` +
        `1. 文字聊天，记住对话历史。\n` +
        `2. 看用户发给你的图片（截屏/图片）并描述、分析、回答关于图中内容的问题。\n` +
        `3. 调用 setReminder：用户希望被提醒时（"提醒我..."、"...时叫我"等）。\n` +
        `4. 调用 listRecentEmails：用户问"有没有新邮件"、"最近邮件"等时。\n` +
        `5. 调用 readEmail：拿到邮件 id 后取正文细节。\n` +
        `\n` +
        `# 你不能做的事（绝对不要主动提议，也不要假装能做）\n` +
        `- 不能点击、关闭、打开任何程序、窗口、文件夹、文件\n` +
        `- 不能控制鼠标、键盘、播放器、浏览器\n` +
        `- 不能保存截屏、下载文件、上传文件\n` +
        `- 不能上网搜索、打开网页、调用任何外部 API（邮箱除外）\n` +
        `- 不能修改用户的系统设置、音量、亮度\n` +
        `- 看图时只能"看"和"说"，不能"做"\n` +
        `如果用户要你做以上事情，用人物语气温柔说明你只能聊天和看，做不了实际操作。\n` +
        `\n` +
        `# 风格\n` +
        `工具调用后用人物语气自然回复一两句，不要复读 JSON。\n` +
        `历史对话中可能包含很久以前的内容，请只在自然相关时引用，不要强行触发。`,
      messages,
      tools: { setReminder, listRecentEmails, readEmail },
      // v6 renamed maxSteps → stopWhen. stepCountIs(N) keeps the loop alive
      // for up to N model invocations (list email → read email → reply = 3).
      stopWhen: stepCountIs(5),
    })

    // Accumulate the full assistant text so we can persist it after streaming.
    let assistantText = ''

    for await (const part of result.fullStream) {
      // v6 renamed text-delta's payload (textDelta → text) and tool-call /
      // tool-result fields (args → input, result → output).
      switch (part.type) {
        case 'text-delta':
          assistantText += part.text
          localEmit({ type: 'text', delta: part.text })
          break
        case 'tool-call':
          localEmit({ type: 'tool-call', toolName: part.toolName, args: part.input })
          break
        case 'tool-result':
          localEmit({
            type: 'tool-result',
            toolName: part.toolName,
            result: 'output' in part ? part.output : undefined,
          })
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
    if (assistantText.trim() && memory) {
      void memory.addEpisode('assistant', assistantText)
    }

    localEmit({ type: 'done' })
  } catch (err) {
    localEmit({
      type: 'error',
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
