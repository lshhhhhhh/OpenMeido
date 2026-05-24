/**
 * Proactive observer — drives spontaneous remarks from the desktop maid.
 *
 * Polling loop:
 *   - Every PROACTIVE_POLL_INTERVAL_SEC (fixed 5s), evaluate triggers.
 *   - Cadence (idle / timer / cooldown / silence thresholds) is resolved
 *     at every tick from cfg.proactive.mode + the current affinity tier
 *     via cadenceFor() in shared/proactive-cadence.ts. Mute mode returns
 *     null and the loop bails out immediately.
 *   - Trigger types:
 *       timer  → N seconds since last assistant remark
 *       idle   → system idle ≥ threshold (uses Electron powerMonitor)
 *   - If any trigger fires, ask the LLM (via runExtraction) whether to speak.
 *   - On `shouldSpeak: true`, persist as an assistant episode and broadcast
 *     a 'proactive:remark' event to renderer windows so the chat panel
 *     can render it inline.
 */

import { BrowserWindow, powerMonitor } from 'electron'

import { getConfig, setConfig } from './config.js'
import { runExtraction, runExtractionWithImages } from './chat-host.js'
import { getMemoryService } from './memory-host.js'
import { captureAllScreensPng } from './screen-host.js'
import { classifyAndApplyEmotion } from './emotion-classifier.js'
import { currentTier } from './affinity-host.js'
import { buildTierPromptBlock, tierFor } from '../shared/affinity.js'
import {
  cadenceFor,
  PROACTIVE_POLL_INTERVAL_SEC,
  type ProactiveCadence,
} from '../shared/proactive-cadence.js'
import { evaluateTriggers } from '../shared/proactive-triggers.js'
import { resolvePersona } from '../shared/config.js'
import {
  buildProactiveRemarkPrompt,
  buildOnboardingScreenPeekPrompt,
} from '../shared/daily-prompts.js'
import { formatLocalNow } from '../shared/time-format.js'
import {
  shouldScheduleOnboardingPeek,
  shouldFireOnboardingPeek,
  pickOnboardingDelayMs,
} from '../shared/onboarding.js'
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
/**
 * Source-of-truth in-memory ring of the last few proactive remarks the
 * host emitted THIS process. Always populated regardless of whether
 * memory storage worked — guarantees the don't-repeat block in the
 * prompt has data. Persistence via memory.addEpisode is a separate path
 * for cross-session recall; this ring is for in-session anti-repeat.
 */
const recentSelfRing: string[] = []
function pushSelfRemark(line: string): void {
  if (!line.trim()) return
  recentSelfRing.push(line.trim())
  if (recentSelfRing.length > RECENT_SELF_LIMIT) {
    recentSelfRing.splice(0, recentSelfRing.length - RECENT_SELF_LIMIT)
  }
}

