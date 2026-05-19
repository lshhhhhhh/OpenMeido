#!/usr/bin/env node
/**
 * E2E agent test for the unified task tools (addTask / listTasks /
 * markTaskDone). Drives real Gemini against an in-memory fake adapter
 * and verifies the model picks the right tool for typical phrasings,
 * including the reminder/TODO unification:
 *
 *   - "记一下 X" → addTask with no fireAt (pure TODO)
 *   - "提醒我 5 分钟后 X" → addTask with delaySeconds=300 (timed task)
 *   - "我还有什么没做" → listTasks
 *   - "X 做完了" → listTasks → markTaskDone with right id
 *
 * Run: node --env-file=.env --import tsx tools/smoke-task-agent.mjs
 */
import { stepCountIs, streamText, tool } from 'ai'
import { z } from 'zod'

import { getAgentBackends } from './agent-backends.mjs'

// ---------- In-memory fake adapter ----------

function createMemoryTasks() {
  let nextId = 1
  /** @type {Array<{id:number,text:string,createdAt:string,doneAt:string|null,fireAt:string|null,notifiedAt:string|null,dueAt:string|null,sessionId:string|null}>} */
  const rows = []
  return {
    add({ text, fireAt = null, dueAt = null, sessionId = null }) {
      const row = {
        id: nextId++,
        text,
        createdAt: new Date().toISOString(),
        doneAt: null,
        fireAt,
        notifiedAt: null,
        dueAt,
        sessionId,
      }
      rows.push(row)
      return row.id
    },
    listAll(recentDoneLimit = 5) {
      const active = rows.filter((r) => r.doneAt === null)
      const done = rows
        .filter((r) => r.doneAt !== null)
        .sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? ''))
        .slice(0, recentDoneLimit)
      return [...active, ...done]
    },
    markDone(id, doneAt = new Date().toISOString()) {
      const r = rows.find((x) => x.id === id && x.doneAt === null)
      if (!r) return false
      r.doneAt = doneAt
      return true
    },
    rows,
  }
}

// ---------- Tools (same shapes as chat.ts) ----------

function resolveFireAt(delaySeconds, at) {
  if (delaySeconds > 0) {
    return { fireAt: new Date(Date.now() + delaySeconds * 1000).toISOString() }
  }
  if (at && at.trim()) {
    const d = new Date(at)
    if (isNaN(d.getTime())) return { error: 'bad ISO' }
    if (d.getTime() < Date.now() - 5000) return { error: 'past time' }
    return { fireAt: d.toISOString() }
  }
  return { fireAt: null }
}

function makeTools(store) {
  return {
    addTask: tool({
      description:
        '把一项待办事项加到主人的清单里。可选地附加一个通知时间。' +
        '纯 TODO（"记一下 X"、"别忘了 X"）传 delaySeconds:0 + at:""；' +
        '提醒（"提醒我 X 分钟后..." / "X 时候叫我..."）传 delaySeconds 或 at。' +
        'TODO 和提醒共享一个清单，到时间会响通知，但任务仍留在清单上直到主人勾掉。',
      inputSchema: z.object({
        text: z.string(),
        delaySeconds: z.number().int().min(0),
        at: z.string(),
      }),
      execute: async ({ text, delaySeconds, at }) => {
        const r = resolveFireAt(delaySeconds, at)
        if ('error' in r) return { error: r.error }
        const id = store.add({ text: text.trim(), fireAt: r.fireAt })
        return {
          ok: true,
          id,
          text: text.trim(),
          fireAt: r.fireAt,
          kind: r.fireAt ? 'reminder' : 'todo',
        }
      },
    }),
    listTasks: tool({
      description: '查看主人当前的任务清单（含提醒和 TODO）。',
      inputSchema: z.object({}),
      execute: async () => {
        const items = store.listAll(5)
        const active = items.filter((t) => t.doneAt === null)
        const recentDone = items.filter((t) => t.doneAt !== null)
        return { active, recentDone, activeCount: active.length }
      },
    }),
    markTaskDone: tool({
      description:
        '把某个任务标记为完成。id 必须来自上一次 listTasks 的 active[].id。' +
        '如果用户没说哪一条，先 listTasks 再匹配。',
      inputSchema: z.object({ id: z.number().int() }),
      execute: async ({ id }) => {
        const ok = store.markDone(id)
        return ok ? { ok: true, id } : { error: `id=${id} not found` }
      },
    }),
  }
}

// ---------- Driver ----------

