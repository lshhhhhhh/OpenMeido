/**
 * Text-to-speech main-process dispatcher.
 *
 * Four engines plug in behind a single `synthesize` entry point. Each
 * adapter lives in `src/main/tts/<engine>.ts` and returns the same
 * `TTSResult` shape (base64 audio + mime hint). The renderer decodes
 * with `AudioContext.decodeAudioData`, so MP3 vs WAV is transparent.
 *
 *   - Edge        (`tts/edge.ts`)       Microsoft Edge TTS, free, online
 *   - SoVITS      (`tts/sovits.ts`)     GPT-SoVITS api_v2.py, local clone
 *   - MiniMax     (`tts/minimax.ts`)    海螺 T2A v2, cloud, preset voices
 *   - Volcengine  (`tts/volcengine.ts`) 大模型语音合成（豆包）, cloud
 *
 * No streaming for v1 — full-buffer synth gives ~300-700ms latency for
 * typical reply lengths, which feels fine for chat. Streaming sentence-by-
 * sentence is a future polish (matches imouto-oss).
 */

import { getConfig, resolveSovitsConfig } from './config.js'
import type { Config } from '../shared/config.js'

import { sanitizeForTTS } from './tts/sanitize.js'
import { listEdgeVoices, synthesizeEdge } from './tts/edge.js'
import { synthesizeSovits } from './tts/sovits.js'
import { synthesizeMinimax } from './tts/minimax.js'
import { synthesizeVolcengine } from './tts/volcengine.js'
import type { TTSResult, TTSVoice } from './tts/types.js'

export type { TTSResult, TTSVoice } from './tts/types.js'

/**
 * Only Edge TTS exposes a queryable catalog — the cloud providers have
 * fixed preset voice IDs we ship as a static list in
 * `shared/tts-voices.ts`. The IPC stays Edge-only for now; the Settings
 * UI references the shared static lists directly when the user picks a
 * different backend.
 */
export async function listVoices(): Promise<TTSVoice[]> {
  return listEdgeVoices()
}

/**
 * Synthesize `text` using whichever backend is configured. Callers normally
 * pass no `override` and let main read the persisted config; the Settings
 * preview button passes a draft so the user can try changes without saving.
 */
export async function synthesize(
  text: string,
  override?: Config['tts'],
): Promise<TTSResult> {
  const safe = sanitizeForTTS(text)
  if (!safe.trim()) throw new Error('tts: empty text')
  const cfg = override ?? getConfig().tts
  // Backend is whatever the user picked — no env override. (We tried a
  // TTS_BACKEND=sovits demo shortcut and it backfired: it forced SoVITS
  // even when the user explicitly picked Edge in Settings.) The only
  // .env convenience that survives is resolveSovitsConfig below, which
  // fills EMPTY SoVITS ref fields from env — so a demo just needs the
  // user to pick "GPT-SoVITS" once and the ref audio/text auto-populate,
  // no copy-paste. Picking any other engine behaves exactly as chosen.
  switch (cfg.backend) {
    case 'edge':
      return synthesizeEdge(safe, cfg.voice)
    case 'sovits':
      return synthesizeSovits(safe, resolveSovitsConfig(cfg.sovits))
    case 'minimax':
      return synthesizeMinimax(safe, cfg.minimax)
    case 'volcengine':
      return synthesizeVolcengine(safe, cfg.volcengine)
  }
}
