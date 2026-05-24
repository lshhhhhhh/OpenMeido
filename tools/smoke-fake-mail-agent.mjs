#!/usr/bin/env node
/**
 * End-to-end agent test: drives a real Gemini chat against the fake mail
 * adapter and verifies the model actually USES the email-with-context
 * data (items[i].parent) when summarizing replies.
 *
 * Goes one level deeper than smoke-fake-mail.mjs:
 *   - shape test confirms our adapter wires up parents correctly
 *   - THIS test confirms the model reads the parent and pairs it in its
 *     reply, which is the actual user-visible payoff
 *
 * Run: node --env-file=.env --import tsx tools/smoke-fake-mail-agent.mjs
 */

import { stepCountIs, streamText, tool } from 'ai'
import { z } from 'zod'

import { createFakeMailAdapter } from '../src/main/mail/fake-adapter.ts'
import { getAgentBackends } from './agent-backends.mjs'

// ---------- Test rig: real adapter wired to ai-sdk tools ----------

const adapter = createFakeMailAdapter()

const listRecentEmails = tool({
  description:
    '查看用户邮箱里最近的邮件。返回 items[] 的每一项是邮件摘要（id、from、subject、snippet、ts、unread）；' +
    '**如果某条邮件是回复某封信，items[i].parent 会包含用户当初发出的那封原信的摘要**' +
    '（同样的字段），用来生成"对方说了什么 + 你之前说了什么"的成对总结。' +
    'parent === null 表示是回复但找不到原信；parent === undefined 表示这条不是回复或没查。\n' +
    '\n' +
    '**呈现规则——按你的判断折叠营销/通知类邮件**：' +
    '从 from / subject / snippet 你能看出来哪些是营销邮件 / 订阅推送 / 自动通知（订单确认 / 发货提醒 / 折扣促销 / 平台日报 / 招聘网站等）。' +
    '**不要逐封列**这些——把它们合并成一行计数总结（例如"另有 4 封订单 / 通知 / 营销邮件未列"），' +
    '逐封展开只留给值得用户决定怎么处理的邮件：真人发来的工作邮件 / 回信 / 询问。' +
    '不确定时倾向逐封展开。',
  inputSchema: z.object({
    limit: z.number().int().min(1).max(20),
    onlyUnread: z.boolean(),
  }),
  execute: async ({ limit, onlyUnread }) => {
    const items = await adapter.listInbox({ limit, onlyUnread })
    return { items }
  },
})

const readEmail = tool({
  description:
    '读取一封邮件的完整正文。id 必须来自上一次 listRecentEmails 的 items[].id。' +
    '如果是回复，返回结果会包含 parent 字段（同样的全字段结构）。',
  inputSchema: z.object({ id: z.string() }),
  execute: async ({ id }) => {
    const m = await adapter.readMessage(id)
    return m ?? { error: `id="${id}" not found` }
  },
})

// ---------- Driver ----------

async function drive({ model, prompt, tools, callLog }) {
  let visible = ''
  const result = streamText({
    model,
    // Match production: 0.6 across all backends (Kimi requires exactly 0.6,
    // and lower temp makes tool-call reliability noticeably better).
    temperature: 0.6,
    // Mirror the production system prompt's anti-narration + parallel-tool
    // rules. Without these, GLM serializes readEmail calls and exhausts
    // stepCountIs before producing a summary — which is exactly the bug
    // a user hit in prod with "总结最近的邮件并且生成报告".
    system:
      '你是用户的私人女仆。回答时用主人称呼用户。' +
      '看到工具的 parent 字段时，要把"对方说了什么"和"你之前说了什么"都点出来，' +
      '帮助主人快速建立对话上下文。1-3 句话即可。\n' +
      '\n' +
      '**调用工具时不要在前面说话**。直接调工具，所有工具都跑完再开口。\n' +
      '**多工具并行**：用户让你总结/汇总多封邮件时，**一定**在拿到列表后同一回复里同时调多个 readEmail，' +
      '不要一封一封串行读——会撞步数上限。',
    prompt,
    tools,
    // Match production budget. 3 was hiding budget-exhaustion bugs because
    // tests were checking "tool was called" + "keywords appear" but never
    // "the model actually produced a final answer".
    stopWhen: stepCountIs(10),
    maxRetries: 0,
  })
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') visible += part.text
    else if (part.type === 'tool-call') {
      callLog.push({ name: part.toolName, input: part.input })
    } else if (part.type === 'error') {
      throw part.error instanceof Error ? part.error : new Error(String(part.error))
    }
  }
  return visible
}

