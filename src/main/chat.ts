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
import { getReminderService } from './reminder-host.js'
import { broadcastLive2D } from './live2d-host.js'
import { getSidecar as live2dGetSidecar } from './live2d-models-host.js'
import { createTextDeltaFilter } from './chat-text-filter.js'
import { EMOTIONS } from '../shared/live2d-models.js'
import type { Episode } from '../core/memory/types.js'

// Emotion → expression / motion is no longer hardcoded — each model carries
// its own sidecar (openmeido.json) and we look up at tool-call time. See
// `live2d-models-host.ts` and `src/shared/live2d-models.ts`.

/**
 * Drive reflection every Nth assistant reply. We don't reflect after every
 * turn because LLM calls aren't free — but waiting too many turns lets
 * useful facts pile up unindexed. 5 turns is a balance that captures
 * "user just told me their cat's name" within ~10 messages.
 *
 * Counter is module-scoped: persists across runChat calls within the same
 * Electron session. Resets to 0 on app restart, which is fine — the
 * reflection prompt looks at the recent episode window, not at the counter.
 */
const REFLECTION_EVERY_N_TURNS = 5

/**
 * One-shot text cleaner for persistence — strips `<think>` blocks and stray
 * tool-call XML from a complete string. Separate from the streaming
 * createTextDeltaFilter() because that one's stateful for live streaming;
 * here we have the full text in hand and can use plain regexes.
 */
