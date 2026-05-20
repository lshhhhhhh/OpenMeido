/**
 * Windows toast-notification listener.
 *
 * Spawns `notif-listener.ps1` as a child process, parses JSON lines on its
 * stdout, runs each notification through an allowlist + LLM `should_speak`
 * gate, then broadcasts as a `proactive:remark` event so the renderer treats
 * it like any other spontaneous remark.
 *
 * Reuses the proactive-host's `noteAssistantActivity` so the cooldown clock
 * applies — we don't want the maid commenting on a notification 2 seconds
 * after she just said something on her own.
 *
 * Windows-only. On macOS / Linux this module silently no-ops.
 */

import { BrowserWindow, app } from 'electron'
import { spawn, ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { getConfig, onConfigChange } from './config.js'
import { runExtraction } from './chat-host.js'
import { getMemoryService } from './memory-host.js'
import { noteAssistantActivity } from './proactive-host.js'
import { passesAllowlist, parseDecision } from './notif-utils.js'
import type { Config } from '../shared/config.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

interface NotifEvent {
  id: number
  app: string
  title: string
  body: string
  ts: string
}

let child: ChildProcess | null = null
let listenerReady = false
let listenerAccessDenied = false
const handled = new Set<number>()

export function isListenerReady(): boolean {
  return listenerReady
}
export function isListenerDenied(): boolean {
  return listenerAccessDenied
}


const PROMPT_PREFIX = `你现在是后台运行的"通知监听模式"。系统刚弹了一条通知，请判断要不要提示用户、怎么说。

判断标准：
- 看起来是私人消息 / 重要工作邮件 → should_speak=true，简短转告（"主人，<谁>在<哪>找你"）
- 营销 / 系统广播 / 软件更新 / 不重要的来源 → should_speak=false
- 你拿不准 → should_speak=false（宁可不说）

只输出 JSON，不要解释：
{"should_speak": true|false, "reason": "内部说明", "comment": "如果 should_speak=true 时要说的话；不超过 25 字"}

`

function buildPrompt(n: NotifEvent): string {
  return (
    `${PROMPT_PREFIX}` +
    `通知应用：${n.app}\n` +
    `标题：${n.title}\n` +
    `正文：${n.body || '(空)'}\n`
  )
}

async function handleNotification(n: NotifEvent): Promise<void> {
  if (handled.has(n.id)) return
  handled.add(n.id)
  // Trim memory so a long session doesn't grow the set unboundedly. The PS
  // side caps at ~500 visible ids anyway, but our renderer may run for days.
  if (handled.size > 1000) {
    const arr = [...handled]
    handled.clear()
    for (const x of arr.slice(-500)) handled.add(x)
  }

  // Coerce all string fields — PowerShell's ConvertTo-Json sometimes hands
  // us non-string objects for WinRT properties (e.g. when `.Text` came back
  // as an IInspectable wrapper). String() handles null / undefined / objects
  // uniformly; without it, `n.title.trim()` blows up with "trim is not a
  // function" on the first unusual notification.
  const app = String(n.app ?? '')
  const title = String(n.title ?? '')
  const body = String(n.body ?? '')

  const cfg = getConfig().proactive.notifListener
  if (!passesAllowlist(app, cfg.allowlist)) {
    console.log(`[notif] dropped (allowlist): ${app} — ${title}`)
    return
  }

  // Title-only notifications often come from system tools (file copies,
  // download progress) — skip when there's nothing to comment on.
  if (!title.trim() && !body.trim()) {
    console.log(`[notif] dropped (empty): ${app}`)
    return
  }
  console.log(`[notif] passed allowlist: ${app} — ${title} / ${body.slice(0, 60)}`)

  let raw: string
  try {
    // 0.6 — middle ground. The gate decision is binary so determinism
    // helps; the `comment` field benefits from some variation so the
    // same notification type doesn't get the same phrasing every time.
    raw = await runExtraction(buildPrompt({ ...n, app, title, body }), {
      temperature: 0.6,
    })
  } catch (err) {
    console.warn('[notif] LLM gate failed:', err)
    return
  }
  const decision = parseDecision(raw)
  if (!decision || !decision.shouldSpeak || !decision.comment?.trim()) {
    console.log(`[notif] LLM voted silent: ${decision?.reason ?? '(unparseable)'}`)
    return
  }
  console.log(`[notif] speaking: ${decision.comment}`)

  // Persist + broadcast same way as proactive-host does — keeps memory
  // consistent and the renderer doesn't need a new event type.
  const memory = getMemoryService()
  if (memory) void memory.addEpisode('assistant', decision.comment)
  noteAssistantActivity()

  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('proactive:remark', {
        text: decision.comment,
        ts: new Date().toISOString(),
        triggers: ['notification'],
      })
    }
  }
}

