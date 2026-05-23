import { tool } from 'ai'
import { z } from 'zod'

import { getTaskService } from '../../tasks-host.js'

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

export const addTask = tool({
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

export const listTasks = tool({
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

export const markTaskDone = tool({
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