async function getRecentSelfRemarks(memory: MemoryService): Promise<string[]> {
  // Prefer the in-memory ring — it's always-populated AND reflects only
  // proactive output (not chat replies), which is what we want the model
  // to compare against when deciding "did I just say this?".
  // Memory.listRecent is a fallback in case the ring is empty (boot from
  // a long-running prior session etc.).
  if (recentSelfRing.length > 0) {
    return recentSelfRing.map((t) =>
      t.length > RECENT_SELF_MAX_CHARS_PER ? t.slice(0, RECENT_SELF_MAX_CHARS_PER) + '…' : t,
    )
  }
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

function collectTriggers(cadence: ProactiveCadence): Trigger[] {
  // Read Electron-side state once, hand it to the pure evaluator. The
  // idle-armed latch flip stays here (it's host-side mutable module
  // state, not part of the math) — we flip it after the pure call sees
  // it as `true`, which preserves the original "fire once per idle
  // window" semantic.
  const idleSec = powerMonitor.getSystemIdleTime()
  const sinceAssistantSec = (Date.now() - lastAssistantAt) / 1000
  const triggers = evaluateTriggers({
    cadence,
    idleSec,
    idleArmed,
    sinceAssistantSec,
  })
  if (triggers.some((t) => t.kind === 'idle')) {
    idleArmed = false
  }
  return triggers
}

// Persona-aware prompt now lives in shared/daily-prompts.ts so we don't
// duplicate addressing rules across multiple "side LLM" sites. See
// buildProactiveRemarkPrompt — it consumes persona + now + triggers and
// keeps the JSON contract identical to what parseDecision below expects.

/**
 * Pick a conversational angle for this proactive remark. Without this
 * rotation, every fire defaults to "observe what the user is doing on
 * screen" — felt monotonous after a day of use. Different angles let
 * the maid sometimes share her own moment, ask a question, or reference
 * past memory.
 *
 * Probability weights are tier-aware:
 *   - Lv.1 (stranger): heavy on observer (the safest mode for someone
 *     who barely knows the user); 'self' nearly suppressed because
 *     "let me tell you my feelings" reads as presumptuous from a
 *     stranger.
 *   - Lv.5 (intimate): more self / callback weight — at that point
 *     she has earned the right to share + reference shared history.
 *
 * 'callback' picks fall back to 'observer' here too when the caller
 * later finds it has nothing real to reference (pastObservations +
 * recentUserMessages both empty). That fallback decision is in the
 * caller's hands; the picker is unconditional.
 */
type ProactiveAngle = 'observer' | 'self' | 'callback' | 'curiosity'
function pickProactiveAngle(tier: 'tier1' | 'tier2' | 'tier3' | 'tier4' | 'tier5'): ProactiveAngle {
  // [observer, self, callback, curiosity] — must sum to 1.
  const weights: Record<typeof tier, [number, number, number, number]> = {
    tier1: [0.70, 0.05, 0.05, 0.20],
    tier2: [0.55, 0.15, 0.15, 0.15],
    tier3: [0.40, 0.25, 0.25, 0.10],
    tier4: [0.30, 0.30, 0.30, 0.10],
    tier5: [0.25, 0.35, 0.30, 0.10],
  }
  const [pObserver, pSelf, pCallback /*, pCuriosity */] = weights[tier]
  const r = Math.random()
  if (r < pObserver) return 'observer'
  if (r < pObserver + pSelf) return 'self'
  if (r < pObserver + pSelf + pCallback) return 'callback'
  return 'curiosity'
}

export function parseDecision(
  raw: string,
): (ProactiveDecision & { noted: string[] }) | null {
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
      noted?: unknown
    }
    if (typeof parsed.should_speak !== 'boolean') return null
    const noted = Array.isArray(parsed.noted)
      ? parsed.noted
          .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
          .map((x) => x.trim())
      : []
    return {
      shouldSpeak: parsed.should_speak,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      comment: typeof parsed.comment === 'string' ? parsed.comment : '',
      noted,
    }
  } catch {
    return null
  }
}

