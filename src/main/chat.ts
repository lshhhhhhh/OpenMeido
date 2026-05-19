/**
 * AI pipeline for the main process. Reads config every call so settings
 * changes apply immediately. Persists every turn to episodic memory and
 * injects retrieved context (recent window + semantic top-K) into the
 * model's message list before sending.
 */

import { clipboard, dialog } from 'electron'
import { readFile as fsReadFile } from 'node:fs/promises'

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
import { Readability } from '@mozilla/readability'
// linkedom > jsdom for our use: pure-JS, no CJS/ESM transitive-dep mess (jsdom
// pulls @exodus/bytes which is ESM-only and breaks Vite's CJS bundling for
// the Electron main process). API is compatible with what Readability needs.
import { parseHTML } from 'linkedom'

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
    '**一回合最多调用一次**——切了就停，不要切完再切第二个表情。' +
    '不需要每条回复都调；只在情绪明确变化时调一次即可。',
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
    '查看用户邮箱里最近的邮件。用户提到"我有没有新邮件"、"最近邮件"、"某某发邮件了吗"时调用。\n' +
    '返回 items[] 的每一项是邮件摘要（id、from、subject、snippet、ts、unread）；' +
    '**如果某条邮件是回复某封信，items[i].parent 会包含用户当初发出的那封原信的摘要**' +
    '（同样的字段），用来生成"对方说了什么 + 你之前说了什么"的成对总结。' +
    'parent === null 表示是回复但找不到原信；parent === undefined 表示这条不是回复或没查。\n' +
    '如果用户问邮件细节正文，从某一项的 id 再调 readEmail 取全文。',
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

const readClipboard = tool({
  description:
    '读取用户当前剪贴板里的纯文本内容。用户说"看看我刚复制的"、' +
    '"剪贴板里那段是啥"、"帮我翻译/总结刚复制的"等时调用。' +
    '返回完整的剪贴板文本（截断到 20KB），可能为空字符串（用户没复制东西）。',
  inputSchema: z.object({}),
  execute: async () => {
    const text = clipboard.readText()
    if (!text || !text.trim()) {
      return { empty: true, text: '', note: '剪贴板里没有文本内容（可能是图片或者根本没复制东西）。' }
    }
    const MAX = 20_000
    const out = text.length > MAX ? text.slice(0, MAX) + '\n…[截断]' : text
    return { text: out, length: text.length }
  },
})

