/**
 * Demo-mode lines loaded from `<userData>/demos.json`. The renderer fetches
 * fresh on every Ctrl+Shift+D press, so the user can edit the file in any
 * text editor and the next keypress picks up the change — no app restart.
 *
 * On first run we write a default file so the user has something to look at
 * and a template to copy. After that we never overwrite — the user owns the
 * file.
 */

import { app } from 'electron'
import { promises as fsp, existsSync } from 'node:fs'
import { join } from 'node:path'

import type { Demo } from '../shared/demos.js'

const DEMOS_FILENAME = 'demos.json'

/** Seeded on first run — copy-friendly starting point. */
const DEFAULT_DEMOS: Demo[] = [
  {
    hotkey: '1',
    text: '主任你又在看尼尼孩孩的比赛啊，他们什么时候能拿 major 冠军啊。',
    expression: '星星眼',
  },
  {
    hotkey: '2',
    text: '主人你又在熬夜写代码了。休息一会儿好不好',
    expression: '生气',
  },
]

export function getDemosPath(): string {
  return join(app.getPath('userData'), DEMOS_FILENAME)
}

/**
 * Read demos.json. Behavior:
 *   - File missing → seed defaults and return them.
 *   - File is a flat array of demos (current schema) → return as-is.
 *   - File is the older `{ hotkey, sequence }` object → flatten by giving
 *     every entry that wrapper's hotkey, then rewrite the file so subsequent
 *     edits see the new shape.
 *   - File is a bare array WITHOUT hotkeys (oldest schema) → assign defaults
 *     '1', '2', '3'... so each demo has SOME hotkey and the user can edit.
 *   - Parse / shape failure → return defaults, leave file untouched.
 *
 * Bogus entries are dropped so a single typo can't disable the whole feature.
 */
export async function readDemos(): Promise<Demo[]> {
  const path = getDemosPath()
  if (!existsSync(path)) {
    await fsp.writeFile(path, JSON.stringify(DEFAULT_DEMOS, null, 2), 'utf-8')
    return DEFAULT_DEMOS
  }
  let raw: string
  try {
    raw = await fsp.readFile(path, 'utf-8')
  } catch (err) {
    console.warn(`[demos] read failed (${path}):`, err)
    return DEFAULT_DEMOS
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    console.warn('[demos] JSON parse failed — defaults used:', err)
    return DEFAULT_DEMOS
  }

  // `{ hotkey, sequence }` — older "one global hotkey + cycling sequence"
  // schema. Flatten: each entry inherits the global hotkey (so they all
  // share a single trigger, preserving the old cycling behavior), then
  // rewrite the file so the user sees the new per-demo-hotkey shape.
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as { hotkey?: unknown; sequence?: unknown }
    if (Array.isArray(obj.sequence)) {
      const fallbackHk = typeof obj.hotkey === 'string' && obj.hotkey ? obj.hotkey : '1'
      const migrated = filterDemos(obj.sequence, fallbackHk)
      try {
        await fsp.writeFile(path, JSON.stringify(migrated, null, 2), 'utf-8')
        console.log('[demos] migrated { hotkey, sequence } → flat per-demo array')
      } catch (err) {
        console.warn('[demos] migration write failed (in-memory only):', err)
      }
      return migrated
    }
  }

  if (Array.isArray(parsed)) {
    return filterDemos(parsed, '1')
  }

  console.warn('[demos] root is not array or object — defaults used')
  return DEFAULT_DEMOS
}

/**
 * Filter to entries with a text field, fill in missing hotkeys using
 * positional defaults ('1', '2', ...). `fallbackHkForFirst` is what entries
 * without a hotkey get when index === 0 (used to preserve a wrapper's old
 * global hotkey during migration).
 */
function filterDemos(input: unknown[], fallbackHkForFirst: string): Demo[] {
  let nextDefault = 1
  return input
    .filter((d): d is { hotkey?: unknown; text?: unknown; [k: string]: unknown } => {
      return Boolean(d) && typeof (d as { text?: unknown }).text === 'string'
    })
    .map((d, i): Demo => ({
      hotkey:
        typeof d.hotkey === 'string' && d.hotkey
          ? d.hotkey
          : i === 0
            ? fallbackHkForFirst
            : String(nextDefault++ + 1),
      text: d.text as string,
      expression:
        typeof d.expression === 'string' || d.expression === null
          ? (d.expression as string | null)
          : undefined,
      motion:
        d.motion && typeof d.motion === 'object'
          ? (d.motion as Demo['motion'])
          : undefined,
    }))
}