async function evaluate(): Promise<void> {
  const cfg = getConfig()
  // Resolve cadence from the user's mode + current affinity tier. Mute
  // mode short-circuits; auto + chatty get tier- or fixed-density numbers
  // from proactive-cadence.ts. currentTier() is the cached sync reader
  // populated by affinity-host; no DB hit on the polling path. (We can't
  // reuse the `tier` const declared later in this function — that one's
  // a TierInfo from tierFor(affinity.score), pulled after the awaits.)
  const cadenceTier = currentTier(cfg.persona.preset).tier
  const cadence = cadenceFor(cfg.proactive.mode, cadenceTier)
  if (!cadence) return
  const now = Date.now()
  const sinceLastFire = (now - lastFiredAt) / 1000
  const sinceLastUser = (now - lastUserAt) / 1000
  if (sinceLastFire < cadence.cooldownSec) return
  if (sinceLastUser < cadence.minSilenceSec) return
  const triggers = collectTriggers(cadence)
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
  // Affinity tier — without this proactive runs in "stranger" mode even
  // at high affinity, which reads as her never warming up no matter
  // how long the user uses OpenMeido. Single fetch per evaluation;
  // cheap (single SELECT against persona_affinity by PK).
  const affinity = memoryForCtx
    ? await memoryForCtx.getAffinity().catch(() => null)
    : null
  const tierBlock = buildTierPromptBlock(affinity?.score ?? 0, persona.name, persona.traits)
  // Roll a die for "this remark is an elaborate moment" — small chance
  // by design, scaled by tier so a stranger-tier 0-score persona never
  // unleashes a paragraph on a user who barely knows her. The host
  // still gates on the eventual LLM judgment (it can say
  // should_speak=false even when elaborate is allowed).
  const tier = tierFor(affinity?.score ?? 0)
  const elaborateProb = {
    tier1: 0, // never — too forward before a relationship exists
    tier2: 0.03,
    tier3: 0.08,
    tier4: 0.15,
    tier5: 0.25,
  }[tier.tier]
  const elaborate = Math.random() < elaborateProb

  // Elaborate mode = long-form remark. Pull the actual memory we have on
  // the user so the model can ground references in real material instead
  // of inventing "上周你说的 X" out of thin air. Short remarks skip this
  // — they don't have room to mention specifics anyway.
  let factsBlock = ''
  let recentUserMessages: string[] = []
  // Past silent screen observations — pulled when screen-mode is on,
  // regardless of elaborate. Drives "she remembers what you've been
  // watching" pattern recognition (CS2 + Falcons across days).
  let pastObservations: string[] = []
  if (memoryForCtx) {
    try {
      if (elaborate) {
        factsBlock = await memoryForCtx.factsBlock(0.5).catch(() => '')
        const episodes = await memoryForCtx.listRecent(40).catch(() => [])
        recentUserMessages = episodes
          .filter((e) => e.speaker === 'user' && e.text.trim().length > 0)
          .slice(-6)
          .map((e) => (e.text.length > 120 ? e.text.slice(0, 120) + '…' : e.text))
      }
      if (cfg.proactive.includeScreen) {
        const episodes = await memoryForCtx.listRecent(60).catch(() => [])
        pastObservations = episodes
          .filter((e) => e.speaker === 'assistant' && e.text.startsWith('[obs] '))
          .slice(-10)
          .map((e) => e.text.slice('[obs] '.length))
        // Also pull facts in screen mode even if not elaborate — they're
        // the distilled patterns ("user.interest.game: CS2") and the
        // model uses them to reference habits.
        if (!factsBlock) {
          factsBlock = await memoryForCtx.factsBlock(0.5).catch(() => '')
        }
      }
    } catch (err) {
      console.warn('[proactive] grounding pull failed:', err)
    }
  }
  // Pick a conversational angle so we don't fire the same "look at the
  // user" framing every time. Probabilities are tier-weighted (low
  // tiers stay observer-heavy; high tiers spread to self / callback).
  // callback needs real material — if rolled but neither factsBlock,
  // recentUserMessages, nor pastObservations have content, fall back
  // to observer so the prompt's "only reference real records" guard
  // doesn't make the model produce should_speak=false and waste the
  // slot. Done AFTER the material loads above so this check has data.
  let angle = pickProactiveAngle(tier.tier)
  if (angle === 'callback') {
    const hasMaterial =
      factsBlock.length > 0 ||
      recentUserMessages.length > 0 ||
      pastObservations.length > 0
    if (!hasMaterial) {
      console.log('[proactive] callback rolled but no material — falling back to observer')
      angle = 'observer'
    }
  }

  // Diagnostic: confirm the tier block is being built + which tier
  // it landed in. Helps users verify "tier got injected into proactive"
  // without having to print the full prompt.
  console.log(
    `[proactive] score=${affinity?.score ?? 0} (${tier.zhLabel}), elaborate=${elaborate}, angle=${angle}, tierBlock len=${tierBlock.length}`,
  )
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
        const pngs = await captureAllScreensPng(cfg.proactive.excludedScreenIds)
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
        tierBlock,
        elaborate,
        factsBlock,
        recentUserMessages,
        pastObservations,
        angle,
      })
      raw =
        images.length > 0
          ? await runExtractionWithImages(prompt, images, {
              temperature: creativeTemp,
              feature: 'proactive-vision',
            })
          : await runExtraction(prompt, {
              temperature: creativeTemp,
              feature: 'proactive',
            })
    } else {
      const prompt = buildProactiveRemarkPrompt({
        persona,
        now: formatLocalNow(),
        triggers: triggers.map((t) => ({ kind: t.kind, note: t.note })),
        userName,
        recentSelfRemarks,
        tierBlock,
        elaborate,
        factsBlock,
        recentUserMessages,
        angle,
      })
      raw = await runExtraction(prompt, {
        temperature: creativeTemp,
        feature: 'proactive',
      })
    }
  } catch (err) {
    console.warn('[proactive] LLM call failed:', err)
    // Release the cooldown so a working call can be tried sooner.
    lastFiredAt = 0
    return
  }
  const decision = parseDecision(raw)
  // Save silent observations from this capture regardless of whether
  // she ends up speaking — the memory of "what was on screen" is
  // valuable for future pattern recognition even when she chose silence.
  if (decision && decision.noted.length > 0 && memoryForCtx) {
    const obsText = '[obs] ' + decision.noted.join(', ')
    void memoryForCtx.addEpisode('assistant', obsText).catch((err) => {
      console.warn('[proactive] observation persist failed:', err)
    })
    console.log(`[proactive] noted: ${decision.noted.join(', ')}`)
  }
  if (!decision || !decision.shouldSpeak || !decision.comment.trim()) {
    console.log('[proactive] decision: silent', decision?.reason ?? '(unparseable)')
    return
  }

  // Persist as a real assistant episode so future context retrieval can
  // see it (otherwise the model would forget what it spontaneously said).
  const memory = getMemoryService()
  if (memory) void memory.addEpisode('assistant', decision.comment)
  // Also push to the in-process anti-repeat ring — this is the source
  // of truth for "what did I just say?" and is consulted on the next
  // evaluation cycle.
  pushSelfRemark(decision.comment)
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

  // Animate her face/body for the spontaneous line too — without this,
  // proactive remarks were rendered with the held expression from the
  // previous turn (or neutral). Fire-and-forget; classifier owns its
  // own error handling.
  void classifyAndApplyEmotion(decision.comment)
}