const readWebPage = tool({
  description:
    '抓取一个网页，提取出标题 + 正文，返回给你。' +
    '用户说"总结这个链接"、"读一下这个文章"、"这个网页讲什么"、' +
    '或者直接发一个 URL 等时调用。返回结构 { title, byline, content }。' +
    '`url` 必须是 http:// 或 https:// 开头的完整 URL。',
  inputSchema: z.object({
    url: z.string().describe('Full HTTP/HTTPS URL of the page to fetch and extract.'),
  }),
  execute: async ({ url }) => {
    if (!/^https?:\/\//i.test(url)) {
      return { error: '只支持 http:// 或 https:// 开头的完整 URL，不要传相对路径或单独的域名。' }
    }
    try {
      const ctl = new AbortController()
      // 20s timeout — slow CDN + Readability parse + everything else.
      const timer = setTimeout(() => ctl.abort(), 20_000)
      let res: Response
      try {
        res = await fetch(url, {
          headers: {
            // Some sites 403 on non-browser UA. Pretend to be Chrome.
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          signal: ctl.signal,
          redirect: 'follow',
        })
      } finally {
        clearTimeout(timer)
      }
      if (!res.ok) return { error: `HTTP ${res.status} from ${url}` }
      const ct = res.headers.get('content-type') || ''
      if (!/text\/html|application\/xhtml/i.test(ct)) {
        return { error: `${url} 返回的不是 HTML（content-type=${ct}），无法用 Readability 提取正文。` }
      }
      const html = await res.text()
      // linkedom's parseHTML returns { document, window, ... }. Readability
      // only touches `document`, so the parts of jsdom it doesn't replicate
      // (XHR, canvas, etc.) don't matter for us.
      const { document } = parseHTML(html)
      const reader = new Readability(document as unknown as Document)
      const article = reader.parse()
      if (!article || !article.textContent || article.textContent.trim().length < 40) {
        return { error: `Readability 无法从 ${url} 提取到正文（页面可能是 SPA、登录墙、或纯图片）。` }
      }
      // Cap text — 8000 chars covers any reasonable article and keeps the
      // model context bounded.
      const MAX = 8_000
      const trimmed = article.textContent.trim()
      const content = trimmed.length > MAX ? trimmed.slice(0, MAX) + '\n…[截断]' : trimmed
      return {
        title: article.title ?? '',
        byline: article.byline ?? '',
        excerpt: article.excerpt ?? '',
        content,
        url,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('aborted') || msg.includes('AbortError')) {
        return { error: `抓取 ${url} 超时（20 秒），网站可能太慢或被防火墙拦了。` }
      }
      return { error: msg }
    }
  },
})

const readFileTool = tool({
  description:
    '读取本地一个文本文件，返回文件内容供你总结或回答关于它的问题。\n' +
    '用户说"总结这个文件"、"打开 X 给我看看"、"读一下 readme"、' +
    '"我桌面上那个 X.md 写了啥"等时调用。\n' +
    '`path` 可以填具体的绝对路径（用户给的）；或者填空字符串 `""`，' +
    '系统会弹出文件选择器让用户挑文件。**用户没提路径时务必传空字符串**，' +
    '不要瞎编路径。\n' +
    '只支持文本类文件（.txt .md .json .csv .yaml .py .ts 等）；二进制文件会拒绝。',
  inputSchema: z.object({
    path: z
      .string()
      .describe(
        'Absolute file path, or empty string "" to pop up a file picker for the user.',
      ),
  }),
  execute: async ({ path }) => {
    let absPath = path.trim()
    if (!absPath) {
      // Empty path → pop a picker. Showing the dialog is a user-visible
      // action; we rely on the user clicking through to provide consent.
      const result = await dialog.showOpenDialog({
        title: '选择要总结的文件',
        properties: ['openFile'],
        filters: [
          { name: '文本/Markdown', extensions: ['txt', 'md', 'mdx', 'rst', 'log'] },
          { name: '配置/数据', extensions: ['json', 'yaml', 'yml', 'toml', 'csv', 'tsv', 'xml', 'ini'] },
          {
            name: '代码',
            extensions: [
              'js', 'ts', 'tsx', 'jsx', 'mjs', 'cjs',
              'py', 'go', 'rs', 'java', 'kt',
              'c', 'cpp', 'cc', 'h', 'hpp',
              'rb', 'php', 'sh', 'ps1', 'bat',
              'html', 'css', 'scss', 'sass',
              'sql', 'vue', 'svelte',
            ],
          },
          { name: '全部文件', extensions: ['*'] },
        ],
      })
      if (result.canceled || !result.filePaths[0]) {
        return { error: '用户取消了文件选择。' }
      }
      absPath = result.filePaths[0]
    }
    try {
      const buf = await fsReadFile(absPath)
      // Crude binary check: a null byte in the first 1KB strongly suggests
      // a binary file (text rarely contains \x00).
      const head = buf.subarray(0, Math.min(1024, buf.length))
      if (head.includes(0)) {
        return { error: `${absPath} 看起来是二进制文件（含有空字节），我读不了。` }
      }
      // Defend against huge log files — cap at 60KB of text. Past that we
      // truncate and tell the model.
      const MAX = 60_000
      const text = buf.toString('utf-8')
      const content = text.length > MAX ? text.slice(0, MAX) + '\n…[截断]' : text
      return {
        path: absPath,
        sizeBytes: buf.length,
        sizeChars: text.length,
        content,
        truncated: text.length > MAX,
      }
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

    // Fake-mail dev mode bypasses real IMAP config but the mail tools still
    // need to be exposed to the model — otherwise the synthetic data is
    // unreachable. mail-host.ts also reads OPENMEIDO_FAKE_MAIL; the two must
    // agree, hence the same env-var check here.
    const mailEnabled = cfg.mail.enabled || process.env.OPENMEIDO_FAKE_MAIL === '1'
    const result = streamText({
      model,
      temperature: 1,
      // System prompt is intentionally short. Tool-specific guidance (when to
      // call, what to pass, what NOT to call) lives in each tool's
      // `description` field — the model sees that next to the schema, which
      // is where the SDK and providers expect it. Code enforces the rules
      // that prompts alone can't (pre-tool narration roll-back, tool-name
      // leak guard, `</think>` filter, past-time guard in setReminder).
      // The remaining rules here are the few that are genuinely universal.
      system:
        `${persona.systemPrompt}\n\n` +
        (factsBlock ? `${factsBlock}\n` : '') +
        `[环境]\n` +
        `当前时间：${now}（被问时直接读，不要凭印象编。）\n` +
        `\n` +
        `# 工具\n` +
        `你有几个工具可用，每个工具自己的说明里写清楚了何时调用、参数怎么传。该调就直接调，不要先说"我帮您看一下"再调——结果出来后只说一次结果。\n` +
        (!mailEnabled
          ? `（邮箱功能用户没开启。如果用户问邮件，告诉他"邮箱还没接上，去 Settings → 邮箱 启用一下"，不要凭空捏造邮件内容。）\n`
          : '') +
        `\n` +
        `# 你做不了的事（用户问起就温柔说做不到）\n` +
        `点击界面 / 控制鼠标键盘 / 打开关闭程序窗口 / 下载上传文件 / 改系统设置 / 主动联网（除了用户给定 URL 的 readWebPage）。看图只能"看"和"说"，不能"做"。\n` +
        `\n` +
        `# 回复\n` +
        `1-3 句人物语气，不要复读 JSON。**绝不**在文字里输出 <think>、<tool_call>、JSON / XML、或任何函数名（setReminder/readEmail/...）——工具走专用通道，文字只用人物语气说话。**绝不**重复同一工具做同一件事（list 过就别再 list，read 过别再 read）。`,
      messages,
      // Conditional tool exposure: when mail isn't enabled, drop the email
      // tools entirely so the model doesn't see them in its function list.
      // Otherwise some models will (a) hallucinate that they can read mail
      // even when the tool returns "not configured", and (b) get stuck in
      // re-try loops calling the tool that always errors.
      tools: cfg.mail.enabled
        ? {
            setReminder,
            setLive2DExpression,
            readClipboard,
            readWebPage,
            readFile: readFileTool,
            listRecentEmails,
            readEmail,
          }
        : {
            setReminder,
            setLive2DExpression,
            readClipboard,
            readWebPage,
            readFile: readFileTool,
          },
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

    // Pre-tool narration suppressor. Almost every dup we saw in the wild
    // came from this pattern:
    //   step 1: "好的，主人，我这就帮您查看。" + tool_call
    //   step 2: "好的，主人，我这就帮您查看。\n\n[actual answer]"
    // — model emits the opener twice (pre-tool and post-tool) so the visible
    // bubble briefly shows both. Old fix was sentence-level dedup, which
    // worked but produced a jarring "many paragraphs then only the last"
    // flash because step 2's repeated sentences had to be displayed THEN
    // rolled back one by one.
    //
    // New strategy: any step whose text precedes a tool_call is treated as
    // narration that the final step will summarize anyway, so we roll back
    // the whole step's emitted text the moment the tool_call event fires.
    // Only the final step (the one without a trailing tool_call) keeps its
    // text. Result: user sees the agent "thinking" silently, tool chips
    // appearing, then one clean answer.
    let currentStepEmittedLen = 0

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
            // Implicit `</think>` arrived — roll back the reasoning prefix.
            assistantText = assistantText.slice(0, -resetLength)
            currentStepEmittedLen = Math.max(0, currentStepEmittedLen - resetLength)
            localEmit({ type: 'text-reset', length: resetLength })
          }
          if (clean) {
            flushCapIfBoundary('text')
            assistantText += clean
            curCap.text += clean
            currentStepEmittedLen += clean.length
            localEmit({ type: 'text', delta: clean })
          }
          break
        }
        case 'tool-call': {
          // Step boundary for live-capture (any buffered tool-results close
          // the previous step) and for the filter's </think> checkpoint.
          flushCapIfBoundary('tool-call')
          filter.checkpoint()
          // Roll back this step's pre-tool narration — it's almost always
          // redundant with what the post-tool step will say. See the long
          // comment near `currentStepEmittedLen`.
          if (currentStepEmittedLen > 0) {
            const len = currentStepEmittedLen
            assistantText = assistantText.slice(0, -len)
            curCap.text = curCap.text.slice(0, -len)
            currentStepEmittedLen = 0
            localEmit({ type: 'text-reset', length: len })
          }
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
      currentStepEmittedLen = Math.max(0, currentStepEmittedLen - flushed.resetLength)
      localEmit({ type: 'text-reset', length: flushed.resetLength })
    }
    if (flushed.emit) {
      assistantText += flushed.emit
      curCap.text += flushed.emit
      currentStepEmittedLen += flushed.emit.length
      localEmit({ type: 'text', delta: flushed.emit })
    }

    // Tool-name-only leak. Some models (Gemini 2.5 flash was seen doing
    // this in the wild) emit the function name as plain text instead of
    // using the tool-call channel. The user's bubble ends up showing
    // "setLive2DExpression" and the tool never actually fires. Detect the
    // exact-match case and replace with a graceful retry hint.
    const TOOL_NAMES = new Set([
      'setReminder',
      'setLive2DExpression',
      'readClipboard',
      'readWebPage',
      'readFile',
      'listRecentEmails',
      'readEmail',
    ])
    const trimmedFinal = assistantText.trim()
    if (trimmedFinal && TOOL_NAMES.has(trimmedFinal)) {
      console.warn(
        `[chat] model leaked tool name "${trimmedFinal}" as text — replacing with retry hint`,
      )
      localEmit({ type: 'text-reset', length: assistantText.length })
      const hint = '（嗯…我刚才走神了，主人能再问一次吗？）'
      assistantText = hint
      curCap.text = hint
      localEmit({ type: 'text', delta: hint })
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