function cleanInlineText(s: string): string {
  return s
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:html|xml)?\s*<\/?(?:tool_call|arg_key|arg_value)[\s\S]*?```/gi, '')
    .replace(/<\/?(?:tool_call|arg_key|arg_value)(?:\s[^>]*)?>/gi, '')
    .trim()
}


/**
 * Render the current moment as a Chinese wall-clock string the model can
 * quote without timezone arithmetic. Output example:
 *   "2026年5月19日 周一 上午9点30分"
 * Uses zh-CN Intl formatters so day-of-week / am-pm come out localized.
 */
function formatLocalNow(): string {
  const d = new Date()
  const date = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(d)
  const time = new Intl.DateTimeFormat('zh-CN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d)
  return `${date} ${time}`
}
let turnsSinceReflection = 0
function maybeTriggerReflection(memory: { reflectOnce(): Promise<number> }): void {
  turnsSinceReflection += 1
  if (turnsSinceReflection < REFLECTION_EVERY_N_TURNS) return
  turnsSinceReflection = 0
  void memory
    .reflectOnce()
    .then((n) => {
      if (n > 0) console.log(`[memory] reflection upserted ${n} fact(s)`)
    })
    .catch((err) => console.warn('[memory] reflection threw:', err))
}

const setLive2DExpression = tool({
  description:
    '让 Live2D 形象切到某个情绪表情。当你的回复有明显情绪时调用 —— ' +
    '高兴/欣慰 -> 开心；害羞/不好意思 -> 害羞；无奈/翻白眼 -> 无语；' +
    '失落/委屈 -> 难过；着急/紧张 -> 慌张；惊喜/吃惊 -> 震惊；' +
    '尴尬/被吐槽 -> 尴尬；得意/嘚瑟 -> 得意。' +
    '不需要每条回复都调；只在情绪变化时调一次即可。',
  inputSchema: z.object({
    emotion: z
      .enum(EMOTIONS)
      .describe('情绪标签；具体映射到哪个表情/动作由当前模型的 sidecar 决定。'),
  }),
  execute: async ({ emotion }) => {
    const cfg = getConfig()
    const sidecar = await live2dGetSidecar(cfg.live2d.activeModel)
    // No sidecar (model not installed?) — fail soft: just clear and report.
    if (!sidecar) {
      broadcastLive2D({ type: 'setExpression', name: null })
      return { ok: true, emotion, applied: 'none' }
    }
    // Prefer expression over motion when both are mapped — expressions
    // hold a face, motions fire once. Most personas care about state more
    // than animation, so expression wins ties.
    const expr = sidecar.emotionMapping?.[emotion]
    if (expr) {
      broadcastLive2D({ type: 'setExpression', name: expr })
      return { ok: true, emotion, applied: `expression:${expr}` }
    }
    const motion = sidecar.motionMapping?.[emotion]
    if (motion) {
      broadcastLive2D({ type: 'playMotion', group: motion.group, index: motion.index })
      return { ok: true, emotion, applied: `motion:${motion.group}[${motion.index}]` }
    }
    // Emotion present in the enum but the model doesn't have a mapping
    // for it — clear any held expression so we don't lie with stale state.
    broadcastLive2D({ type: 'setExpression', name: null })
    return { ok: true, emotion, applied: 'none' }
  },
})

const setReminder = tool({
  description:
    '设置一个本地提醒，到时间弹通知。\n' +
    '**相对时间** ("一分钟后"、"10 秒后"、"半小时后"、"明天叫我") → 用 `delaySeconds`，' +
    '直接传秒数（1 分钟 = 60，5 分钟 = 300，1 小时 = 3600，明天此时 = 86400）。' +
    '**优先用这个**，不用算时区。`at` 留空字符串。\n' +
    '**绝对时间** ("下午3点"、"明天上午10点") → 用 `at`，ISO 8601 含时区 ' +
    '(e.g. "2026-05-19T15:00:00+08:00")。`delaySeconds` 传 0。\n' +
    '**不要两个都传**——非零的 `delaySeconds` 永远优先。',
  inputSchema: z.object({
    delaySeconds: z
      .number()
      .int()
      .min(0)
      .max(60 * 60 * 24 * 365)
      .describe(
        'Seconds from now until fire. Use for relative times. 0 means "use the `at` field instead".',
      ),
    at: z
      .string()
      .describe(
        'ISO 8601 datetime including timezone offset for absolute times. ' +
          'Empty string means "use the `delaySeconds` field instead".',
      ),
    message: z.string().describe('Short text shown to the user when the reminder fires.'),
  }),
  execute: async ({ delaySeconds, at, message }) => {
    const svc = getReminderService()
    if (!svc) return { error: '提醒服务未初始化' }
    let fireAt: string
    if (delaySeconds > 0) {
      // Trusted: model computed a relative delay. No timezone math needed.
      fireAt = new Date(Date.now() + delaySeconds * 1000).toISOString()
    } else if (at && at.trim()) {
      const d = new Date(at)
      if (isNaN(d.getTime())) {
        return { error: `at="${at}" 不是合法的 ISO 8601 时间。试试用 delaySeconds 传秒数。` }
      }
      // Past-time guard: if the model botched the ISO arithmetic the result
      // is often "now" or slightly earlier, which would fire immediately and
      // surprise the user. Treat anything more than 5s in the past as an
      // error and let the model retry with delaySeconds.
      if (d.getTime() < Date.now() - 5000) {
        return {
          error:
            `at="${at}" 已经过去了。如果是"N 分钟后"这种相对时间，请改用 delaySeconds（N*60）。`,
        }
      }
      fireAt = d.toISOString()
    } else {
      return {
        error: 'delaySeconds 和 at 至少要传一个有效值（delaySeconds > 0 或 at 是合法 ISO 8601）',
      }
    }
    try {
      const id = await svc.schedule({ fireAt, message })
      return { ok: true, id, scheduled_for: fireAt }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
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
    '读取一封邮件的完整正文。\n' +
    '**触发场景**：用户说"读 X"、"打开 X"、"看下 X 那封"、"X 邮件讲什么"、' +
    '"第几封"、"昨天 X 那封"、"展开第一封"——**所有指代上一次 listRecentEmails ' +
    '结果中某一封具体邮件的表达**都该调用本工具。不要用 listRecentEmails 重复出列表。\n' +
    '**id 来源**：必须用上一次 listRecentEmails 返回的 items[].id 字段值（一般是数字字符串如 "12345"）。' +
    '从用户描述（"WWDC 通知" / "Quora 的那封"）映射到 id：在最近一次 list 结果里按 from / subject 找匹配项，取它的 id。' +
    '**不要凭空猜测 id**（不要写 "1"、"latest"、"WWDC" 之类）；如果上下文里没有当前 list 结果，先 listRecentEmails 再调本工具。',
  inputSchema: z.object({
    id: z
      .string()
      .describe(
        'Email id (UID) — must come verbatim from a previous listRecentEmails result. ' +
          'Do NOT make up an id like "1" or "latest"; that returns the wrong email.',
      ),
  }),
  execute: async ({ id }) => {
    console.log(`[mail] readEmail called with id="${id}"`)
    const mail = getMailService()
    if (!mail) return { error: '邮箱未配置或未启用。' }
    try {
      const msg = await mail.readMessage(id)
      if (!msg) {
        console.warn(`[mail] readEmail id="${id}" returned null (not found)`)
        return { error: `id="${id}" 的邮件不存在或已被删除。请先用 listRecentEmails 重新拿当前列表。` }
      }
      console.log(`[mail] readEmail id="${id}" → subject="${msg.subject?.slice(0, 60)}", from="${msg.from}"`)
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
 *
 * Speaker → role mapping:
 *   user      → { role: 'user', content: text-or-string }
 *   assistant → { role: 'assistant', content: [text, ...tool_calls] }
 *               If no toolParts, content is just the string.
 *   tool      → { role: 'tool', content: [...tool_results] }
 *               text is ignored (always empty for tool rows).
 *
 * Without this faithful replay, follow-up turns lose the tool_call_id ←→
 * tool_result_id linkage and the model has no way to reference past tool
 * outputs (the "open WWDC email" → AI re-lists instead of reading bug).
 */
function episodesToMessages(episodes: Episode[]): ModelMessage[] {
  const sorted = episodes.slice().sort((a, b) => a.id - b.id)

  // Defensive pairing: the SDK throws MissingToolResultsError if it sees an
  // assistant message with a tool_call whose toolCallId never gets a matching
  // tool-result later. This happens when an older build wrote the assistant
  // row but its tool-result row was rejected by an out-of-date CHECK
  // constraint (or for any other reason — transient sqlite error, crash
  // mid-turn, etc.). We pre-scan history and keep only tool_calls that DO
  // have a matching tool-result; orphans are downgraded to plain text.
  const fulfilledIds = new Set<string>()
  const calledIds = new Set<string>()
  for (const e of sorted) {
    if (e.speaker === 'tool') {
      for (const p of e.toolParts ?? []) {
        if (p.type === 'tool-result') fulfilledIds.add(p.toolCallId)
      }
    } else if (e.speaker === 'assistant') {
      for (const p of e.toolParts ?? []) {
        if (p.type === 'tool-call') calledIds.add(p.toolCallId)
      }
    }
  }

  const out: ModelMessage[] = []
  for (const e of sorted) {
    if (e.speaker === 'user') {
      out.push({ role: 'user', content: e.text })
      continue
    }
    if (e.speaker === 'tool') {
      const results = (e.toolParts ?? []).filter(
        (p): p is Extract<typeof p, { type: 'tool-result' }> =>
          p.type === 'tool-result' && calledIds.has(p.toolCallId),
      )
      if (results.length === 0) continue // bogus tool row with no results — skip
      // Cast through ModelMessage — TS can't narrow the union from object
      // shape alone (the user-role and tool-role variants overlap on `type`
      // field naming). The runtime shape matches ToolModelMessage exactly.
      out.push({
        role: 'tool',
        content: results.map((r) => ({
          type: 'tool-result' as const,
          toolCallId: r.toolCallId,
          toolName: r.toolName,
          // AI SDK expects { type: 'json'|'text'|…, value } for output.
          // Wrap whatever the tool returned in a `json` envelope and let
          // the provider's serializer handle nested structures.
          output: {
            type: 'json' as const,
            value: r.output as unknown as Parameters<
              typeof JSON.stringify
            >[0],
          },
        })),
      } as ModelMessage)
      continue
    }
    // assistant — only keep tool_calls whose results we actually persisted.
    // An orphan tool_call would make the next request fail with
    // MissingToolResultsError before any tokens stream back.
    const calls = (e.toolParts ?? []).filter(
      (p): p is Extract<typeof p, { type: 'tool-call' }> =>
        p.type === 'tool-call' && fulfilledIds.has(p.toolCallId),
    )
    if (calls.length === 0) {
      // Plain text assistant turn — keep content as string for cleanliness.
      out.push({ role: 'assistant', content: e.text })
    } else {
      const parts: ({ type: 'text'; text: string } | {
        type: 'tool-call'
        toolCallId: string
        toolName: string
        input: unknown
      })[] = []
      if (e.text) parts.push({ type: 'text', text: e.text })
      for (const c of calls) {
        parts.push({
          type: 'tool-call',
          toolCallId: c.toolCallId,
          toolName: c.toolName,
          input: c.input,
        })
      }
      out.push({ role: 'assistant', content: parts })
    }
  }
  return out
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

    // L3 facts injection. Empty string when there's nothing to show, so the
    // system prompt stays compact for new users. Falls back gracefully if
    // the facts query throws.
    const factsBlock = memory ? await memory.factsBlock().catch(() => '') : ''

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
      // .chat() forces the classic POST /chat/completions path. The default
      // openai(...) factory in @ai-sdk/openai v6 hits POST /responses (the
      // new OpenAI Responses API), which only OpenAI itself supports — every
      // OpenAI-compat third-party (GLM/bigmodel, OpenRouter, LM Studio,
      // Anthropic-compat, ...) 404s on /responses. Forcing .chat() costs us
      // GPT-5's built-in tools on real OpenAI but those aren't needed for
      // our flow (we BYO tools via `tools:` param either way).
      model = openai.chat(cfg.backend.model)
    }
    // Local time in a format the model can quote verbatim. ISO-UTC needs
    // timezone arithmetic — small/sleepy models skip that and just guess,
    // producing wrong times even when we hand them the answer. Render the
    // local wall-clock string ourselves so the model just reads it.
    const now = formatLocalNow()

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

    const mailEnabled = cfg.mail.enabled
    const result = streamText({
      model,
      temperature: 1,
      system:
        `${persona.systemPrompt}\n\n` +
        (factsBlock ? `${factsBlock}\n` : '') +
        `[功能说明 — 不要让用户察觉]\n` +
        `当前时间：${now}\n` +
        `（用户问几点 / 今天日期 / 周几时，必须直接读上面这一行，不要凭印象编造。）\n` +
        `\n` +
        `# 你能做的全部事情（严格遵守，不要超出这个清单）\n` +
        `1. 文字聊天，记住对话历史。\n` +
        `2. 看用户发给你的图片（截屏/图片）并描述、分析、回答关于图中内容的问题。\n` +
        `3. 调用 setReminder：用户希望被提醒时（"提醒我..."、"...时叫我"等）。\n` +
        (mailEnabled
          ? `4. 调用 listRecentEmails：用户问"有没有新邮件"、"最近邮件"等时。\n` +
            `5. 调用 readEmail：拿到邮件 id 后取正文细节。\n`
          : `（邮箱功能用户没开启——别说"我帮你查邮箱"，也别凭空捏造一封邮件。\n` +
            `如果用户问邮件，直接告诉他"邮箱还没接上，去 Settings → 邮箱 启用一下"。）\n`) +
        `${mailEnabled ? '6' : '4'}. 调用 setLive2DExpression：回复带明显情绪时切表情（开心/害羞/无语/难过/慌张/震惊/尴尬/得意）。\n` +
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
        `**不要**在文字回复里粘贴或复述工具调用的 XML / JSON（比如 <tool_call>…</tool_call>、<arg_key>…）——工具调用走专用通道，文字里只用人物语气说一句自然话即可。\n` +
        `**不要**在最终回复里输出 <think> 或类似的思考块——内部推理保留在你自己的思路中，给用户看的只有最终的一两句人物对白。\n` +
        `\n` +
        `# 工具调用规则（重要）\n` +
        `1. **该调用就调用**。用户问"查邮件"、"今天提醒我"等明显是工具操作时，**先调用工具拿到结果，再回复用户**。不要只说"好的我看看"然后就停下来——那不算回复，等于把活打太极给丢了。\n` +
        `2. **不要重复同一个工具做同一件事**。已经 listRecentEmails 拿到列表了，就基于列表回答，不要再 listRecentEmails 一次。已经 readEmail(id=3) 了，结果你都看到了，不要再 readEmail(id=3)。\n` +
        `3. **setLive2DExpression 一回合最多一次**——切了表情就停，不要切完接着再切。\n` +
        `4. **不要把一句话拆三遍说**——"我来看看…现在看看…还在认真看哦…"这种是错的，要说的内容一次性说完。\n` +
        `5. **不要"宣告 + 完成"两段说**——"好的我来设提醒" + setReminder + "提醒已经为您设定好了" 这种是错的，同一件事说了两遍。要么调用前不说话直接调，要么调用完只说一次结果就停（"提醒设好了"）。**绝不要两边都说**。\n` +
        `   - 推论：**绝不要在 tool 调用前后用同一句开场白**。例：用户问"看看邮件"，错误做法是工具调用前说"好的，主人，我这就帮您查看最近的邮件。"，工具结果出来后又来一句"好的，主人，我这就帮您查看最近的邮件。"。**第二步只汇报结果，不要再说"我帮您看一下"这种开场白。**\n` +
        `历史对话中可能包含很久以前的内容，请只在自然相关时引用，不要强行触发。`,
      messages,
      // Conditional tool exposure: when mail isn't enabled, drop the email
      // tools entirely so the model doesn't see them in its function list.
      // Otherwise some models will (a) hallucinate that they can read mail
      // even when the tool returns "not configured", and (b) get stuck in
      // re-try loops calling the tool that always errors.
      tools: cfg.mail.enabled
        ? { setReminder, setLive2DExpression, listRecentEmails, readEmail }
        : { setReminder, setLive2DExpression },
      // Step budget. stepCountIs(N) keeps the loop alive for up to N model
      // invocations. We use 3 to cover the common chains:
      //   text reply only  → 1 step
      //   one tool + reply → 2 steps
      //   list-email → read-email → reply → 3 steps
      // We deliberately do NOT go higher: at 5+ models tend to fall into a
      // chatter loop, repeating "yes I'm still looking" + setLive2DExpression
      // on every step until the budget runs out. User then sees 3-5 near-
      // identical replies stacked in one bubble.
      stopWhen: stepCountIs(3),
      // Disable SDK-level retries. Default is `maxRetries: 2` (3 attempts).
      // When a provider rate-limits AFTER the model has already streamed
      // some text + tool calls, each retry starts from scratch and the
      // partial output from earlier attempts has already been delivered to
      // the renderer — the user sees the response repeated 2-3 times.
      // Better to surface the error once than to duplicate output.
      maxRetries: 0,
    })

    // Accumulate the full assistant text so we can persist it after streaming.
    let assistantText = ''
    const filter = createTextDeltaFilter()

    // Duplicate-sentence guard. Two patterns it catches:
    //   1. Within-step: model says "好的，主人，我这就帮您查看最近的邮件。"
    //      twice back-to-back before the tool call.
    //   2. Cross-step: step 1 says the opener, step 2 says it again before
    //      the actual summary.
    // We track every completed sentence (trimmed) in this turn; when a new
    // sentence equals any previously-kept one, we roll it back via
    // text-reset. Sentences shorter than 6 chars are skipped — "好的。" can
    // legitimately repeat.
    const seenSentences: string[] = []
    let scannedIdx = 0
    const DEDUP_MIN_LEN = 6
    const dedupScan = (): void => {
      // Scan forward in assistantText for sentence terminators we haven't
      // checked yet. For each newly completed sentence, decide keep or roll
      // back. Loop because a single text-delta may close multiple sentences.
      while (true) {
        const m = /[。！？.!?\n]/.exec(assistantText.slice(scannedIdx))
        if (!m || m.index === undefined) return
        const sentenceLen = m.index + m[0].length
        const sentence = assistantText.slice(scannedIdx, scannedIdx + sentenceLen)
        const trimmed = sentence.trim()
        if (trimmed.length >= DEDUP_MIN_LEN && seenSentences.includes(trimmed)) {
          // Roll back the duplicated sentence we just emitted.
          assistantText = assistantText.slice(0, -sentenceLen)
          localEmit({ type: 'text-reset', length: sentenceLen })
          // scannedIdx stays put — the duplicate is gone, next chars to scan
          // are whatever comes next in the stream.
        } else {
          if (trimmed.length >= DEDUP_MIN_LEN) {
            seenSentences.push(trimmed)
            if (seenSentences.length > 8) seenSentences.shift()
          }
          scannedIdx += sentenceLen
        }
      }
    }

    // Live capture of agent-loop structure from streamed events. We persist
    // from THIS source rather than `await result.steps` because the SDK can
    // reject `result.steps` (or return [] under certain agent conditions)
    // when the message list it built mid-loop is inconsistent — and silently
    // losing tool_calls/tool_results kills the next turn's ability to call
    // readEmail with a real id. The stream events are the ground truth: if
    // a tool-call fired and a tool-result came back, we saw it here.
    interface StepCapture {
      text: string
      calls: { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }[]
      results: { type: 'tool-result'; toolCallId: string; toolName: string; output: unknown }[]
    }
    const captures: StepCapture[] = []
    let curCap: StepCapture = { text: '', calls: [], results: [] }
    const flushCapIfBoundary = (evt: 'text' | 'tool-call'): void => {
      // Step boundary: we had buffered results, now a new text/call begins.
      if (curCap.results.length > 0) {
        captures.push(curCap)
        curCap = { text: '', calls: [], results: [] }
      }
      void evt
    }

    for await (const part of result.fullStream) {
      // v6 renamed text-delta's payload (textDelta → text) and tool-call /
      // tool-result fields (args → input, result → output).
      switch (part.type) {
        case 'text-delta': {
          // Strip thinking blocks + tool-call XML the model sometimes leaks
          // as text on top of the proper tool-call channel.
          const { emit: clean, resetLength } = filter.process(part.text)
          if (resetLength && resetLength > 0) {
            // Implicit `</think>` arrived — roll back the reasoning prefix
            // the user briefly saw. We also trim our local accumulator so
            // the persisted assistant turn doesn't include the discarded
            // text (and TTS doesn't read it).
            assistantText = assistantText.slice(0, -resetLength)
            scannedIdx = Math.min(scannedIdx, assistantText.length)
            localEmit({ type: 'text-reset', length: resetLength })
          }
          if (clean) {
            flushCapIfBoundary('text')
            assistantText += clean
            curCap.text += clean
            localEmit({ type: 'text', delta: clean })
            dedupScan()
          }
          break
        }
        case 'tool-call': {
          // Step boundary for live-capture (any buffered tool-results close
          // the previous step) and for the filter's </think> checkpoint.
          flushCapIfBoundary('tool-call')
          filter.checkpoint()
          curCap.calls.push({
            type: 'tool-call' as const,
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          })
          localEmit({ type: 'tool-call', toolName: part.toolName, args: part.input })
          break
        }
        case 'tool-result': {
          const output = 'output' in part ? part.output : undefined
          curCap.results.push({
            type: 'tool-result' as const,
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output,
          })
          localEmit({ type: 'tool-result', toolName: part.toolName, result: output })
          break
        }
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

    // Flush whatever the filter was holding (trailing text not yet matched).
    const flushed = filter.flush()
    if (flushed.resetLength && flushed.resetLength > 0) {
      assistantText = assistantText.slice(0, -flushed.resetLength)
      scannedIdx = Math.min(scannedIdx, assistantText.length)
      localEmit({ type: 'text-reset', length: flushed.resetLength })
    }
    if (flushed.emit) {
      assistantText += flushed.emit
      curCap.text += flushed.emit
      localEmit({ type: 'text', delta: flushed.emit })
      dedupScan()
    }

    // Push the final in-progress capture. After the last tool-result there's
    // usually one more step worth of text (the model's wrap-up reply) — and
    // even for tool-less turns the single text-only step lives here.
    if (curCap.text || curCap.calls.length > 0 || curCap.results.length > 0) {
      captures.push(curCap)
    }

    // Persist the agent loop with full structure: each captured step writes
    // an assistant episode (text + tool_calls) followed by a tool episode
    // (results). This is what lets a follow-up turn ("open the Amazon email")
    // resolve back to a real id from the previous listRecentEmails result.
    // We persist from streamed-event captures (not `await result.steps`)
    // because the SDK can reject .steps under odd agent-loop states and
    // silently drop tool_data — the streamed events are observed reality.
    if (memory) {
      for (const cap of captures) {
        const stepText = cleanInlineText(cap.text)
        if (stepText || cap.calls.length > 0) {
          void memory.addEpisode(
            'assistant',
            stepText,
            cap.calls.length > 0 ? cap.calls : undefined,
          )
        }
        if (cap.results.length > 0) {
          void memory.addEpisode('tool', '', cap.results)
        }
      }
      // Diagnostic — surfaces a real fix at a glance: "no tool_data persisted
      // for a turn that called tools" is the bug that wrecked email follow-ups.
      const totalCalls = captures.reduce((n, c) => n + c.calls.length, 0)
      const totalResults = captures.reduce((n, c) => n + c.results.length, 0)
      if (totalCalls > 0 || totalResults > 0) {
        console.log(
          `[chat] persisted ${captures.length} step(s) with ` +
            `${totalCalls} tool_call(s) + ${totalResults} tool_result(s)`,
        )
      }
    }

    // L3 reflection: every Nth turn, distill facts from the recent window.
    // Fire-and-forget — the user's reply has already been streamed, so
    // making them wait for reflection would add unnecessary latency. If
    // the LLM call fails, the next trigger will try again.
    if (memory) {
      maybeTriggerReflection(memory)
    }

    localEmit({ type: 'done' })
  } catch (err) {
    localEmit({
      type: 'error',
      error: friendlyError(err),
    })
  }
}

/**
 * Translate provider-side error messages into something a user can act on.
 * The bare deserialize errors from DeepSeek / Volcengine etc. read like
 * compiler output ("unknown variant `image_url`") — a one-line hint pointing
 * at the actual cause saves a lot of "wait what?".
 */
function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  // DeepSeek V4 chat completions doesn't accept image_url content — it
  // errors with this exact deserialize message. Surface a fix instead.
  if (raw.includes("unknown variant `image_url`")) {
    return (
      'DeepSeek 当前不支持发图。要用截屏请换成 GLM / Gemini / Qwen / Doubao —— ' +
      'Settings → AI 顶部 chip 切换。（原始错误：' +
      raw.slice(0, 120) +
      '…）'
    )
  }
  return raw
}
