/**
 * Proactive observer — drives spontaneous remarks from the desktop maid.
 *
 * Polling loop:
 *   - Every `pollIntervalSec`, evaluate triggers:
 *       timer  → N seconds since last assistant remark
 *       idle   → system idle >= idleThresholdSec (uses Electron powerMonitor)
 *   - Apply cooldowns: cooldownSec global, minSilenceSec since last user input.
 *   - If any trigger fires, ask the LLM (via runExtraction) whether to speak.
 *   - On `shouldSpeak: true`, persist as an assistant episode and broadcast
 *     a 'proactive:remark' event to renderer windows so the chat panel
 *     can render it inline.
 *
 * Why not include screen capture in v1: the existing screen tool already
 * works user-initiated, and proactive vision adds privacy concerns that
 * deserve their own settings toggle. Future task.
 */

import { BrowserWindow, powerMonitor } from 'electron'

import { getConfig } from './config.js'
import { runExtraction } from './chat-host.js'
import { getMemoryService } from './memory-host.js'
import type { Config } from '../shared/config.js'
import type { ProactiveDecision, Trigger } from '../core/perception/types.js'

let pollTimer: NodeJS.Timeout | null = null
let lastFiredAt = 0
let lastAssistantAt = Date.now()
let lastUserAt = Date.now()
let idleArmed = true // true → next idle threshold crossing can fire

/**
 * Renderer reports user activity via existing chat:send IPC. Main hooks
 * that in initProactive() and calls this to refresh the cooldown clocks.
 */
export function noteUserActivity(): void {
  lastUserAt = Date.now()
  // Re-arm the idle latch: any user input resets the "current idle period"
  // and lets a future long-idle window trigger another remark.
  idleArmed = true
}

export function noteAssistantActivity(): void {
  lastAssistantAt = Date.now()
}

function collectTriggers(cfg: Config['proactive']): Trigger[] {
  const triggers: Trigger[] = []
  const now = Date.now()
  const idleSec = powerMonitor.getSystemIdleTime()
  // Idle trigger — fires once when threshold is first crossed; latches
  // until any user activity rearms it.
  if (idleArmed && idleSec >= cfg.idleThresholdSec) {
    idleArmed = false
    triggers.push({
      kind: 'idle',
      at: new Date().toISOString(),
      note: `用户已经 ${Math.floor(idleSec / 60)} 分钟没有任何输入`,
    })
  }
  // Timer trigger — fires when N seconds have passed since the last
  // assistant remark (proactive OR user-driven).
  const sinceAssistant = (now - lastAssistantAt) / 1000
  if (sinceAssistant >= cfg.timerSec) {
    triggers.push({
      kind: 'timer',
      at: new Date().toISOString(),
      note: `距离你上一句已经 ${Math.floor(sinceAssistant / 60)} 分钟`,
    })
  }
  return triggers
}

const PROACTIVE_PROMPT = `你现在是后台运行的"主动模式"。系统检测到你可能该说点什么了。

判断标准：
- 用户应该专注做事时（凌晨在敲代码、刚发完很长一段话）→ should_speak=false
- 用户长时间不动可能在摸鱼/走神 → 可以关心一句
- 单纯定时器到点，但用户刚刚才发完话 → false（别打扰）
- 不确定 → false（宁可沉默）

只输出 JSON，不要解释：
{"should_speak": true|false, "reason": "内部说明", "comment": "如果 should_speak=true 时要说的话；不超过 30 字"}

`

function buildProactivePrompt(triggers: Trigger[]): string {
  const triggerLines = triggers.map((t) => `${t.kind}: ${t.note}`).join('\n')
  return `${PROACTIVE_PROMPT}\n触发原因：\n${triggerLines}\n`
}

function parseDecision(raw: string): ProactiveDecision | null {
  let text = raw.trim()
  const fenced = text.match(/```(?:json)?\s*([\s\S]+?)```/i)
  if (fenced) text = fenced[1]!.trim()
  const objMatch = text.match(/\{[\s\S]*\}/)
  const candidate = objMatch ? objMatch[0] : text
  try {
    const parsed = JSON.parse(candidate) as {
      should_speak?: unknown
      reason?: unknown
      comment?: unknown
    }
    if (typeof parsed.should_speak !== 'boolean') return null
    return {
      shouldSpeak: parsed.should_speak,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      comment: typeof parsed.comment === 'string' ? parsed.comment : '',
    }
  } catch {
    return null
  }
}

async function evaluate(): Promise<void> {
  const cfg = getConfig()
  if (!cfg.proactive.enabled) return
  const now = Date.now()
  const sinceLastFire = (now - lastFiredAt) / 1000
  const sinceLastUser = (now - lastUserAt) / 1000
  if (sinceLastFire < cfg.proactive.cooldownSec) return
  if (sinceLastUser < cfg.proactive.minSilenceSec) return
  const triggers = collectTriggers(cfg.proactive)
  if (triggers.length === 0) return

  // We tentatively claim the cooldown slot BEFORE the LLM call returns —
  // otherwise an overlapping poll could fire a second eval while the
  // first is still in flight, wasting tokens.
  lastFiredAt = now

  let raw: string
  try {
    raw = await runExtraction(buildProactivePrompt(triggers))
  } catch (err) {
    console.warn('[proactive] LLM call failed:', err)
    // Release the cooldown so a working call can be tried sooner.
    lastFiredAt = 0
    return
  }
  const decision = parseDecision(raw)
  if (!decision || !decision.shouldSpeak || !decision.comment.trim()) {
    console.log('[proactive] decision: silent', decision?.reason ?? '(unparseable)')
    return
  }

  // Persist as a real assistant episode so future context retrieval can
  // see it (otherwise the model would forget what it spontaneously said).
  const memory = getMemoryService()
  if (memory) void memory.addEpisode('assistant', decision.comment)
  noteAssistantActivity()

  // Broadcast to renderers so the chat panel appends a maid bubble.
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('proactive:remark', {
        text: decision.comment,
        ts: new Date().toISOString(),
        triggers: triggers.map((t) => t.kind),
      })
    }
  }
}

export function startProactive(): void {
  stopProactive()
  const cfg = getConfig()
  if (!cfg.proactive.enabled) return
  // Initial wait so we don't fire one second after startup.
  pollTimer = setInterval(() => {
    void evaluate()
  }, cfg.proactive.pollIntervalSec * 1000)
}

export function stopProactive(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}

/**
 * Wire to main. Call once after app.whenReady. Re-starts on config change
 * so toggling `proactive.enabled` from Settings takes effect immediately.
 */
export function initProactive(onConfigChange: (cb: (cfg: Config) => void) => void): void {
  startProactive()
  onConfigChange(() => startProactive())
}