/**
 * Day-1 onboarding screen-peek. Called by greeting-host once the very
 * first greeting has broadcast. Fires ONCE per install: arms a 30–60s
 * timer, then either fires `forceOnboardingPeek()` (if the user has stayed
 * quiet) or aborts (if they already started chatting, or another remark
 * already went out).
 *
 * Safe to call on every launch — the config flag check makes subsequent
 * calls cheap no-ops. Cancellable via `cancelOnboardingPeek()` so a
 * config-change during the window doesn't fire a stale peek into a UI
 * that may have just been muted.
 */
let onboardingTimer: NodeJS.Timeout | null = null

export function scheduleOnboardingPeek(greetingTs: number): void {
  const cfg = getConfig()
  const skip = shouldScheduleOnboardingPeek(cfg)
  if (skip) {
    console.log(`[onboarding] not scheduling peek: ${skip}`)
    return
  }
  cancelOnboardingPeek()
  const delayMs = pickOnboardingDelayMs()
  console.log(`[onboarding] peek armed for ${Math.round(delayMs / 1000)}s from now`)
  onboardingTimer = setTimeout(() => {
    onboardingTimer = null
    const fireSkip = shouldFireOnboardingPeek({
      greetingTs,
      lastUserAt,
      lastAssistantAt,
    })
    if (fireSkip) {
      console.log(`[onboarding] timer fired but skipping: ${fireSkip}`)
      return
    }
    void forceOnboardingPeek()
  }, delayMs)
}

export function cancelOnboardingPeek(): void {
  if (onboardingTimer) {
    clearTimeout(onboardingTimer)
    onboardingTimer = null
  }
}

/**
 * Build + capture + LLM-call + broadcast for the onboarding peek.
 * Mirrors evaluate() but: (a) no gating, (b) onboarding-specific prompt,
 * (c) flips `onboarding.firstScreenPeekFired` to true on success.
 *
 * On any failure (capture down, LLM error, empty/silent decision), the
 * flag stays false so the next launch can retry. This means a flaky
 * first launch doesn't permanently kill the moment — but a successful
 * "should_speak=false" decision (e.g. user is on a sensitive screen)
 * also keeps the flag false, which is what we want.
 */