// ---------- Scoring ----------
//
// Parallel-mode plumbing: each backend gets its own (check, log) pair
// that buffers output locally instead of going straight to console.
// main() flushes each backend's buffer in order after Promise.all
// resolves so the 4 streams don't interleave into garbage.

const results = []

function makeBackendContext(label) {
  const logLines = []
  const localResults = []
  const log = (...args) => {
    logLines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
  }
  const check = (name, ok, detail = '') => {
    const labeled = { name: `[${label}] ${name}`, ok, detail }
    localResults.push(labeled)
    log(ok ? `  ✅ ${name}` : `  ❌ ${name} :: ${detail}`)
  }
  return { log, check, logLines, localResults }
}

async function runOnBackend(label, model) {
  const { log, check, logLines, localResults } = makeBackendContext(label)
  log(`\n████ Backend: ${label} ████`)
  // ---------- Scenario 1: list — does the model pair at least one thread? ----------
  log('\n=== Scenario 1: "总结最近5封邮件" — does model pair parents? ===')
  {
    const callLog = []
    const visible = await drive({
      model,
      prompt: '主人想知道最近5封邮件的情况，请帮我总结，遇到回复要把我之前发的内容也带一下。',
      tools: { listRecentEmails, readEmail },
      callLog,
    })
    log(
      `Visible (${visible.length} chars):\n  ${visible.replace(/\n/g, '\n  ').slice(0, 800)}${visible.length > 800 ? '…' : ''}`,
    )

    // CRITICAL: must produce a non-empty reply. A user reported the model
    // making 5 sequential readEmail calls and never speaking — budget
    // exhausted. This assertion would have caught that.
    check(
      'visible reply is non-empty (model didn\'t exhaust step budget on tools)',
      visible.trim().length > 0,
      `got 0 chars — likely budget exhausted by sequential tool calls`,
    )
    check(
      'visible reply is substantive (>= 40 chars, not just a placeholder)',
      visible.trim().length >= 40,
      `got ${visible.trim().length} chars: "${visible.slice(0, 80)}"`,
    )

    check(
      'listRecentEmails was called',
      callLog.some((c) => c.name === 'listRecentEmails'),
      `got: ${callLog.map((c) => c.name).join(',')}`,
    )

    // The model should reference at least one threaded subject AND something
    // that ties back to the user's prior send. Keyword scan:
    //   Thread 1: "LunarLink" appears in BOTH inbound and sent
    //   Thread 2: "灰度" / "回滚" / "评审"
    //   Thread 3: "面试" / "二面" / "排期"
    //   Thread 4: "客户" / "演示" / "反馈"
    //   Thread 6: "合同" / "3.2"
    const threadKeywords = ['LunarLink', '灰度', '面试', '客户', '合同']
    const mentioned = threadKeywords.filter((k) => visible.includes(k))
    check(
      `model mentions at least 2 threaded subjects (got ${mentioned.length}: ${mentioned.join(',') || 'none'})`,
      mentioned.length >= 2,
    )

    // "用户之前说" indicator — words like "您问"/"您之前"/"主人之前"/"您发的".
    const senderHints = ['你问', '你之前', '您之前', '主人之前', '您发', '您让', '你让', '您交代', '你交代']
    const usedSenderHint = senderHints.some((h) => visible.includes(h))
    check(
      'reply uses "you previously..."-style framing (sign of parent usage)',
      usedSenderHint,
      `looked for: ${senderHints.join(' / ')}`,
    )
  }

  // ---------- Scenario 2: readEmail on a reply — model should narrate both sides ----------
  log('\n=== Scenario 2: "打开 LunarLink 那封" — pair on read ===')
  {
    const callLog = []
    const visible = await drive({
      model,
      prompt: '主人想看 LunarLink 那封邮件的具体内容，顺便告诉我之前发出去问的是什么。',
      tools: { listRecentEmails, readEmail },
      callLog,
    })
    log(
      `Visible (${visible.length} chars):\n  ${visible.replace(/\n/g, '\n  ').slice(0, 600)}${visible.length > 600 ? '…' : ''}`,
    )

    const readCall = callLog.find((c) => c.name === 'readEmail')
    check('readEmail was called', !!readCall, `got: ${callLog.map((c) => c.name).join(',')}`)
    if (readCall) {
      check(
        'readEmail id resolved to a real reply (101, 102, 103, 104, 108, or 109)',
        ['101', '102', '103', '104', '108', '109'].includes(readCall.input.id),
        `got id=${readCall.input.id}`,
      )
    }
    check('LunarLink subject is in the visible reply', visible.includes('LunarLink'))
    // The reply ("OAuth 卡住" / "周三") and the parent ("下周一" / "预发布")
    // give us discriminating tokens for each side.
    const replySide = ['OAuth', '周三', '顺延', 'Alice']
    const sentSide = ['下周一', '预发布', '进度', '问她', '问你', '问我', '你问', '问的是']
    const hasReply = replySide.some((k) => visible.includes(k))
    const hasSent = sentSide.some((k) => visible.includes(k))
    check(
      'reply text references the inbound side',
      hasReply,
      `looked for: ${replySide.join(' / ')}`,
    )
    check(
      'reply text references the sent (parent) side',
      hasSent,
      `looked for: ${sentSide.join(' / ')}`,
    )
  }

  // ---------- Scenario 2b: many-email summary → tests step-budget headroom ----------
  // Reproduces the prod bug: user asks for a summary, model decides to
  // read every recent email, runs out of steps before producing a final
  // reply. The fix is the "parallel readEmail" prompt rule + larger
  // stepCountIs. This scenario fails LOUDLY when either regresses.
  log('\n=== Scenario 2b: "总结最近的邮件并且生成报告" — many-email summary ===')
  {
    const callLog = []
    const visible = await drive({
      model,
      prompt: '总结最近的邮件并且生成报告',
      tools: { listRecentEmails, readEmail },
      callLog,
    })
    log(
      `Visible (${visible.length} chars):\n  ${visible.replace(/\n/g, '\n  ').slice(0, 800)}${visible.length > 800 ? '…' : ''}`,
    )
    const readCount = callLog.filter((c) => c.name === 'readEmail').length
    log(`  tool calls: ${callLog.map((c) => c.name).join(', ')}`)

    check(
      'model produced a final summary (non-empty visible text)',
      visible.trim().length > 0,
      `0 chars — model consumed entire step budget on tool calls, never spoke`,
    )
    check(
      'summary is substantive (>= 60 chars — a real report, not "ok done")',
      visible.trim().length >= 60,
      `got ${visible.trim().length} chars: "${visible.slice(0, 100)}"`,
    )
    // Tool-name leak: model emits "readEmail" / "listRecentEmails" as plain
    // text instead of issuing a tool_call. Prod chat.ts has a fallback that
    // replaces it with a "走神" hint, but a user shouldn't see that twice
    // in a row. Catching it here means we notice when prompt regressions
    // (e.g., putting tool names back into the example list) trigger it.
    const looksLikeBareToolName = [
      'readEmail',
      'listRecentEmails',
      'addTask',
      'readFile',
      'readWebPage',
    ].some((n) => {
      const stripped = visible
        .trim()
        .replace(/[()[\]{}"'`.,!?;:、。！？\s]/g, '')
      return stripped === n
    })
    check(
      'model did NOT leak a tool name as the entire visible reply',
      !looksLikeBareToolName,
      `visible was just a tool name: "${visible.slice(0, 60)}"`,
    )
    // If the model read multiple emails, it should be using parallel calls
    // (same step) — otherwise we'll hit the budget cap as readCount grows.
    // We tolerate any combination as long as a summary came out.
    check(
      `readEmail invoked at least twice (covered multiple emails, got ${readCount})`,
      readCount >= 2,
      `the prompt explicitly asks for a "总结" of multiple emails`,
    )
  }

  // ---------- Scenario 2c: promo folding — model should NOT enumerate marketing/notification mails ----------
  // The fake dataset has 4 promo-ish entries (ids 201-204: 淘宝 order /
  // AliExpress sale / Medium daily / LinkedIn notifications). The tool
  // description tells the model to fold them into a count summary rather
  // than listing each one. This scenario asserts that on limit=15 the
  // model:
  //   - still names the real work threads (signal preserved)
  //   - mentions at most ONE promo subject (rest are folded)
  //   - explicitly references the fold count via a "另有 / 还有 / 其他"-style phrase
  log('\n=== Scenario 2c: limit=15 — promo folding ===')
  {
    const callLog = []
    const visible = await drive({
      model,
      prompt: '主人想看看最近邮箱情况，列一下最近 15 封都有啥。',
      tools: { listRecentEmails, readEmail },
      callLog,
    })
    log(
      `Visible (${visible.length} chars):\n  ${visible.replace(/\n/g, '\n  ').slice(0, 900)}${visible.length > 900 ? '…' : ''}`,
    )

    check(
      'visible reply is non-empty',
      visible.trim().length > 0,
      'model should produce a summary',
    )

    // Real work threads should still be named — folding promos must NOT
    // sacrifice real signal. Same threadKeywords as Scenario 1.
    const threadKeywords = ['LunarLink', '灰度', '面试', '客户', '合同']
    const mentionedReal = threadKeywords.filter((k) => visible.includes(k))
    check(
      `model still names work threads (got ${mentionedReal.length}/${threadKeywords.length}: ${mentionedReal.join(',') || 'none'})`,
      mentionedReal.length >= 2,
    )

    // Folding looks like ONE compact line / bullet listing all promo
    // sources (e.g. "另有 5 封：淘宝、AliExpress、Medium、LinkedIn"),
    // NOT 4-5 separate full-detail entries. Naming the brands is fine —
    // user wants to know WHAT got folded. Bad behavior is reproducing
    // full subject strings verbatim, which is what an "enumeration"
    // does. Asserts: the FULL verbatim subject of each promo doesn't
    // appear in the output (model paraphrased / compacted them).
    const verbatimPromoSubjects = [
      '【淘宝】您的订单 4203 已发货',
      'AliExpress 限时大促 · 全场 50% OFF 仅剩 12 小时',
      'Your Medium Daily Digest - 5 stories you might like',
      '12 位猎头本周查看了你的资料',
    ]
    const verbatimLeaks = verbatimPromoSubjects.filter((s) => visible.includes(s)).length
    check(
      `model did NOT paste full promo subjects verbatim (got ${verbatimLeaks} of 4 verbatim)`,
      verbatimLeaks <= 1,
      'verbatim full-subject leak = model is enumerating promos as separate entries instead of folding',
    )

    // Folding indicator — the reply should explicitly call out the count
    // so user knows promos exist and were intentionally collapsed.
    const foldHints = ['另有', '还有', '其他', '剩下', '未列', '订单', '通知', '营销', '促销', '订阅', '日报', '推送']
    const foldHit = foldHints.some((h) => visible.includes(h))
    check(
      'reply contains a "fold" indicator (e.g. 另有 N 封通知/营销)',
      foldHit,
      `looked for: ${foldHints.join(' / ')}`,
    )
  }

  // ---------- Scenario 3: standalone — model should NOT invent parent ----------
  log('\n=== Scenario 3: "看看 InfoQ 周刊那封" — control (no parent) ===')
  {
    const callLog = []
    const visible = await drive({
      model,
      prompt: '主人，看看 InfoQ 周刊那封说什么。',
      tools: { listRecentEmails, readEmail },
      callLog,
    })
    log(
      `Visible (${visible.length} chars):\n  ${visible.replace(/\n/g, '\n  ').slice(0, 400)}${visible.length > 400 ? '…' : ''}`,
    )
    const readCall = callLog.find((c) => c.name === 'readEmail')
    if (readCall) {
      check('readEmail id is the newsletter (106)', readCall.input.id === '106', `got ${readCall.input.id}`)
    }
    check(
      'model does NOT hallucinate "you previously sent"-style for a standalone',
      !['您之前发', '主人之前发', '你之前发', '您问', '你问的'].some((h) => visible.includes(h)),
      'model should treat this as a standalone newsletter',
    )
  }

  return { logLines, localResults }
}

async function main() {
  const backends = getAgentBackends()
  console.log(`Running fake-mail-agent scenarios across ${backends.length} backend(s) (parallel)`)
  console.log('(each backend\'s output is buffered + flushed in order after all complete)')

  // Run each backend's scenario chain in parallel. Each returns its own
  // logLines + localResults so we don't fight for console / globals.
  // The "scenarios within a backend stay serial" property is preserved
  // by the for-blocks inside runOnBackend.
  const settled = await Promise.allSettled(
    backends.map(async (b) => {
      const t0 = Date.now()
      const out = await runOnBackend(b.label, b.model)
      return { label: b.label, elapsedMs: Date.now() - t0, ...out }
    }),
  )

  // Flush per backend in the order they were registered, so the output
  // reads as if the run were serial but the wall clock said otherwise.
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i]
    const b = backends[i]
    if (r.status === 'fulfilled') {
      for (const line of r.value.logLines) console.log(line)
      console.log(`  ⏱ ${b.label} took ${(r.value.elapsedMs / 1000).toFixed(1)}s`)
      results.push(...r.value.localResults)
    } else {
      results.push({
        name: `[${b.label}] crashed before completion`,
        ok: false,
        detail: r.reason instanceof Error ? r.reason.message : String(r.reason),
      })
      console.error(
        `  ❌ ${b.label} crashed:`,
        r.reason instanceof Error ? r.reason.message : r.reason,
      )
    }
  }

  const failed = results.filter((r) => !r.ok)
  console.log(
    `\n${failed.length === 0 ? '✅' : '❌'} ${results.length - failed.length}/${results.length} assertions passed across all backends`,
  )
  if (failed.length > 0) {
    console.log('\nFailed assertions:')
    for (const f of failed) console.log(`  · ${f.name}${f.detail ? ` :: ${f.detail}` : ''}`)
  }
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('crashed:', err)
  process.exit(1)
})
