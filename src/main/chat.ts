/**
 * AI pipeline for the main process. Reads config every call so settings
 * changes apply immediately. Persists every turn to episodic memory and
 * injects retrieved context (recent window + semantic top-K) into the
 * model's message list before sending.
 */

import { clipboard, dialog } from 'electron'
import { readFile as fsReadFile } from 'node:fs/promises'
import { extname } from 'node:path'
import * as mammoth from 'mammoth'

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
import { formatLocalNow } from '../shared/time-format.js'
import {
  performanceModel,
  visionModel,
  resolveTemperature,
} from '../shared/lightweight-models.js'
import { getConfig, resolveApiKey } from './config.js'
import { getMemoryService } from './memory-host.js'
import { getMailService } from './mail-host.js'
import { getTaskService } from './tasks-host.js'
import { createTextDeltaFilter } from './chat-text-filter.js'
import { classifyAndApply } from './emotion-classifier.js'
import { runExtraction } from './chat-host.js'
import { buildTierPromptBlock } from '../shared/affinity.js'
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
// formatLocalNow lives in shared/time-format.ts so greeting-host etc. can
// import it without taking a dependency on the chat module.
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

// setLive2DExpression tool was removed in favor of post-reply emotion
// classification — see src/main/emotion-classifier.ts. The classifier is
// always invoked once per reply with a lightweight LLM call, so every
// turn ends with the right face instead of whatever was held last.

// Note: Kimi's `$web_search` builtin function is NOT supported. Their
// protocol sends `type: "builtin_function"` in streaming tool_calls,
// which the Vercel AI SDK's strict OpenAI-compat parser rejects. Their
// official docs only demonstrate the feature in NON-streaming mode
// (chat.completions.create without stream:true). Adding it would
// require bypassing streamText for that turn, which costs us all the
// other tool integrations. Users wanting web search on Kimi should
// switch to Gemini or GLM for the moment.

/**
 * Resolve a fireAt ISO from the model's input. Returns null when no
 * notification was requested (pure TODO), or an error when the input is
 * malformed / in the past.
 */
function resolveFireAt(
  delaySeconds: number,
  at: string,
): { fireAt: string | null } | { error: string } {
  if (delaySeconds > 0) {
    return { fireAt: new Date(Date.now() + delaySeconds * 1000).toISOString() }
  }
  if (at && at.trim()) {
    const d = new Date(at)
    if (isNaN(d.getTime())) {
      return { error: `at="${at}" 不是合法的 ISO 8601 时间。试试用 delaySeconds 传秒数。` }
    }
    if (d.getTime() < Date.now() - 5000) {
      return {
        error: `at="${at}" 已经过去了。如果是"N 分钟后"这种相对时间，请改用 delaySeconds（N*60）。`,
      }
    }
    return { fireAt: d.toISOString() }
  }
  return { fireAt: null }
}

