/**
 * Agent-loop persistence smoke test — proves that ids returned by
 * listRecentEmails survive across user turns and that readEmail in turn 2
 * uses the real id from turn 1's list result (not a hallucinated "1" or
 * "latest").
 *
 * This is the GUI-less version of the email flow that was broken in the
 * 0.0.8 release: when the user said "看看邮件" then "打开 WWDC 通知",
 * the second turn re-listed instead of reading because the tool_call_id
 * ←→ tool_result_id linkage died at the turn boundary.
 *
 * Setup
 * -----
 *   - Fresh temp-dir sqlite memory DB matching the production schema
 *     (episodes + episodes_vec + tool_data column).
 *   - Fake embedding (deterministic random per text) — we're testing
 *     agent-loop replay, not embedding fidelity.
 *   - Stub mail service with 5 fixed emails.
 *   - listRecentEmails / readEmail tools wired to the stub.
 *   - Same persistence pattern as src/main/chat.ts: walk result.steps,
 *     write one assistant row (text + tool_calls) and one tool row
 *     (results) per step.
 *   - Same episodesToMessages reconstruction.
 *
 * Run: npx electron tools/smoke-agent-loop.mjs
 */

import { app } from 'electron'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { stepCountIs, streamText, tool } from 'ai'
import { z } from 'zod'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ---------- Fake mail data ----------
const FAKE_EMAILS = [
  {
    id: 'mail-2001',
    from: 'WWDC Notifications <wwdc@apple.com>',
    subject: 'WWDC 通知：keynote 时间确认',
    snippet: 'Your WWDC keynote ticket is confirmed for June 10 ...',
    body: 'Hi laishaoheng, this is to confirm your WWDC keynote attendance on June 10 at 10:00 PT. See you in Cupertino!',
    date: '2026-05-17T08:00:00Z',
  },
  {
    id: 'mail-2002',
    from: 'GitHub <noreply@github.com>',
    subject: '[lshhhhhhh/desktop-kanojo] new star',
    snippet: 'A new user starred your repo desktop-kanojo ...',
    body: 'github star body',
    date: '2026-05-17T07:00:00Z',
  },
  {
    id: 'mail-2003',
    from: 'Quora Digest <digest@quora.com>',
    subject: 'Quora: 3 questions answered this week',
    snippet: '...',
    body: 'quora body',
    date: '2026-05-17T06:00:00Z',
  },
  {
    id: 'mail-2004',
    from: 'AWS Billing <billing@amazon.com>',
    subject: 'Your AWS monthly invoice',
    snippet: 'Total due: $12.34 ...',
    body: 'aws billing body',
    date: '2026-05-16T22:00:00Z',
  },
  {
    id: 'mail-2005',
    from: 'Mom <mom@example.com>',
    subject: '记得吃饭',
    snippet: '今天有没有按时吃饭？...',
    body: '今天有没有按时吃饭呀',
    date: '2026-05-16T12:00:00Z',
  },
]

// Track tool calls for assertion.
const callLog = []

// ---------- Inline ModelMessage helpers (mirror src/main/chat.ts) ----------