async function forceOnboardingPeek(): Promise<void> {
  const cfg = getConfig()
  // Re-check inside the timeout — config might have changed during the wait
  // (user opened Settings and toggled mute / screen off).
  const skip = shouldScheduleOnboardingPeek(cfg)
  if (skip) {
    console.log(`[onboarding] late skip after timer: ${skip}`)
    return
  }
  const persona = resolvePersona(cfg.persona)
  const memory = getMemoryService()
  const userName = memory ? await memory.getUserName().catch(() => null) : null
  const affinity = memory ? await memory.getAffinity().catch(() => null) : null
  const tierBlock = buildTierPromptBlock(affinity?.score ?? 0, persona.name, persona.traits)

  let images: { mimeType: string; bytes: Uint8Array }[] = []
  try {
    const pngs = await captureAllScreensPng(cfg.proactive.excludedScreenIds)
    images = pngs.map((bytes) => ({ mimeType: 'image/png', bytes }))
  } catch (err) {
    console.warn('[onboarding] screen capture failed, falling back to text-only:', err)
  }
  const prompt = buildOnboardingScreenPeekPrompt({
    persona,
    tierBlock,
    now: formatLocalNow(),
    userName,
    hasScreenshot: images.length > 0,
  })

  let raw: string
  try {
    raw =
      images.length > 0
        ? await runExtractionWithImages(prompt, images, {
            temperature: 0.7,
            feature: 'onboarding-peek',
          })
        : await runExtraction(prompt, {
            temperature: 0.7,
            feature: 'onboarding-peek',
          })
  } catch (err) {
    console.warn('[onboarding] LLM call failed:', err)
    return
  }
  const decision = parseDecision(raw)
  if (decision && decision.noted.length > 0 && memory) {
    void memory
      .addEpisode('assistant', '[obs] ' + decision.noted.join(', '))
      .catch((err) => console.warn('[onboarding] observation persist failed:', err))
  }
  if (!decision || !decision.shouldSpeak || !decision.comment.trim()) {
    console.log(
      '[onboarding] decision: silent —',
      decision?.reason ?? '(unparseable)',
      '(flag stays false, will retry next launch)',
    )
    return
  }

  if (memory) {
    void memory.addEpisode('assistant', decision.comment).catch((err) => {
      console.warn('[onboarding] episode persist failed:', err)
    })
  }
  pushSelfRemark(decision.comment)
  noteAssistantActivity()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('proactive:remark', {
        text: decision.comment,
        ts: new Date().toISOString(),
        triggers: ['onboarding'],
      })
    }
  }
  void classifyAndApplyEmotion(decision.comment)

  // Flip the flag — onboarding is over for this install.
  try {
    setConfig({
      ...cfg,
      onboarding: { ...cfg.onboarding, firstScreenPeekFired: true },
    })
    console.log(`[onboarding] peek fired: "${decision.comment}" — flag flipped`)
  } catch (err) {
    console.warn('[onboarding] flag flip failed (peek still broadcast):', err)
  }
}

export function startProactive(): void {
  stopProactive()
  const cfg = getConfig()
  if (cfg.proactive.mode === 'mute') return
  // Initial wait so we don't fire one second after startup. Poll interval
  // is now a hard-coded 5s (moved out of user-facing config, see
  // proactive-cadence.ts) — evaluate() itself bails fast on cooldown so
  // the loop is cheap.
  pollTimer = setInterval(() => {
    void evaluate()
  }, PROACTIVE_POLL_INTERVAL_SEC * 1000)
}

export function stopProactive(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}

/**
 * Wire to main. Call once after app.whenReady. Re-starts on config change
 * so toggling `proactive.mode` from Settings takes effect immediately.
 */
export function initProactive(onConfigChange: (cb: (cfg: Config) => void) => void): void {
  startProactive()
  onConfigChange(() => startProactive())
}