const addTask = tool({
  description:
    '把一项待办事项加到主人的清单里。可选地附加一个通知时间。\n' +
    '\n' +
    '**用法**：\n' +
    '- 纯 TODO（没有时间，主人手动勾掉）：`delaySeconds: 0, at: ""`。例："记一下回老板邮件"、"别忘了周报"。\n' +
    '- 带定时提醒（到时间弹通知，任务仍留在清单上直到主人勾掉）：' +
    '相对时间用 `delaySeconds`（5 分钟 = 300，1 小时 = 3600，明天此时 = 86400）；' +
    '绝对时间用 `at`（ISO 8601 含时区）。**只传一个，另一个留 0 或 ""。**\n' +
    '\n' +
    '触发场景：' +
    '"提醒我 X 分钟后..." / "X 时候叫我..." → 加 delaySeconds 或 at；' +
    '"记一下" / "别忘了" / "回头要 X" → 不传 fireAt。',
  inputSchema: z.object({
    text: z.string().describe('任务内容，简洁一句话。'),
    delaySeconds: z
      .number()
      .int()
      .min(0)
      .max(60 * 60 * 24 * 365)
      .describe('Seconds from now until notification. 0 = no time / use `at` instead.'),
    at: z
      .string()
      .describe(
        'ISO 8601 datetime with timezone offset. Empty string = no time / use `delaySeconds`.',
      ),
  }),
  execute: async ({ text, delaySeconds, at }) => {
    const svc = getTaskService()
    if (!svc) return { error: '任务服务未初始化' }
    if (!text.trim()) return { error: '任务内容不能为空' }
    const resolved = resolveFireAt(delaySeconds, at)
    if ('error' in resolved) return { error: resolved.error }
    try {
      const id = await svc.add({ text: text.trim(), fireAt: resolved.fireAt })
      return {
        ok: true,
        id,
        text: text.trim(),
        fireAt: resolved.fireAt,
        kind: resolved.fireAt ? 'reminder' : 'todo',
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  },
})

const listTasks = tool({
  description:
    '查看主人当前的任务清单。返回 active（未完成，含未到时间的提醒）和 recentDone（最近完成的几条）。' +
    '触发场景："我还有什么没做"、"清单上还剩什么"、"今天有啥安排"。',
  inputSchema: z.object({}),
  execute: async () => {
    const svc = getTaskService()
    if (!svc) return { error: '任务服务未初始化' }
    try {
      const items = await svc.listAll(5)
      const active = items.filter((t) => t.doneAt === null)
      const recentDone = items.filter((t) => t.doneAt !== null)
      return { active, recentDone, activeCount: active.length }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  },
})

const markTaskDone = tool({
  description:
    '把某个任务标记为完成。用户说"X 做完了"、"勾掉 X"、"X 完成了"时调用。' +
    'id 必须来自上一次 listTasks 返回的 active[].id。' +
    '如果用户没说哪一条，先调 listTasks 看清单，从描述里匹配，再 markTaskDone。',
  inputSchema: z.object({
    id: z.number().int().describe('Task id from a previous listTasks result.'),
  }),
  execute: async ({ id }) => {
    const svc = getTaskService()
    if (!svc) return { error: '任务服务未初始化' }
    try {
      const ok = await svc.markDone(id)
      if (!ok) {
        // Validator: id not in active set. Include the actual active
        // task list so the model can pick a real id on retry. Same
        // pattern as readEmail. Cheap (single sqlite query) and avoids
        // having to bloat the system prompt with "don't guess ids".
        try {
          const active = await svc.listActive()
          const idList = active
            .map((t) => `id=${t.id}: ${t.text.slice(0, 40)}`)
            .join(' | ')
          return {
            error:
              `id=${id} 不在当前活跃任务里（可能已经完成或被删除）。` +
              `当前活跃任务：${idList || '(无)'}。请挑一个真实的 id 再调用。`,
          }
        } catch {
          return { error: `id=${id} 的任务找不到或已经完成。` }
        }
      }
      return { ok: true, id }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  },
})

const listMailFolders = tool({
  description:
    '列出用户邮箱里所有的文件夹（IMAP folders）。当用户提到"工作文件夹"、' +
    '"账单文件夹"、"看看 X 那个文件夹里的邮件"这种引用了一个非默认文件夹的请求时，' +
    '先调用本工具拿到全部文件夹的 path，再把匹配的 path 传给 listRecentEmails(folder=...)。\n' +
    '返回 items[]，每项 { path, name, isInbox, isSpecialUse }。' +
    '`path` 是要传给 listRecentEmails 的精确字符串；`name` 是中文/英文显示名，' +
    '用来匹配用户的口语化称呼。',
  inputSchema: z.object({}),
  execute: async () => {
    const mail = getMailService()
    if (!mail) return { error: '邮箱未配置或未启用，请在设置里开启邮箱并填写 IMAP 信息。' }
    try {
      const items = await mail.listFolders()
      return { items }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  },
})

const listRecentEmails = tool({
  description:
    '查看用户邮箱里最近的邮件。用户提到"我有没有新邮件"、"最近邮件"、"某某发邮件了吗"时调用。\n' +
    '默认读 INBOX。**如果用户指定了文件夹**（"看看工作文件夹里的"、"账单那个文件夹有什么新东西"等），' +
    '先调 listMailFolders 拿到 path，再把匹配的 path 作为 folder 参数传进来。\n' +
    '返回 items[] 的每一项是邮件摘要（id、from、subject、snippet、ts、unread）；' +
    '**如果某条邮件是回复某封信，items[i].parent 会包含用户当初发出的那封原信的摘要**' +
    '（同样的字段），用来生成"对方说了什么 + 你之前说了什么"的成对总结。' +
    'parent === null 表示是回复但找不到原信；parent === undefined 表示这条不是回复或没查。\n' +
    '如果用户问邮件细节正文，从某一项的 id 再调 readEmail 取全文。',
  // OpenAI's strict tool schema requires every property in `properties` to
  // also appear in `required`. Zod .default() / .optional() produce
  // properties that are NOT required, and the API rejects the whole tool.
  // So all fields are mandatory here; the description tells the model
  // sensible values to use when the user didn't specify.
  inputSchema: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .describe(
        'Number of recent messages to fetch. Use 5 unless the user asks for more. ' +
          '5 is enough for a summary because items[].snippet has the first ~200 chars ' +
          'of body — most replies need NO follow-up readEmail at all.',
      ),
    onlyUnread: z
      .boolean()
      .describe('If true, only return unread messages. Use false unless the user asks for unread only.'),
    folder: z
      .string()
      .describe(
        'IMAP folder path from listMailFolders. Empty string "" = read INBOX (default). ' +
          'If the user named a folder, ALWAYS call listMailFolders first and pass the exact ' +
          'matched path here — do not guess strings like "工作" without listing first.',
      ),
  }),
  execute: async ({ limit, onlyUnread, folder }) => {
    const mail = getMailService()
    if (!mail) return { error: '邮箱未配置或未启用，请在设置里开启邮箱并填写 IMAP 信息。' }
    try {
      const items = await mail.listInbox({
        limit,
        onlyUnread,
        folder: folder && folder.trim() ? folder : undefined,
      })
      return { items, folder: folder || 'INBOX' }
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
        // Validator: id wasn't found. Include the current inbox so the
        // model can self-correct on retry. This is cheap insurance —
        // adds one IMAP listInbox call only when readEmail FAILS, and
        // gives the model concrete valid ids to choose from instead of
        // guessing again. See openmeido-prompt-experiment-findings.md
        // for why this approach beats adding more prompt rules.
        console.warn(`[mail] readEmail id="${id}" returned null (not found)`)
        try {
          const recent = await mail.listInbox({ limit: 10, onlyUnread: false })
          const idList = recent
            .map((r) => `"${r.id}" (${r.from} - ${r.subject?.slice(0, 40) ?? ''})`)
            .join('; ')
          return {
            error:
              `id="${id}" 在邮箱里找不到。当前最近 10 封邮件的 id：${idList || '(空)'}。` +
              `请从这里挑一个真实的 id 再调用 readEmail。`,
          }
        } catch {
          // Fallback to the original message if the re-list also fails
          return {
            error: `id="${id}" 的邮件不存在或已被删除。请先用 listRecentEmails 重新拿当前列表。`,
          }
        }
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
 * Walk an email's parent chain to assemble thread context. Stops at
 * depth `maxDepth` OR when a parent is null (chain root / parent not
 * locatable). Returns oldest-first so the LLM reads chronologically.
 */
async function buildEmailThreadContext(
  mail: NonNullable<ReturnType<typeof getMailService>>,
  startUid: string,
  maxDepth: number = 5,
): Promise<{ from: string; ts: string; subject: string; body: string }[]> {
  const chain: { from: string; ts: string; subject: string; body: string }[] = []
  let currentId: string | undefined = startUid
  for (let i = 0; i < maxDepth && currentId; i++) {
    const msg = await mail.readMessage(currentId)
    if (!msg) break
    chain.push({
      from: msg.from,
      ts: msg.ts,
      subject: msg.subject,
      body:
        msg.body.length > 2000
          ? msg.body.slice(0, 2000) + '\n…[truncated]'
          : msg.body,
    })
    // The adapter already does one-level parent lookup. We use its
    // parent.id if present to walk further.
    currentId = msg.parent?.id
  }
  return chain.reverse() // oldest first
}

/**
 * Parse the writing LLM's JSON output {subject, body}. Tolerant of:
 *   - fenced block ```json\n{...}\n```
 *   - bare JSON object
 *   - structured plain-text fallback (Subject: ... \n\n body)
 */
function parseDraftJson(
  raw: string,
  fallbackSubject: string,
): { subject: string; body: string } {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const tryStrings = [fenced?.[1], raw].filter((s): s is string => typeof s === 'string')
  for (const s of tryStrings) {
    try {
      const obj = JSON.parse(s) as Record<string, unknown>
      const subject = typeof obj.subject === 'string' ? obj.subject : fallbackSubject
      const body = typeof obj.body === 'string' ? obj.body.trim() : ''
      if (body) return { subject, body }
    } catch {
      /* try next */
    }
  }
  // Fallback: try to find a JSON object inside the raw text.
  const objMatch = raw.match(/\{[\s\S]*?"body"\s*:[\s\S]*?\}/i)
  if (objMatch) {
    try {
      const obj = JSON.parse(objMatch[0]) as Record<string, unknown>
      const subject = typeof obj.subject === 'string' ? obj.subject : fallbackSubject
      const body = typeof obj.body === 'string' ? obj.body.trim() : ''
      if (body) return { subject, body }
    } catch {
      /* fall through */
    }
  }
  // Last-ditch: treat the whole raw text as the body.
  return { subject: fallbackSubject, body: raw.trim() }
}

const draftEmailReply = tool({
  description:
    '帮用户起草一封回信。用于用户说"帮我回这封"、"草稿一下回复"、"写一版回复"、"再改一版"等场景。\n' +
    '内部会自动读取邮件 + 走 thread 上下文，调一次 LLM 用**用户本人的口吻**写一份草稿，' +
    '然后通过 side-channel 把草稿放进聊天里作为可复制 + 可改稿的卡片。\n' +
    '**id 来源**：跟 readEmail 一样，必须用 listRecentEmails 返回的真实 id。\n' +
    '**改稿**：用户说"再改一版，更简短/更正式/加一句确认时间"时，把上一次草稿的 body 作为 `previousDraft` 传回来，' +
    '加上用户的反馈作为 `instruction`。返回新草稿替换聊天里的旧卡片。',
  inputSchema: z.object({
    uid: z
      .string()
      .describe('要回复的邮件 id（来自 listRecentEmails）'),
    instruction: z
      .string()
      .optional()
      .describe(
        '可选：用户对回复内容的具体要求，比如"简短礼貌地拒绝"、"确认周三 3 点"、"追问截止日期"。' +
          '不传时默认"自然回复"。',
      ),
    previousDraft: z
      .string()
      .optional()
      .describe(
        '改稿时传：上一版草稿的正文。模型会基于这版调整，而不是从头写。',
      ),
  }),
  execute: async ({ uid, instruction, previousDraft }) => {
    console.log(
      `[mail] draftEmailReply uid="${uid}" instruction="${instruction ?? '(none)'}" iter=${
        previousDraft ? 'yes' : 'no'
      }`,
    )
    const mail = getMailService()
    if (!mail) return { error: '邮箱未配置或未启用。' }
    const target = await mail.readMessage(uid)
    if (!target) {
      return {
        error: `id="${uid}" 在邮箱里找不到。先用 listRecentEmails 拿当前列表。`,
      }
    }
    const thread = await buildEmailThreadContext(mail, uid, 5)
    if (thread.length === 0) {
      return { error: '邮件读取失败。' }
    }
    // Try to get the user's display name from memory for a more
    // natural sign-off (still don't auto-sign — let the user's email
    // client append). Used in the prompt as "this email is from <X>"
    // to anchor the writing voice.
    const memory = getMemoryService()
    const userName = memory ? await memory.getUserName().catch(() => null) : null
    const prompt = buildEmailDraftPrompt({
      thread,
      instruction,
      previousDraft,
      userName,
    })
    let raw: string
    try {
      raw = await runExtraction(prompt, { temperature: 0.6 })
    } catch (err) {
      return {
        error: '写信助手 LLM 调用失败：' + (err instanceof Error ? err.message : String(err)),
      }
    }
    const fallbackSubject = target.subject?.toLowerCase().startsWith('re:')
      ? target.subject
      : `Re: ${target.subject ?? ''}`
    const { subject, body } = parseDraftJson(raw, fallbackSubject)
    // Emit the card to the renderer. The model also gets a short
    // confirmation in the tool result so its next text reply makes
    // sense ("好了，主人 / 哥 / 你，草稿放上面了，您看看").
    const cardId = `draft-${uid}-${Date.now().toString(36)}`
    _activeEmit?.({
      type: 'draft-card',
      draft: {
        cardId,
        replyToUid: uid,
        to: target.from,
        subject,
        body,
      },
    })
    return {
      ok: true,
      cardId,
      note:
        '草稿已经放进聊天里。简短跟用户说一句"主人/哥/你 看看上面的草稿，要改一版告诉我哪里"。' +
        '不要在你的回复里把草稿正文重复一遍——卡片已经显示了。',
    }
  },
})

/**
 * Build the writing prompt for draftEmailReply. Deliberately STRIPS
 * the persona system prompt — when she's helping draft an email she's
 * writing AS THE USER, not as the maid / imouto / ojou character. The
 * resulting voice should match the user's own emails, not OpenMeido's
 * persona voice.
 */
function buildEmailDraftPrompt(args: {
  thread: { from: string; ts: string; subject: string; body: string }[]
  instruction?: string
  previousDraft?: string
  userName: string | null
}): string {
  const threadText = args.thread
    .map(
      (m, i) =>
        `## ${i + 1}. From: ${m.from}\nDate: ${m.ts}\nSubject: ${m.subject}\n\n${m.body}`,
    )
    .join('\n\n---\n\n')
  const iterationBlock = args.previousDraft
    ? `\n# 上一版草稿（请按下方"用户要求"调整）\n${args.previousDraft}\n`
    : ''
  const instructionText = args.instruction?.trim()
    ? args.instruction.trim()
    : '自然、礼貌地回复，匹配对方邮件的正式度。'
  const userVoiceHint = args.userName
    ? `用户名字是 ${args.userName}，写作时用他/她的第一人称视角。`
    : '用第一人称视角写。'

  return (
    `你是用户的私人邮件写作助手。\n` +
    `\n` +
    `**重要**：你现在不是 OpenMeido 的女仆/妹妹/大小姐角色——你是用户本人在写信。` +
    `回信要听起来像**用户自己**写的，不是某个虚构角色的代笔。${userVoiceHint}\n` +
    `\n` +
    `# 收到的邮件（最新一封在最下面）\n${threadText}\n` +
    iterationBlock +
    `\n` +
    `# 用户对这封回信的要求\n${instructionText}\n` +
    `\n` +
    `# 写作规则\n` +
    `- 匹配最新邮件的语言（中文 → 用中文，英文 → 用英文）\n` +
    `- 匹配对方的正式度（同事用工作语，朋友用日常语）\n` +
    `- 简洁直接。不要"敬启者"、"此致敬礼"这种空套话——除非对方明显写得很正式\n` +
    `- 不要写署名 / signature——用户的邮件客户端会自动加\n` +
    `- 不要包含 emoji，除非对方的邮件里用了\n` +
    `- subject 默认用 "Re: <原标题>"，除非话题真的拐了别的方向\n` +
    `\n` +
    `# 输出（只输出 JSON，不要解释）\n` +
    `{"subject": "Re: 原标题", "body": "正文..."}\n`
  )
}

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
    '支持的文件类型：.txt .md .json .csv .yaml .py .ts 等纯文本，以及 .docx Word 文档（自动提取正文）。.pdf 暂时不支持，会被拒绝。',
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
          { name: 'Word 文档', extensions: ['docx'] },
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
      const ext = extname(absPath).toLowerCase()
      const MAX = 60_000

      // .docx is a zip with XML inside; null-byte check would reject it.
      // Route through mammoth which extracts plain text (no images, no
      // tables — those become tab-separated lines).
      if (ext === '.docx') {
        try {
          const { value } = await mammoth.extractRawText({ buffer: buf })
          const text = value ?? ''
          const content = text.length > MAX ? text.slice(0, MAX) + '\n…[截断]' : text
          return {
            path: absPath,
            sizeBytes: buf.length,
            sizeChars: text.length,
            content,
            truncated: text.length > MAX,
            format: 'docx',
          }
        } catch (err) {
          return {
            error: `读取 docx 失败: ${err instanceof Error ? err.message : String(err)}`,
          }
        }
      }

      // Plain-text path: crude binary check (null byte in first 1KB
      // strongly suggests a binary file). Catches .pdf, .xlsx, etc. that
      // we don't have specific parsers for.
      const head = buf.subarray(0, Math.min(1024, buf.length))
      if (head.includes(0)) {
        return {
          error:
            `${absPath} 看起来是二进制文件（含有空字节），我读不了。` +
            (ext === '.pdf'
              ? ' PDF 暂时不支持，可以把内容复制到剪贴板或导出成 .txt / .docx 再让我看。'
              : ''),
        }
      }
      const text = buf.toString('utf-8')
      const content = text.length > MAX ? text.slice(0, MAX) + '\n…[截断]' : text
      return {
        path: absPath,
        sizeBytes: buf.length,
        sizeChars: text.length,
        content,
        truncated: text.length > MAX,
        format: 'text',
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
function episodesToMessages(
  episodes: Episode[],
  /** How many trailing image-bearing user turns get their images
   *  re-attached for the model. Older image-bearing turns are emitted
   *  as text-only. See cfg.memory.imageRecallTurns. */
  imageRecallTurns: number = 3,
): ModelMessage[] {
  const sorted = episodes.slice().sort((a, b) => a.id - b.id)

  // Decide which user episodes are "fresh enough" to replay their images.
  // We walk newest→oldest, keep the first N user turns that actually have
  // images, mark their episode ids. Older image-bearing turns lose their
  // images on replay (they keep only their text content).
  const replayImageEpisodeIds = new Set<number>()
  if (imageRecallTurns > 0) {
    let kept = 0
    for (let i = sorted.length - 1; i >= 0 && kept < imageRecallTurns; i--) {
      const e = sorted[i]!
      if (e.speaker === 'user' && e.images && e.images.length > 0) {
        replayImageEpisodeIds.add(e.id)
        kept++
      }
    }
  }

  // Build a tool_call_id → tool_result map by scanning ALL episodes. This
  // lets us emit each assistant's tool_calls and their matching tool
  // results adjacently — even if the row order in sqlite is wrong (e.g.,
  // an earlier persistence race wrote the tool row BEFORE the assistant
  // row, so id-sorted ordering would emit them out of OpenAI-spec order).
  //
  // Strict backends (Kimi, recent OpenAI) reject if an assistant message
  // with tool_calls isn't immediately followed by tool messages responding
  // to each call. The reorder below makes that adjacency invariant hold
  // regardless of how the rows landed.
  const resultByCallId = new Map<
    string,
    { toolCallId: string; toolName: string; output: unknown }
  >()
  // Track every tool_call_id that an assistant message claimed. Tool
  // results for ids NOT in this set are orphans (the call was never
  // persisted; we have a result but no caller). They get dropped.
  const claimedCallIds = new Set<string>()
  for (const e of sorted) {
    if (e.speaker === 'assistant') {
      for (const p of e.toolParts ?? []) {
        if (p.type === 'tool-call' && p.toolCallId) {
          claimedCallIds.add(p.toolCallId)
        }
      }
    } else if (e.speaker === 'tool') {
      for (const p of e.toolParts ?? []) {
        // Skip tool-result entries with empty toolCallId — past streaming
        // glitches occasionally persisted these and they're un-pairable.
        if (p.type === 'tool-result' && p.toolCallId) {
          resultByCallId.set(p.toolCallId, {
            toolCallId: p.toolCallId,
            toolName: p.toolName,
            output: p.output,
          })
        }
      }
    }
  }

  // Tool-result episodes we've already emitted as part of their owning
  // assistant message. The pass below skips them when it encounters them
  // in id order, since they were already paired up.
  const emittedResultIds = new Set<string>()

  const out: ModelMessage[] = []
  for (const e of sorted) {
    if (e.speaker === 'user') {
      // If this user turn is recent enough to keep its images, build a
      // multipart content array. Otherwise text-only (matches the
      // pre-image-cache behavior for older turns).
      if (replayImageEpisodeIds.has(e.id) && e.images && e.images.length > 0) {
        out.push({
          role: 'user',
          content: [
            { type: 'text' as const, text: e.text },
            ...e.images.map((img) => ({
              type: 'image' as const,
              image: Buffer.from(img.base64, 'base64'),
              mediaType: img.mimeType,
            })),
          ],
        } as ModelMessage)
      } else {
        out.push({ role: 'user', content: e.text })
      }
      continue
    }
    if (e.speaker === 'tool') {
      // Only emit if (a) results weren't already paired with their owning
      // assistant above, (b) the toolCallId is non-empty, (c) some
      // assistant actually claimed this call id. Without (c) the API
      // rejects with "tool_call_id is not found".
      const surviving = (e.toolParts ?? []).filter(
        (p): p is Extract<typeof p, { type: 'tool-result' }> =>
          p.type === 'tool-result' &&
          !!p.toolCallId &&
          claimedCallIds.has(p.toolCallId) &&
          !emittedResultIds.has(p.toolCallId),
      )
      if (surviving.length === 0) continue
      out.push({
        role: 'tool',
        content: surviving.map((r) => ({
          type: 'tool-result' as const,
          toolCallId: r.toolCallId,
          toolName: r.toolName,
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
    // Assistant: keep only tool_calls that (a) have a non-empty id and
    // (b) have a matching result somewhere on disk. Empty-id calls and
    // orphans both get downgraded to plain text so they don't poison
    // the next API call.
    const calls = (e.toolParts ?? []).filter(
      (p): p is Extract<typeof p, { type: 'tool-call' }> =>
        p.type === 'tool-call' &&
        !!p.toolCallId &&
        resultByCallId.has(p.toolCallId),
    )
    if (calls.length === 0) {
      out.push({ role: 'assistant', content: e.text })
      continue
    }
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

    // IMMEDIATELY emit the matching tool message — required by OpenAI
    // spec, enforced strictly by Kimi. We pull results from the lookup
    // map so reversed-row-order history still produces correct output.
    out.push({
      role: 'tool',
      content: calls.map((c) => {
        const r = resultByCallId.get(c.toolCallId)!
        emittedResultIds.add(c.toolCallId)
        return {
          type: 'tool-result' as const,
          toolCallId: r.toolCallId,
          toolName: r.toolName,
          output: {
            type: 'json' as const,
            value: r.output as unknown as Parameters<
              typeof JSON.stringify
            >[0],
          },
        }
      }),
    } as ModelMessage)
  }
  return out
}

// Module-scoped reference to the active turn's emit callback. Tools
// defined at module level (above) don't have closure access to
// `localEmit` inside runChat — when a tool wants to push a side-channel
// event to the renderer (e.g. the email-draft card), it reads this.
// Cleared in finally so a closed turn never leaks into the next.
let _activeEmit: ((body: ChatEventBody) => void) | null = null

export async function runChat(
  messageId: string,
  userText: string,
  images: ChatImageAttachment[] | undefined,
  emit: (event: ChatEvent) => void,
): Promise<void> {
  const localEmit = (body: ChatEventBody): void => emit({ messageId, ...body })
  _activeEmit = localEmit

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
    // Images travel with the user episode so follow-up turns can re-attach
    // them — see episodesToMessages for the replay logic.
    if (memory) {
      const persistedImages =
        images && images.length > 0
          ? images.map((img) => ({ mimeType: img.mimeType, base64: img.base64 }))
          : undefined
      void memory.addEpisode('user', userText, undefined, persistedImages)
    }

    // Pull context BEFORE the model call so the retrieved messages can be
    // interleaved. retrieve() awaits embedding for the query, so this is
    // the one place where we do wait.
    const { recent, recalled } = memory
      ? await memory.retrieve(userText)
      : { recent: [], recalled: [] }
    const historyMessages = episodesToMessages(
      [...recalled, ...recent],
      cfg.memory.imageRecallTurns,
    )

    const persona = resolvePersona(cfg.persona)

    // L3 facts injection. Empty string when there's nothing to show, so the
    // system prompt stays compact for new users. Falls back gracefully if
    // the facts query throws.
    const factsBlock = memory ? await memory.factsBlock().catch(() => '') : ''

    // Tier-conditional relationship block — drives how formal vs intimate
    // her speech is for THIS turn based on accumulated affinity. Fresh
    // installs land at 0 (生疏); long-term users at 51+ get callbacks and
    //撒娇 unlocked.
    const affinity = memory ? await memory.getAffinity().catch(() => null) : null
    const tierBlock = buildTierPromptBlock(affinity?.score ?? 0, persona.name, persona.traits)

    // Provider routing. Gemini's OpenAI-compat shim drops fields
    // (tool_calls[].index) that Vercel AI SDK's strict OpenAI parser
    // requires, so for Gemini we use the native Google provider instead.
    // Other endpoints (OpenAI, LM Studio, Anthropic-compat) stay on the
    // OpenAI-compatible path with relaxed validation.
    // Google Search Grounding (`googleSearch` provider tool). When enabled
    // for the Gemini backend, Gemini autonomously decides when to call
    // search and grounds its reply with sources. Per @ai-sdk/google v3+,
    // this is a tool you add to the `tools` map (NOT a model factory
    // option). Other backends don't have a corresponding mechanism here
    // yet — GLM's web_search uses a provider-specific request shape that
    // needs more invasive wiring.
    let model: LanguageModel
    // Provider-tool result type (opaque to us). We just need to splat it
    // into the `tools` map when set; the SDK validates the shape internally.
    let googleSearchTool: unknown = null
    // Three-tier model policy: fast for side tasks (greeting / classifier
    // / etc., handled inside chat-host.runExtraction), perf for normal
    // chat, vision when the user attached images this turn. We pick perf
    // or vision automatically; cfg.backend.model is the manual-override
    // escape hatch — when set, it wins (custom fine-tunes, local LM
    // Studio model names, etc).
    const visionRequired = images !== undefined && images.length > 0
    const autoModelId = visionRequired
      ? visionModel(cfg.backend.baseUrl) ?? performanceModel(cfg.backend.baseUrl)
      : performanceModel(cfg.backend.baseUrl)
    const modelId = cfg.backend.model || autoModelId || cfg.backend.model
    if (cfg.backend.baseUrl.includes('googleapis.com')) {
      const google = createGoogleGenerativeAI({ apiKey })
      model = google(modelId)
      if (cfg.backend.searchEnabled) {
        googleSearchTool = google.tools.googleSearch({})
      }
    } else {
      // GLM (bigmodel.cn) supports a non-standard `web_search` tool that
      // can't be expressed via the Vercel AI SDK's `tools` map (it expects
      // function-shaped tools with inputSchema, not arbitrary types). We
      // inject it by wrapping fetch and editing the request body before
      // it goes to bigmodel.cn. The OpenAI-compat endpoint accepts the
      // extra tool entry and the model autonomously calls search when
      // useful. No grounding metadata is returned to us (Zhipu doesn't
      // surface it in the OpenAI-compat shim), but the model's answer
      // reflects fresh info — which is what users want.
      const isGlm = cfg.backend.baseUrl.includes('bigmodel.cn')
      const isKimi =
        cfg.backend.baseUrl.includes('moonshot.cn') ||
        cfg.backend.baseUrl.includes('moonshot.ai')
      const injectGlmSearch = isGlm && cfg.backend.searchEnabled
      // Kimi search disabled — see the comment block above kimiWebSearchEcho
      // for context. The toggle in Settings warns users; if they still flip
      // it on against a Kimi backend, we just silently ignore it.
      if (cfg.backend.searchEnabled && isKimi) {
        console.warn(
          '[chat] searchEnabled set but Kimi web search is not currently supported. ' +
            'Use Gemini or GLM for web search.',
        )
      } else if (cfg.backend.searchEnabled && !isGlm) {
        console.warn(
          '[chat] searchEnabled set but backend (' +
            cfg.backend.baseUrl +
            ') is not Gemini / GLM. No-op.',
        )
      }
      // Kimi (Moonshot) — kimi-k2.6 defaults to thinking ON, which then
      // demands `reasoning_content` on every assistant tool-call message
      // we replay in history. We don't capture that channel, so subsequent
      // turns 400 with "thinking is enabled but reasoning_content is
      // missing in assistant tool call message at index N". Force-disable
      // thinking by injecting `thinking: {type: "disabled"}`.
      const needWrapper = injectGlmSearch || isKimi
      const wrappedFetch = needWrapper
        ? ((async (url, init) => {
            if (init && init.method === 'POST' && typeof init.body === 'string') {
              try {
                const body = JSON.parse(init.body) as {
                  tools?: unknown[]
                  thinking?: { type: 'enabled' | 'disabled' }
                }
                if (injectGlmSearch) {
                  const entry = { type: 'web_search', web_search: { enable: true } }
                  if (Array.isArray(body.tools)) body.tools.push(entry)
                  else body.tools = [entry]
                }
                if (isKimi) {
                  body.thinking = { type: 'disabled' }
                }
                init = { ...init, body: JSON.stringify(body) }
              } catch {
                /* malformed body — fall through to original fetch */
              }
            }
            return globalThis.fetch(
              url as Parameters<typeof globalThis.fetch>[0],
              init as Parameters<typeof globalThis.fetch>[1],
            )
          }) as typeof globalThis.fetch)
        : undefined
      const openai = createOpenAI({
        baseURL: cfg.backend.baseUrl,
        apiKey,
        ...(wrappedFetch ? { fetch: wrappedFetch } : {}),
      })
      // .chat() forces the classic POST /chat/completions path. The default
      // openai(...) factory in @ai-sdk/openai v6 hits POST /responses (the
      // new OpenAI Responses API), which only OpenAI itself supports — every
      // OpenAI-compat third-party (GLM/bigmodel, OpenRouter, LM Studio,
      // Anthropic-compat, ...) 404s on /responses. Forcing .chat() costs us
      // GPT-5's built-in tools on real OpenAI but those aren't needed for
      // our flow (we BYO tools via `tools:` param either way).
      model = openai.chat(modelId)
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
    // 0.6 is our desired temperature for chat (persona variety without
    // wrecking tool-calling reliability). resolveTemperature applies any
    // model-specific override: OpenAI gpt-5 reasoning → omit; Kimi → pin
    // to 0.6 either way; everyone else → use 0.6 as desired.
    const result = streamText({
      model,
      temperature: resolveTemperature(modelId, 0.6),
      // System prompt is intentionally short. Tool-specific guidance (when to
      // call, what to pass, what NOT to call) lives in each tool's
      // `description` field — the model sees that next to the schema, which
      // is where the SDK and providers expect it. Code enforces the rules
      // that prompts alone can't (pre-tool narration roll-back, tool-name
      // leak guard, `</think>` filter, past-time guard in setReminder).
      // The remaining rules here are the few that are genuinely universal.
      system:
        `${persona.systemPrompt}\n\n` +
        `${tierBlock}\n\n` +
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
        `# 你能做的（仅限工具列表里的事）\n` +
        `加/查/完成待办、读剪贴板、读用户给的网页 URL、读用户给的文件、` +
        (mailEnabled ? `看邮件列表和邮件内容、` : ``) +
        `看用户主动发来的截图。**就这些**。\n` +
        // Web-search hint only when the backend ACTUALLY has search wired
        // (Gemini grounding + GLM web_search; Kimi search isn't supported
        // because their builtin_function tool type doesn't survive the
        // Vercel AI SDK's streaming OpenAI parser).
        (cfg.backend.searchEnabled &&
        (cfg.backend.baseUrl.includes('googleapis.com') ||
          cfg.backend.baseUrl.includes('bigmodel.cn'))
          ? `\n# 联网搜索（这次已开启）\n` +
            `主人问到时效性话题（"现在/今天/最近"、"谁是当前的 X"、"X 现在怎么样"、最新新闻、` +
            `比赛/股价/天气当前值等），**直接联网搜索后再回答，不要说做不到**。` +
            `搜索是自动的——你不需要确认、也不需要说"让我搜一下"，直接给结果就好。\n`
          : ``) +
        `\n` +
        `# 你做不到的（绝大多数操作）\n` +
        `调音量/亮度/键盘鼠标/系统设置；打开/关闭其他程序；替主人发消息、发邮件、转账、下单；` +
        `自己截屏；改文件/写文件/删文件；操控浏览器、播放器、音乐 app。\n` +
        `**关键规则**：不在工具列表里的事，**不要主动 offer 帮忙**——不要"要不要我帮您 X"、"我可以 X 一下"。` +
        `不确定能不能做时，先承认做不到。被问起时怎么回绝，按你这个角色一贯的语气来（` +
        `温柔的就温柔，傲娇的就傲娇，冷淡的就冷淡）——但不要假装尝试，也不要承诺。\n` +
        `\n` +
        `# 回复\n` +
        `1-3 句人物语气，不要复读 JSON。**绝不**在文字里输出 <think>、<tool_call>、JSON / XML、或任何函数名——工具名只能出现在专用调用通道里，文字回复里一个字母都不许有。**绝不**重复同一工具做同一件事（列出过就别再列，读过就别再读）。\n` +
        `**说话也别重复自己**：看看历史里你刚说过什么；如果只是换个说法把同一个意思又说一遍，没意义。变着角度说，或者承认前面已经说过、问主人需不需要换个话题。\n` +
        `\n` +
        `# 工具调用前后\n` +
        `**调用工具时不要在前面说话**——不要"好的我去查"、"我看一下"、"稍等"这种铺垫。直接调工具。所有工具都跑完、有了最终结果，再开口说话——这一次就要把答案说完整、说清楚。\n` +
        `**多工具并行**：能并行就并行（在同一个回复里返回多个 tool_call）。尤其是用户让你总结、汇总多封邮件这种场景，**一定**在拿到列表后同一回复里同时发起多封邮件的正文读取调用，不要一封一封串行处理。串行处理会撞步数上限，最后说不出总结。`,
      messages,
      // Conditional tool exposure: when mail isn't enabled, drop the email
      // tools entirely so the model doesn't see them in its function list.
      // Otherwise some models will (a) hallucinate that they can read mail
      // even when the tool returns "not configured", and (b) get stuck in
      // re-try loops calling the tool that always errors.
      // Tool map. Provider-side tools (e.g. Gemini's googleSearch) get
      // splatted in via the conditional below; the SDK type-checks them
      // against the provider when streamText runs. Splat-cast through
      // any so the unified shape passes TS — the runtime contract is
      // what matters.
      tools: {
        addTask,
        listTasks,
        markTaskDone,
        readClipboard,
        readWebPage,
        readFile: readFileTool,
        ...(cfg.mail.enabled
          ? { listMailFolders, listRecentEmails, readEmail, draftEmailReply }
          : {}),
        ...(googleSearchTool ? { google_search: googleSearchTool } : {}),
      } as unknown as Parameters<typeof streamText>[0]['tools'],
      // Step budget. stepCountIs(N) keeps the loop alive for up to N model
      // invocations. Earlier values (3, then 6) repeatedly hit the cap on
      // legitimate "summarize my N recent emails" flows where GLM does
      // sequential readEmail calls (1 list + N reads + 1 summary = N+2
      // steps). 10 covers up to ~8 emails fully sequential, with the
      // prompt below pushing the model to batch readEmail in parallel
      // when summarizing, which collapses the sequence back to ~3 steps.
      // Going higher risks chatter loops; 10 is the empirical sweet spot.
      stopWhen: stepCountIs(10),
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
    // this in the wild; GLM 4.6 too) emit the function name as plain text
    // instead of using the tool-call channel. The user's bubble ends up
    // showing "readEmail" and the tool never actually fires.
    //
    // We catch a few variants:
    //   - bare:        "readEmail"
    //   - punctuated:  "readEmail.", "(readEmail)", "[readEmail]"
    //   - call-like:   "readEmail()", "readEmail({})", "readEmail()."
    //   - jsonish:     `{"name":"readEmail"}` truncated to just the name
    // Anything where the trimmed text, stripped of common wrappers, equals
    // a known tool name is treated as a leak.
    const TOOL_NAMES = [
      'addTask',
      'listTasks',
      'markTaskDone',
      'readClipboard',
      'readWebPage',
      'readFile',
      'listMailFolders',
      'listRecentEmails',
      'readEmail',
    ]
    const trimmedFinal = assistantText.trim()
    const looksLikeToolNameLeak = (text: string): string | null => {
      if (!text) return null
      // Quick path: exact match.
      if (TOOL_NAMES.includes(text)) return text
      // Strip wrappers: parens / brackets / quotes / trailing punctuation /
      // empty function-call parens like ().
      const stripped = text
        .replace(/[()[\]{}"'`.,!?;:、。！？]/g, '')
        .replace(/\s+/g, '')
      if (TOOL_NAMES.includes(stripped)) return stripped
      // Sometimes the whole reply is just "name()" or "name({})".
      const funcCallMatch = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\.?$/)
      if (funcCallMatch && TOOL_NAMES.includes(funcCallMatch[1]!)) {
        return funcCallMatch[1]!
      }
      return null
    }
    const leaked = looksLikeToolNameLeak(trimmedFinal)
    if (leaked) {
      console.warn(
        `[chat] model leaked tool name "${leaked}" as text (raw: "${trimmedFinal}") — replacing with retry hint`,
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
      // Serialize persistence via a chained promise. We deliberately don't
      // await it — the user-visible `done` event below should fire as soon
      // as streaming finishes — but each addEpisode must complete before
      // the next starts, otherwise their internal embedding calls race and
      // the resulting sqlite row ids can come out reversed.
      //
      // Reversed ids → episodesToMessages outputs the tool message BEFORE
      // the assistant message that owns its tool_calls → next turn fails
      // with: "an assistant message with 'tool_calls' must be followed by
      // tool messages responding to each 'tool_call_id'" (Kimi / strict
      // OpenAI-compat backends).
      let persistChain: Promise<unknown> = Promise.resolve()
      for (const cap of captures) {
        const stepText = cleanInlineText(cap.text)
        if (stepText || cap.calls.length > 0) {
          persistChain = persistChain
            .then(() =>
              memory.addEpisode(
                'assistant',
                stepText,
                cap.calls.length > 0 ? cap.calls : undefined,
              ),
            )
            .catch((err) =>
              console.warn('[chat] persist assistant episode failed:', err),
            )
        }
        if (cap.results.length > 0) {
          persistChain = persistChain
            .then(() => memory.addEpisode('tool', '', cap.results))
            .catch((err) =>
              console.warn('[chat] persist tool episode failed:', err),
            )
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

    // Emotion classifier — pick a Live2D expression for THIS reply via a
    // lightweight LLM call. Fire-and-forget; classifier owns its own error
    // handling and broadcasts to renderer when done. The expression catches
    // up with the bubble ~500ms after the user sees the final word.
    if (assistantText.trim()) {
      void classifyAndApply(assistantText, userText)
    }

    localEmit({ type: 'done' })
  } catch (err) {
    localEmit({
      type: 'error',
      error: friendlyError(err),
    })
  } finally {
    _activeEmit = null
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
