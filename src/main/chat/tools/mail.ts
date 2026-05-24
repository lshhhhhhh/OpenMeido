import { tool } from 'ai'
import { z } from 'zod'

import { getMailService } from '../../mail-host.js'
import { getMemoryService } from '../../memory-host.js'
import { runExtraction } from '../../chat-host.js'
import { getActiveEmit } from '../active-emit.js'

export const listMailFolders = tool({
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

export const listRecentEmails = tool({
  description:
    '查看用户邮箱里最近的邮件。用户提到"我有没有新邮件"、"最近邮件"、"某某发邮件了吗"时调用。\n' +
    '默认读 INBOX。**如果用户指定了文件夹**（"看看工作文件夹里的"、"账单那个文件夹有什么新东西"等），' +
    '先调 listMailFolders 拿到 path，再把匹配的 path 作为 folder 参数传进来。\n' +
    '返回 items[] 的每一项是邮件摘要（id、from、subject、snippet、ts、unread）；' +
    '**如果某条邮件是回复某封信，items[i].parent 会包含用户当初发出的那封原信的摘要**' +
    '（同样的字段），用来生成"对方说了什么 + 你之前说了什么"的成对总结。' +
    'parent === null 表示是回复但找不到原信；parent === undefined 表示这条不是回复或没查。\n' +
    '如果用户问邮件细节正文，从某一项的 id 再调 readEmail 取全文。\n' +
    '\n' +
    '**呈现规则——按你的判断折叠营销/通知类邮件**：\n' +
    '从 from / subject / snippet 你能看出来哪些是营销邮件 / 订阅推送 / 自动通知（订单确认 / 发货提醒 / 账单 / 折扣促销 / 论坛日报 / 平台通知等）。' +
    '**不要逐封列**这些——把它们合并成一行计数总结，例如："另有 5 封订单/通知/营销邮件没列（淘宝、AliExpress、Medium daily 等）"。' +
    '**逐封展开**只留给值得用户决定怎么处理的邮件：真人发来的工作邮件 / 回信 / 询问 / 朋友家人消息。' +
    '不确定时**倾向逐封展开**——错把营销折叠成"另有 N 封"用户失去信号，错把工作邮件折叠则用户根本看不见。\n' +
    '用户如果主动问"那些营销/订单邮件呢"或者"全部列出来"，就把折叠的也展开。',
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
    includeParents: z
      .boolean()
      .describe(
        'If true, fetch each reply\'s parent message from Sent. **Expensive**: ' +
          '500-2000ms per reply (sequential IMAP search). Default false. Only set true ' +
          'when user genuinely needs paired "they said / I had said" context — e.g. ' +
          'drafting a follow-up reply where the user wants to know what they previously said. ' +
          'NEVER set true for a generic summary / table request.',
      ),
  }),
  execute: async ({ limit, onlyUnread, folder, includeParents }) => {
    const mail = getMailService()
    if (!mail) return { error: '邮箱未配置或未启用，请在设置里开启邮箱并填写 IMAP 信息。' }
    try {
      const items = await listInboxCached(mail, {
        limit,
        onlyUnread,
        folder: folder && folder.trim() ? folder : undefined,
        includeParents,
      })
      return { items, folder: folder || 'INBOX' }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  },
})

/**
 * **B. listInbox short-TTL cache.** Repeated table iterations
 * ("再加一列时间", "隐藏 Uber Eats", "按时间倒序") would otherwise
 * re-fetch from IMAP every call. The model's window of N most-recent
 * emails doesn't change second-to-second; a 60s cache absorbs the
 * burst of follow-up tool calls during one editing session.
 *
 * Cache key includes every parameter that affects the result — folder,
 * limit, onlyUnread, includeParents — so changing any of them bypasses
 * the stale entry naturally.
 */
const LIST_INBOX_CACHE_TTL_MS = 60_000
interface CachedListing {
  ts: number
  items: Awaited<ReturnType<NonNullable<ReturnType<typeof getMailService>>['listInbox']>>
}
const listInboxCache = new Map<string, CachedListing>()
async function listInboxCached(
  mail: NonNullable<ReturnType<typeof getMailService>>,
  o: {
    limit: number
    onlyUnread: boolean
    folder?: string
    includeParents?: boolean
  },
): Promise<CachedListing['items']> {
  const key = JSON.stringify([
    o.folder ?? 'INBOX',
    o.limit,
    o.onlyUnread,
    o.includeParents === true,
  ])
  const now = Date.now()
  const hit = listInboxCache.get(key)
  if (hit && now - hit.ts < LIST_INBOX_CACHE_TTL_MS) {
    console.log(`[mail] listInbox cache HIT (${(now - hit.ts) / 1000}s old) key=${key}`)
    return hit.items
  }
  const items = await mail.listInbox(o)
  listInboxCache.set(key, { ts: now, items })
  // Evict stale entries opportunistically so the map doesn't grow.
  for (const [k, v] of listInboxCache) {
    if (now - v.ts > LIST_INBOX_CACHE_TTL_MS) listInboxCache.delete(k)
  }
  return items
}

export const readEmail = tool({
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
      .union([z.string(), z.number()])
      .transform((val) => String(val))
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

export const draftEmailReply = tool({
  description:
    '帮用户起草一封回信。用于用户说"帮我回这封"、"草稿一下回复"、"写一版回复"、"再改一版"等场景。\n' +
    '内部会自动读取邮件 + 走 thread 上下文，调一次 LLM 用**用户本人的口吻**写一份草稿，' +
    '然后通过 side-channel 把草稿放进聊天里作为可复制 + 可改稿的卡片。\n' +
    '**id 来源**：跟 readEmail 一样，必须用 listRecentEmails 返回的真实 id。\n' +
    '**改稿**：用户说"再改一版，更简短/更正式/加一句确认时间"时，把上一次草稿的 body 作为 `previousDraft` 传回来，' +
    '加上用户的反馈作为 `instruction`。返回新草稿替换聊天里的旧卡片。',
  inputSchema: z.object({
    uid: z
      .union([z.string(), z.number()])
      .transform((val) => String(val))
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
    getActiveEmit()?.({
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
