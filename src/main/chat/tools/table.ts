import { tool } from 'ai'
import { z } from 'zod'

import { openTableWindow } from '../../table-host.js'

export const presentTable = tool({
  description:
    '把结构化数据以独立窗口的表格形式呈现给用户。**何时调用**：用户要求"列表 / 表格 / 汇总 / 制表"类输出，或一次性返回多条带相同结构的信息（邮件汇总、待办清单、文件清单等）。\n' +
    '\n' +
    '**典型场景**：\n' +
    '- "总结最近 10 个邮件" / "把邮件做成表格" → 读完后调一次本工具\n' +
    '- "再加一列发送时间" / "隐藏 Uber Eats 相关的" / "按时间排序" → **重新**调一次，传更新后的 columns/rows，默认替换当前窗口\n' +
    '- "再做一个 X 的表 / 加一个 tab 对比 / 也帮我把 Y 列出来" → `addAsTab: true`（在同一个窗口里加一个 tab，用户可以左右切换对照）\n' +
    '- "另开一个完全独立的窗口" → `newWindow: true`\n' +
    '\n' +
    '**邮件汇总专项规则**：\n' +
    '1. **同线程折叠**：来回讨论同一主题的邮件合并为一行。10 封邮件可能合成 3-10 行。\n' +
    '2. **每行字段建议**：序号 / 发件人 / 主题 / 最新进展 / 时间 / 背景信息（早期来回的简短摘要，≤50 字）。\n' +
    '3. **合并标注**：合并了多封时，在背景信息里写明"共 N 封来回"。\n' +
    '4. **重要标记**：在"最新进展"列开头用 **重要**: / **加急**: 等前缀。\n' +
    '\n' +
    '**rows 是"数组的数组"**（不是对象数组），每个 row 是一个数组，**第 i 个值对应 columns 的第 i 列**。这种结构纯按位置对齐，不需要写 key 名——避免了"中英文 key 对不上"那一类的渲染翻车。\n' +
    '\n' +
    '示例：columns=["序号","发件人","主题"]，rows=[[1,"alice@x","项目进度"], [2,"bob@y","请假申请"]]\n' +
    '\n' +
    '**约束**：\n' +
    '- 每个 row 的长度**必须**等于 columns.length；缺失字段用空字符串 "" 占位\n' +
    '- 值用简短中文，单元格不要超过 80 字\n' +
    '- 一次调用传完整数据，不要分多次（空 rows 会被拒绝）\n' +
    '\n' +
    '调用后简短一句"表格已开"即可，**不要**用文字复述表格内容。',
  inputSchema: z.object({
    title: z
      .string()
      .describe('表格标题，例："最近邮件汇总"。'),
    columns: z
      .array(z.string())
      .min(1)
      .describe('列名数组，按显示顺序。'),
    rows: z
      .array(
        z.array(
          z.union([z.string(), z.number(), z.null()]),
        ),
      )
      .describe(
        '数组的数组。每个 row 是一个数组，**长度必须 = columns.length**，第 i 个元素对应 columns[i] 那一列。例：columns=["序号","发件人"] → rows=[[1,"alice"],[2,"bob"]]。',
      ),
    addAsTab: z
      .boolean()
      .optional()
      .describe(
        'true = 把这个表作为新 tab 加到当前表格窗口，让用户能在同一个窗口里左右切换对照；' +
          '默认 false。优先用 addAsTab 表达"加一个表用来对比"，而不是 newWindow——单窗口多 tab 比多窗口更整洁。',
      ),
    newWindow: z
      .boolean()
      .optional()
      .describe(
        'true = 重新开一个完全独立的表格窗口（不与当前窗口共用 tab）。' +
          '默认 false = 替换当前窗口的内容。仅当用户明说"另开窗口 / 单独开"才用。',
      ),
  }),
  execute: async ({ title, columns, rows, addAsTab, newWindow }) => {
    console.log(
      `[presentTable] called title="${title}" cols=${columns.length} rows=${rows.length} ` +
        `addAsTab=${Boolean(addAsTab)} newWindow=${Boolean(newWindow)}`,
    )

    // Position-based schema means there's no key matching to fail. The
    // only structural error possible is row length not matching column
    // count — surface that as a tool error so the model retries with
    // correctly-shaped rows.
    const badRow = rows.findIndex((r) => r.length !== columns.length)
    if (badRow !== -1) {
      const r = rows[badRow]!
      console.warn(
        `[presentTable] row ${badRow} has ${r.length} values, expected ${columns.length}`,
      )
      return {
        error:
          `第 ${badRow + 1} 行长度是 ${r.length}，应该是 ${columns.length}（等于 columns 长度）。` +
          `每个 row 必须是和 columns 等长的数组，第 i 个元素对应 columns[i]。` +
          `缺失字段用空字符串 "" 占位，不要省略元素。请重新调 presentTable。`,
      }
    }

    try {
      openTableWindow(
        { title, columns, rows },
        { newWindow: Boolean(newWindow), addAsTab: Boolean(addAsTab) },
      )
      console.log(`[presentTable] openTableWindow returned ok`)
      return {
        ok: true,
        title,
        columnCount: columns.length,
        rowCount: rows.length,
        opened: newWindow
          ? 'new-window'
          : addAsTab
            ? 'added-as-tab'
            : 'updated-or-new',
      }
    } catch (err) {
      console.warn('[presentTable] failed:', err)
      return {
        error: err instanceof Error ? err.message : String(err),
      }
    }
  },
})