function episodesToMessages(episodes) {
  const sorted = episodes.slice().sort((a, b) => a.id - b.id)
  const out = []
  for (const e of sorted) {
    if (e.speaker === 'user') {
      out.push({ role: 'user', content: e.text })
      continue
    }
    if (e.speaker === 'tool') {
      const results = (e.toolParts ?? []).filter((p) => p.type === 'tool-result')
      if (results.length === 0) continue
      out.push({
        role: 'tool',
        content: results.map((r) => ({
          type: 'tool-result',
          toolCallId: r.toolCallId,
          toolName: r.toolName,
          output: { type: 'json', value: r.output },
        })),
      })
      continue
    }
    // assistant
    const calls = (e.toolParts ?? []).filter((p) => p.type === 'tool-call')
    if (calls.length === 0) {
      out.push({ role: 'assistant', content: e.text })
    } else {
      const parts = []
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

// ---------- Minimal sqlite memory adapter mirroring production schema ----------

function fakeEmbed(text) {
  // Deterministic-ish 512-dim vector seeded from text length. Good enough to
  // exercise the vec0 storage path; we don't rely on recall semantics here.
  const dim = 512
  const out = new Float32Array(dim)
  let seed = text.length + 1
  for (let i = 0; i < dim; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    out[i] = (seed / 0x7fffffff) * 2 - 1
  }
  return out
}

function openMemory(dir) {
  const db = new Database(join(dir, 'memory.sqlite'))
  db.pragma('journal_mode = WAL')
  sqliteVec.load(db)
  db.exec(`
    CREATE TABLE episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      speaker TEXT NOT NULL CHECK (speaker IN ('user', 'assistant', 'tool')),
      text TEXT NOT NULL,
      session_id TEXT,
      tool_data TEXT,
      archived INTEGER DEFAULT 0
    );
    CREATE VIRTUAL TABLE episodes_vec USING vec0(
      episode_id INTEGER PRIMARY KEY,
      embedding FLOAT[512]
    );
  `)

  const sessionId = 'test-session'

  const insertEpisode = db.prepare(
    'INSERT INTO episodes (ts, speaker, text, session_id, tool_data) VALUES (?, ?, ?, ?, ?)',
  )
  const insertVec = db.prepare(
    'INSERT INTO episodes_vec (episode_id, embedding) VALUES (?, ?)',
  )
  const selectRecent = db.prepare(
    `SELECT id, ts, speaker, text, session_id AS sessionId, tool_data AS toolDataRaw
     FROM episodes WHERE archived = 0 ORDER BY id ASC`,
  )

  function rowToEpisode(r) {
    let toolParts
    if (r.toolDataRaw) {
      try {
        const parsed = JSON.parse(r.toolDataRaw)
        if (Array.isArray(parsed) && parsed.length > 0) toolParts = parsed
      } catch {}
    }
    return {
      id: r.id,
      ts: r.ts,
      speaker: r.speaker,
      text: r.text,
      sessionId: r.sessionId,
      toolParts,
    }
  }

  return {
    addEpisode(speaker, text, toolParts) {
      const ts = new Date().toISOString()
      const td = toolParts && toolParts.length > 0 ? JSON.stringify(toolParts) : null
      const row = insertEpisode.run(ts, speaker, text, sessionId, td)
      const id = Number(row.lastInsertRowid)
      insertVec.run(BigInt(id), Buffer.from(fakeEmbed(text || ' ').buffer))
      return id
    },
    all() {
      return selectRecent.all().map(rowToEpisode)
    },
    close() {
      db.close()
    },
  }
}

// ---------- Driver mirroring src/main/chat.ts:runChat ----------

async function driveTurn({ model, userText, mem, tools }) {
  const history = episodesToMessages(mem.all())
  mem.addEpisode('user', userText, undefined)
  const messages = [...history, { role: 'user', content: userText }]

  const result = streamText({
    model,
    temperature: 1,
    system:
      '你是一个邮箱小助手。用户问"看看邮件"先调用 listRecentEmails；' +
      '用户问"打开 X / 读 X 那封"等明确指代上一次列表中某封邮件时，调用 readEmail，' +
      'id 必须来自上一次 listRecentEmails 的 items[].id，不要凭空写 "1" 或 "latest"。' +
      '工具调用完用一两句话回复用户即可，不要复读 JSON。',
    messages,
    tools,
    stopWhen: stepCountIs(3),
    maxRetries: 0,
  })

  let assistantText = ''
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') assistantText += part.text
    if (part.type === 'error') {
      console.error('stream error:', part.error)
      throw part.error instanceof Error ? part.error : new Error(String(part.error))
    }
  }

  // Persist via result.steps — same as production chat.ts.
  const steps = await result.steps
  for (const step of steps) {
    const stepText = (step.text ?? '').trim()
    const calls = (step.toolCalls ?? []).map((c) => ({
      type: 'tool-call',
      toolCallId: c.toolCallId,
      toolName: c.toolName,
      input: c.input,
    }))
    if (stepText || calls.length > 0) {
      mem.addEpisode('assistant', stepText, calls.length > 0 ? calls : undefined)
    }
    const results = (step.toolResults ?? []).map((r) => ({
      type: 'tool-result',
      toolCallId: r.toolCallId,
      toolName: r.toolName,
      output: r.output ?? r,
    }))
    if (results.length > 0) {
      mem.addEpisode('tool', '', results)
    }
  }

  return { assistantText, steps }
}

// ---------- Assertions ----------

const assertions = []
function check(name, ok, detail) {
  assertions.push({ name, ok, detail })
  console.log(ok ? `  ✅ ${name}` : `  ❌ ${name} :: ${detail ?? ''}`)
}

// ---------- Main ----------

async function main() {
  try {
    process.loadEnvFile('.env')
  } catch {}

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    console.error('❌ GEMINI_API_KEY missing in .env')
    app.exit(1)
    return
  }

  const dir = mkdtempSync(join(tmpdir(), 'openmeido-agent-loop-'))
  console.log('Temp memory dir:', dir)

  const mem = openMemory(dir)
  const google = createGoogleGenerativeAI({ apiKey })
  // Flash, not pro. Filter / agent-loop assertions don't need a reasoning
  // model; flash returns in <3s vs ~30s for pro and the tool decisions are
  // identical for this scenario.
  const model = google(process.env.MODEL || 'gemini-2.5-flash')

  const listRecentEmails = tool({
    description:
      '查看用户邮箱里最近的邮件。返回的是邮件摘要（含 id），不是完整正文 —— ' +
      '如果用户要细节，从结果里挑 id 再调 readEmail。',
    inputSchema: z.object({
      limit: z.number().int().min(1).max(20),
      onlyUnread: z.boolean(),
    }),
    execute: async ({ limit, onlyUnread }) => {
      callLog.push({ name: 'listRecentEmails', input: { limit, onlyUnread } })
      const items = FAKE_EMAILS.slice(0, limit).map((m) => ({
        id: m.id,
        from: m.from,
        subject: m.subject,
        snippet: m.snippet,
        date: m.date,
        unread: !onlyUnread,
      }))
      return { items }
    },
  })

  const readEmail = tool({
    description:
      '读取一封邮件的完整正文。id 必须来自之前 listRecentEmails 的 items[].id。' +
      '不要写 "1" / "latest" / subject 字面值。',
    inputSchema: z.object({
      id: z.string().describe('Email id from a previous listRecentEmails result.'),
    }),
    execute: async ({ id }) => {
      callLog.push({ name: 'readEmail', input: { id } })
      const m = FAKE_EMAILS.find((x) => x.id === id)
      if (!m) return { error: `id="${id}" not found` }
      return m
    },
  })

  const tools = { listRecentEmails, readEmail }

  // ---- Turn 1 ----
  console.log('\n--- Turn 1: 看看邮件 ---')
  await driveTurn({ model, userText: '看看邮件', mem, tools })
  const turn1Calls = callLog.slice()
  check(
    'turn 1 called listRecentEmails',
    turn1Calls.some((c) => c.name === 'listRecentEmails'),
    `got: ${JSON.stringify(turn1Calls.map((c) => c.name))}`,
  )
  check(
    'turn 1 did NOT call readEmail',
    !turn1Calls.some((c) => c.name === 'readEmail'),
    'should only list, not read',
  )

  // Reset log before turn 2 so we measure only its calls.
  callLog.length = 0

  // ---- Turn 2 ----
  console.log('\n--- Turn 2: 打开 WWDC 通知那封 ---')
  await driveTurn({ model, userText: '打开 WWDC 通知那封', mem, tools })
  const turn2Calls = callLog.slice()
  const readCall = turn2Calls.find((c) => c.name === 'readEmail')
  check(
    'turn 2 called readEmail',
    !!readCall,
    `got: ${JSON.stringify(turn2Calls.map((c) => c.name))}`,
  )
  if (readCall) {
    check(
      'turn 2 readEmail used real id (mail-2001 for WWDC)',
      readCall.input.id === 'mail-2001',
      `got id="${readCall.input.id}" — model hallucinated instead of using turn-1 result`,
    )
  } else {
    check('turn 2 readEmail used real id (mail-2001 for WWDC)', false, 'no readEmail call at all')
  }
  check(
    'turn 2 did NOT re-list',
    !turn2Calls.some((c) => c.name === 'listRecentEmails'),
    'should reuse turn 1 list, not re-fetch',
  )

  // ---- Memory shape assertions ----
  const allEpisodes = mem.all()
  const byRole = (sp) => allEpisodes.filter((e) => e.speaker === sp)
  console.log(
    `\nMemory snapshot: ${allEpisodes.length} rows (user=${byRole('user').length}, assistant=${byRole('assistant').length}, tool=${byRole('tool').length})`,
  )

  check(
    'memory has 2 user rows',
    byRole('user').length === 2,
    `got ${byRole('user').length}`,
  )
  check(
    'memory has ≥1 tool row (turn 1 listRecentEmails result)',
    byRole('tool').length >= 1,
    `got ${byRole('tool').length}`,
  )

  // tool_call_id linkage: every tool result's toolCallId must match an
  // assistant turn's tool_call.toolCallId.
  const assistantCallIds = new Set()
  for (const e of byRole('assistant')) {
    for (const p of e.toolParts ?? []) {
      if (p.type === 'tool-call') assistantCallIds.add(p.toolCallId)
    }
  }
  let danglingResults = 0
  for (const e of byRole('tool')) {
    for (const p of e.toolParts ?? []) {
      if (p.type === 'tool-result' && !assistantCallIds.has(p.toolCallId)) {
        danglingResults++
      }
    }
  }
  check(
    'every tool-result has a matching tool-call in an assistant row',
    danglingResults === 0,
    `${danglingResults} dangling result(s) — tool_call_id linkage broken`,
  )

  mem.close()
  rmSync(dir, { recursive: true, force: true })

  const failed = assertions.filter((a) => !a.ok)
  console.log(
    `\n${failed.length === 0 ? '✅' : '❌'} ${assertions.length - failed.length}/${assertions.length} passed`,
  )
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(main).catch((err) => {
  console.error('crashed:', err)
  app.exit(1)
})