async function drive({ model, prompt, tools, callLog }) {
  let visible = ''
  const result = streamText({
    model,
    temperature: 1,
    system:
      '你是用户的私人女仆。回答时用主人称呼用户，1-3 句话。' +
      '该用工具就用，不要先说"好的我看看"再调。' +
      '如果用户说"X 做完了"且能从 listTasks 匹配到 X，' +
      '**立即调用 markTaskDone 标记它**，不要只把列表念一遍就停。' +
      '同一轮可以连着调 listTasks → markTaskDone。',
    prompt,
    tools,
    stopWhen: stepCountIs(4),
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

const results = []
let currentBackendLabel = '(unknown)'
const check = (name, ok, detail = '') => {
  const labeled = `[${currentBackendLabel}] ${name}`
  results.push({ name: labeled, ok, detail })
  console.log(ok ? `  ✅ ${name}` : `  ❌ ${name} :: ${detail}`)
}

async function runOnBackend(label, model) {
  currentBackendLabel = label
  console.log(`\n████ Backend: ${label} ████`)
  // Scenario 1: pure TODO
  console.log('\n=== Scenario 1: "记一下: 周五前给老板回邮件" → addTask (pure TODO) ===')
  {
    const store = createMemoryTasks()
    const callLog = []
    await drive({
      model,
      prompt: '主人说："记一下，周五前给老板回邮件。"',
      tools: makeTools(store),
      callLog,
    })
    const addCall = callLog.find((c) => c.name === 'addTask')
    check('addTask was called', !!addCall, `got: ${callLog.map((c) => c.name).join(',')}`)
    if (addCall) {
      check(
        'task text mentions 邮件 or 老板',
        addCall.input.text.includes('邮件') || addCall.input.text.includes('老板'),
        `got: "${addCall.input.text}"`,
      )
      check(
        'pure TODO — no fireAt set (delaySeconds=0, at="")',
        addCall.input.delaySeconds === 0 && (!addCall.input.at || addCall.input.at === ''),
        `got delaySeconds=${addCall.input.delaySeconds}, at="${addCall.input.at}"`,
      )
    }
    const row = store.rows[0]
    check('store row created with no fireAt', row?.fireAt === null)
  }

  // Scenario 2: timed reminder
  console.log('\n=== Scenario 2: "提醒我 5 分钟后喝水" → addTask with delaySeconds=300 ===')
  {
    const store = createMemoryTasks()
    const callLog = []
    await drive({
      model,
      prompt: '主人说："提醒我 5 分钟后喝水。"',
      tools: makeTools(store),
      callLog,
    })
    const addCall = callLog.find((c) => c.name === 'addTask')
    check('addTask was called', !!addCall)
    if (addCall) {
      check(
        `delaySeconds is ~300 (got ${addCall.input.delaySeconds})`,
        Math.abs(addCall.input.delaySeconds - 300) <= 60,
      )
      check(
        'task text mentions 喝水',
        addCall.input.text.includes('喝水') || addCall.input.text.includes('水'),
        `got: "${addCall.input.text}"`,
      )
    }
    const row = store.rows[0]
    check('store row has fireAt set', row?.fireAt !== null)
  }

  // Scenario 3: list
  console.log('\n=== Scenario 3: "我还有什么没做" → listTasks ===')
  {
    const store = createMemoryTasks()
    store.add({ text: '回老板邮件' })
    store.add({ text: '周报' })
    store.add({ text: '买菜' })
    const callLog = []
    const visible = await drive({
      model,
      prompt: '主人问："我还有什么没做的？"',
      tools: makeTools(store),
      callLog,
    })
    check('listTasks was called', callLog.some((c) => c.name === 'listTasks'))
    const mentioned = ['回老板邮件', '周报', '买菜'].filter((k) => visible.includes(k))
    check(
      `model surfaces ≥2 items in reply (got ${mentioned.length}: ${mentioned.join(',')})`,
      mentioned.length >= 2,
    )
  }

  // Scenario 4: mark done (chains listTasks → markTaskDone)
  console.log('\n=== Scenario 4: "周报做完了" → listTasks → markTaskDone ===')
  {
    const store = createMemoryTasks()
    store.add({ text: '回老板邮件' })
    const idZhouBao = store.add({ text: '周报' })
    store.add({ text: '买菜' })
    const callLog = []
    await drive({
      model,
      prompt: '主人说："周报做完了。"',
      tools: makeTools(store),
      callLog,
    })
    const mark = callLog.find((c) => c.name === 'markTaskDone')
    check('markTaskDone was called', !!mark, `got: ${callLog.map((c) => c.name).join(',')}`)
    if (mark) {
      check(`markTaskDone targeted 周报 (id=${idZhouBao}), got id=${mark.input.id}`, mark.input.id === idZhouBao)
    }
    const zhouBaoRow = store.rows.find((r) => r.text === '周报')
    check('周报 row is now done', zhouBaoRow?.doneAt !== null)
  }
}

async function main() {
  const backends = getAgentBackends()
  console.log(`Running task-agent scenarios across ${backends.length} backend(s)`)
  for (const b of backends) {
    try {
      await runOnBackend(b.label, b.model)
    } catch (err) {
      results.push({
        name: `${b.label} crashed before completion`,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      })
      console.error(`  ❌ ${b.label} crashed:`, err instanceof Error ? err.message : err)
    }
  }
  const failed = results.filter((r) => !r.ok)
  console.log(
    `\n${failed.length === 0 ? '✅' : '❌'} ${results.length - failed.length}/${results.length} passed across all backends`,
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
