/**
 * Celebration host — orchestrates the +5 reward UX when the user
 * crosses an onboarding milestone (first API key, first advanced TTS).
 *
 * Each celebration combines three things, in this order:
 *   1. Broadcast `affinity:celebration` with `{ kind, amount }` — the
 *      renderer renders a center-screen golden "+5 好感度" overlay.
 *   2. Pick a persona-specific celebration line and broadcast through
 *      the existing `proactive:remark` channel — chat bubble + TTS
 *      play exactly like any spontaneous remark.
 *   3. Bump affinity by +5 (bypasses daily cap) — fires the normal
 *      `affinity:changed` event so the chip animates too.
 *
 * Flag flipping happens in setConfig (where the diff is detected),
 * NOT here, so this host is safe to call from anywhere without
 * worrying about double-fire (the flag is already true by the time
 * we get here).
 */

import { BrowserWindow } from 'electron'

import { getConfig } from './config.js'
import { pickCelebrationLine } from './lines-host.js'
import { bumpAffinityForCelebration } from './affinity-host.js'
import { classifyAndApplyEmotion } from './emotion-classifier.js'
import { noteAssistantActivity } from './proactive-host.js'
import { getMemoryService } from './memory-host.js'
import type { CelebrationKind } from '../shared/celebrations.js'

const CELEBRATION_BUMP = 5
const KIND_TO_LINE_KEY: Record<CelebrationKind, 'aiSetup' | 'advancedTts'> = {
  ai: 'aiSetup',
  tts: 'advancedTts',
}
const KIND_TO_REASON: Record<CelebrationKind, string> = {
  ai: '主人配置好了 AI',
  tts: '主人换了新声音',
}

/**
 * Fire a celebration. Each kind is independent — if both 'ai' and 'tts'
 * triggered in the same setConfig (rare but possible if the user pasted
 * a key AND switched TTS in one Save), the caller invokes us twice and
 * the renderer queues / stacks the overlays.
 *
 * Silently no-ops if the active persona's memory isn't ready — we
 * prefer "skip" over "throw" because setConfig is in the hot path
 * and a stale celebration shouldn't break Settings saves.
 */
export async function fireCelebration(kind: CelebrationKind): Promise<void> {
  const cfg = getConfig()
  const personaId = cfg.persona.preset
  const line = pickCelebrationLine(personaId, KIND_TO_LINE_KEY[kind])

  // 1. Overlay event — emitted FIRST so the +5 animation starts as the
  // user is still looking at Settings (they'll see it pop in when they
  // close the panel) instead of after the maid finishes speaking.
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      w.webContents.send('affinity:celebration', {
        kind,
        amount: CELEBRATION_BUMP,
        reason: KIND_TO_REASON[kind],
      })
    }
  }

  // 2. Maid says her line. Use the proactive remark channel so the
  // bubble + TTS + emotion-classifier all wire up the same way as
  // greeting / spontaneous remarks.
  const memory = getMemoryService()
  if (memory) {
    void memory.addEpisode('assistant', line).catch((err) => {
      console.warn('[celebration] line persist failed:', err)
    })
  }
  noteAssistantActivity()
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      w.webContents.send('proactive:remark', {
        text: line,
        ts: new Date().toISOString(),
        triggers: [`celebration:${kind}`],
      })
    }
  }
  void classifyAndApplyEmotion(line)

  // 3. Bump affinity +5 — last because the chip animation reads best
  // AFTER the overlay (overlay grabs attention, then user's eye drifts
  // to the chip showing the new score).
  try {
    const nextScore = await bumpAffinityForCelebration(
      personaId,
      CELEBRATION_BUMP,
      KIND_TO_REASON[kind],
    )
    console.log(
      `[celebration] kind=${kind} fired — "${line}" · affinity→${nextScore}`,
    )
  } catch (err) {
    console.warn('[celebration] affinity bump failed (line + overlay still went out):', err)
  }
}
