/**
 * Weekly review — once a week the active persona surfaces a short
 * reflection on what you've talked about this week. Pulls real
 * episodes from memory, distills 3-5 highlights via the lightweight
 * LLM tier, composes a tier-voiced "looking back at this week with
 * you" remark.
 *
 * Cadence: check hourly; fire when ALL of these hold:
 *   - last review for active persona is >7 days ago (or never)
 *   - it's a "reasonable" time of day (default 8am-11pm local)
 *   - user hasn't typed in the last 60 seconds (don't talk over them)
 *   - proactive isn't in cooldown from a recent fire
 *
 * Failure modes (no episodes / LLM error / persona switched mid-flight)
 * leave lastReviewAt untouched so we retry next cycle.
 */

import { BrowserWindow, powerMonitor } from 'electron'

import { getConfig } from './config.js'
import { getMemoryService, getMemoryAdapter } from './memory-host.js'
import { runExtraction } from './chat-host.js'
import { resolvePersona } from '../shared/config.js'
import { buildTierPromptBlock } from '../shared/affinity.js'
import { buildWeeklyReviewPrompt } from '../shared/daily-prompts.js'
import { classifyAndApply } from './emotion-classifier.js'

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const CHECK_INTERVAL_MS = 60 * 60 * 1000 // 1 hour

let timer: NodeJS.Timeout | null = null

export function initWeeklyReview(): void {
  // Run once shortly after boot (5 min) so we catch users who've been
  // idle a while, then hourly afterward.
  setTimeout(() => void maybeFire(), 5 * 60 * 1000)
  timer = setInterval(() => void maybeFire(), CHECK_INTERVAL_MS)
}

export function stopWeeklyReview(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

async function maybeFire(): Promise<void> {
  try {
    const cfg = getConfig()
    // Weekly review piggybacks on the proactive gate — when the user has
    // explicitly muted spontaneous remarks, surfacing a multi-paragraph
    // review card is the same intrusion they opted out of.
    if (cfg.proactive.mode === 'mute') return
    const personaId = cfg.persona.preset

    const adapter = getMemoryAdapter()
    const memory = getMemoryService()
    if (!adapter || !memory) return

    const record = await adapter.getAffinity(personaId)
    // Time gate: at least 7 days since last review.
    if (record.lastReviewAt) {
      const elapsed = Date.now() - new Date(record.lastReviewAt).getTime()
      if (elapsed < SEVEN_DAYS_MS) return
    }

    // Time-of-day gate: don't surface at 3 AM.
    const h = new Date().getHours()
    if (h < 8 || h >= 23) return

    // User-idle gate: skip if user used the system in the last
    // 60 seconds (typing / clicking). Without this, the review can
    // land in the middle of an active conversation, which kills it.
    const idleSec = powerMonitor.getSystemIdleTime()
    if (idleSec < 60) return

    // Pull last 7 days of episodes — both user + assistant turns.
    // The reviewer distills these into 3-5 highlights.
    const recent = await memory.listRecent(200).catch(() => [])
    const cutoff = Date.now() - SEVEN_DAYS_MS
    const thisWeek = recent.filter(
      (e) =>
        new Date(e.ts).getTime() >= cutoff &&
        (e.speaker === 'user' || e.speaker === 'assistant') &&
        e.text.trim().length > 0,
    )
    if (thisWeek.length < 6) {
      // Not enough material to reflect on — at least 3 user-assistant
      // pairs. Push the review forward by another week so it doesn't
      // re-check every hour on a quiet user.
      await adapter.touchLastReview(personaId)
      return
    }

    const persona = resolvePersona(cfg.persona)
    const tierBlock = buildTierPromptBlock(record.score, persona.name, persona.traits)
    const factsBlock = await memory.factsBlock(0.5).catch(() => '')
    const userName = await memory.getUserName().catch(() => null)
    // Truncate each episode body so the prompt stays tractable.
    const episodes = thisWeek.map((e) => ({
      speaker: e.speaker as 'user' | 'assistant',
      ts: e.ts,
      text: e.text.length > 160 ? e.text.slice(0, 160) + '…' : e.text,
    }))
    const prompt = buildWeeklyReviewPrompt({
      persona,
      tierBlock,
      score: record.score,
      userName,
      factsBlock,
      episodes,
    })
    let line = ''
    try {
      const raw = await runExtraction(prompt, { temperature: 0.85 })
      line = raw.trim()
    } catch (err) {
      console.warn('[weekly-review] LLM call failed:', err)
      return
    }
    if (!line || line.length < 20) return

    // Persist + broadcast + classify, just like a milestone.
    await adapter.touchLastReview(personaId)
    try {
      await memory.addEpisode('assistant', line)
    } catch (err) {
      console.warn('[weekly-review] episode persist failed:', err)
    }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('proactive:remark', {
          text: line,
          ts: new Date().toISOString(),
          triggers: ['weekly-review'],
        })
      }
    }
    console.log(`[weekly-review] fired (${personaId}): ${line.slice(0, 60)}…`)
    void classifyAndApply(line, '')
  } catch (err) {
    console.warn('[weekly-review] check failed:', err)
  }
}
