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
import { runExtraction, runExtractionWithImages } from './chat-host.js'
import { getMemoryService } from './memory-host.js'
import { captureAllScreensPng } from './screen-host.js'
import { resolvePersona } from '../shared/config.js'
import { buildProactiveRemarkPrompt } from '../shared/daily-prompts.js'
import { formatLocalNow } from '../shared/time-format.js'
import type { Config } from '../shared/config.js'
import type { ProactiveDecision, Trigger } from '../core/perception/types.js'
import type { MemoryService } from '../core/memory/service.js'

/** Cap on how many trailing assistant lines to feed into the proactive
 *  prompt as "you recently said this". 5 is enough to catch verbatim
 *  loops without bloating prompt context. */
const RECENT_SELF_LIMIT = 5
const RECENT_SELF_MAX_CHARS_PER = 80

/**
 * Pull the most recent assistant remarks (oldest→newest within the
 * window) for the proactive observer's "don't repeat yourself" hint.
 *
 * We look back ~20 episodes and keep the last RECENT_SELF_LIMIT
 * assistant turns with non-empty text. Tool-call wrapper rows are
 * skipped. Each line is truncated so the prompt stays small.
 */
async function getRecentSelfRemarks(memory: MemoryService): Promise<string[]> {
  try {
    const episodes = await memory.listRecent(20)
    const assistantOnly = episodes
      .filter((e) => e.speaker === 'assistant' && e.text && e.text.trim().length > 0)
      .slice(-RECENT_SELF_LIMIT)
    return assistantOnly.map((e) =>
      e.text.length > RECENT_SELF_MAX_CHARS_PER
        ? e.text.slice(0, RECENT_SELF_MAX_CHARS_PER) + '…'
        : e.text,
    )
  } catch (err) {
    console.warn('[proactive] failed to read recent self-remarks:', err)
    return []
  }
}

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

// Persona-aware prompt now lives in shared/daily-prompts.ts so we don't
// duplicate addressing rules across multiple "side LLM" sites. See
// buildProactiveRemarkPrompt — it consumes persona + now + triggers and
// keeps the JSON contract identical to what parseDecision below expects.

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

  const persona = resolvePersona(cfg.persona)
  const memoryForCtx = getMemoryService()
  const userName = memoryForCtx
    ? await memoryForCtx.getUserName().catch(() => null)
    : null
  // Pull the last few assistant turns so the prompt can show "you
  // recently said X" — without this the proactive observer at low
  // temperature happily repeats the same line every cycle.
  const recentSelfRemarks = memoryForCtx
    ? await getRecentSelfRemarks(memoryForCtx)
    : []
  // Creative temperature: 0.2 is fine for JSON gate decisions but
  // produces deterministic repetition on the `comment` field. Bump to
  // 0.7 so similar triggers yield varied phrasing.
  const creativeTemp = 0.7
  let raw: string
  try {
    if (cfg.proactive.includeScreen) {
      // Vision path — capture every connected screen, hand them to the
      // gating LLM along with the prompt. Failure to capture (no
      // displays / permission denied) silently falls back to text-only.
      let images: { mimeType: string; bytes: Uint8Array }[] = []
      try {
        const pngs = await captureAllScreensPng()
        images = pngs.map((bytes) => ({ mimeType: 'image/png', bytes }))
      } catch (err) {
        console.warn('[proactive] screen capture failed, falling back to text:', err)
      }
      const prompt = buildProactiveRemarkPrompt({
        persona,
        now: formatLocalNow(),
        triggers: triggers.map((t) => ({ kind: t.kind, note: t.note })),
        userName,
        hasScreenshot: images.length > 0,
        recentSelfRemarks,
      })
      raw =
        images.length > 0
          ? await runExtractionWithImages(prompt, images, {
              temperature: creativeTemp,
            })
          : await runExtraction(prompt, { temperature: creativeTemp })
    } else {
      const prompt = buildProactiveRemarkPrompt({
        persona,
        now: formatLocalNow(),
        triggers: triggers.map((t) => ({ kind: t.kind, note: t.note })),
        userName,
        recentSelfRemarks,
      })
      raw = await runExtraction(prompt, { temperature: creativeTemp })
    }
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