function spawnChild(): void {
  if (process.platform !== 'win32') {
    console.log('[notif] not on Windows — listener disabled')
    return
  }
  const scriptPath = resolveScriptPath()
  child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )

  let buf = ''
  child.stdout?.setEncoding('utf-8')
  child.stdout?.on('data', (chunk: string) => {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      try {
        const obj = JSON.parse(line) as Partial<NotifEvent & { status: string; error: string }>
        if (obj.status === 'ready') {
          listenerReady = true
          listenerAccessDenied = false
          console.log('[notif] listener ready')
          continue
        }
        if (obj.status === 'denied') {
          listenerAccessDenied = true
          console.warn('[notif] user denied notification listener permission')
          continue
        }
        if (obj.status === 'unsupported') {
          console.warn('[notif] unsupported (older Windows?):', obj.error)
          continue
        }
        if (obj.status === 'tick_error') {
          // Transient — don't spam logs.
          return
        }
        if (typeof obj.id === 'number' && typeof obj.app === 'string') {
          handleNotification(obj as NotifEvent).catch((err) =>
            console.warn('[notif] handler threw:', err),
          )
        }
      } catch (err) {
        console.warn('[notif] bad JSON line:', line.slice(0, 200), err)
      }
    }
  })
  child.stderr?.setEncoding('utf-8')
  child.stderr?.on('data', (d) => {
    // PowerShell errors come through here. Most are benign WinRT churn —
    // log at warn so it's findable but not noisy by default.
    const s = String(d).trim()
    if (s) console.warn('[notif][ps]', s.slice(0, 300))
  })
  child.on('exit', (code) => {
    listenerReady = false
    console.log(`[notif] child exited code=${code}`)
    child = null
  })
}

function resolveScriptPath(): string {
  // Three locations to try, ordered most → least likely:
  //   1) Prod: electron-builder's `extraFiles` lands it at
  //      <resourcesPath>/notif-listener.ps1 (sibling of app.asar).
  //   2) Dev: project-root path via cwd. electron-vite runs from the
  //      project root, so this is reliable in dev.
  //   3) Last resort: relative to __dirname (which in dev is out/main/ —
  //      jump up two levels to reach src/main/).
  const candidates = [
    join(process.resourcesPath ?? '', 'notif-listener.ps1'),
    join(process.cwd(), 'src', 'main', 'notif-listener.ps1'),
    join(__dirname, '..', '..', 'src', 'main', 'notif-listener.ps1'),
  ]
  for (const c of candidates) {
    if (!c) continue
    try {
      // Quick stat — readFileSync without buffer alloc would be cheaper
      // but require fs import; this branch runs once per app launch.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('node:fs') as typeof import('node:fs')
      if (fs.existsSync(c)) return c
    } catch {
      /* try next */
    }
  }
  return candidates[0]!
}

export function startNotifListener(): void {
  if (child) return
  const cfg = getConfig().proactive.notifListener
  if (!cfg.enabled) return
  spawnChild()
}

export function stopNotifListener(): void {
  if (!child) return
  try {
    child.kill()
  } catch {
    /* harmless */
  }
  child = null
  listenerReady = false
}

/** Call once after app.whenReady. Re-spawns on config toggle. */
export function initNotifListener(): void {
  startNotifListener()
  onConfigChange((next: Config) => {
    if (next.proactive.notifListener.enabled && !child) startNotifListener()
    else if (!next.proactive.notifListener.enabled && child) stopNotifListener()
  })
  app.on('before-quit', () => stopNotifListener())
}
