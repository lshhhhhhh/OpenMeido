/**
 * Text-to-speech main-process backend.
 *
 * Two engines are wired in:
 *   - Microsoft Edge TTS (free, online, ws — `msedge-tts` package)
 *   - GPT-SoVITS api_v2.py over plain HTTP (local zero-shot voice cloning)
 *
 * Both flatten to the same surface: text in → base64-encoded audio + mimeType
 * out. The renderer decodes with `AudioContext.decodeAudioData`, which handles
 * MP3 and WAV transparently, so the pipeline doesn't need to know which
 * engine produced the bytes.
 *
 * No streaming for v1 — full-buffer synth gives ~300-700ms latency for
 * typical reply lengths, which feels fine for chat. Streaming sentence-by-
 * sentence is a future polish (matches imouto-oss).
 */

import { MsEdgeTTS, OUTPUT_FORMAT, type Voice } from 'msedge-tts'

import { getConfig } from './config.js'
import type { Config } from '../shared/config.js'

export interface TTSVoice {
  shortName: string
  locale: string
  gender: string
  friendlyName: string
}

export interface TTSResult {
  /** Base64-encoded audio bytes — ready to decode in the renderer. */
  base64: string
  /** Tells the renderer which decoder hint to use; both `audio/mpeg` and
   *  `audio/wav` are accepted by Web Audio's `decodeAudioData`. */
  mimeType: 'audio/mpeg' | 'audio/wav'
}

let voicesCache: TTSVoice[] | null = null

export async function listVoices(): Promise<TTSVoice[]> {
  if (voicesCache) return voicesCache
  const tts = new MsEdgeTTS()
  try {
    const all = await tts.getVoices()
    voicesCache = all.map((v: Voice) => ({
      shortName: v.ShortName,
      locale: v.Locale,
      gender: v.Gender,
      friendlyName: v.FriendlyName,
    }))
    return voicesCache
  } finally {
    tts.close()
  }
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
  if (cfg.backend === 'sovits') return synthesizeSovits(safe, cfg.sovits)
  return synthesizeEdge(safe, cfg.voice)
}

/**
 * Strip XML/HTML-looking tags before TTS. Edge TTS wraps the input in
 * SSML server-side; if the input itself contains `<think>`, `</think>`,
 * or other angle-bracketed garbage that a thinking-mode model leaked
 * past the chat filter, the SSML becomes malformed and the service
 * returns a binary payload that decodeAudioData later rejects with
 * "Unable to decode audio data". Strip them here as belt-and-braces.
 */
function sanitizeForTTS(text: string): string {
  return text
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/<\/?(?:think|thinking|tool_call|arg_key|arg_value)(?:\s[^>]*)?>/gi, '')
    .trim()
}

/**
 * Microsoft Edge TTS path. Each call opens a fresh WebSocket — connections
 * are bursty (one per reply) so a kept-warm pool buys little, and idle
 * connections get evicted by the Edge service anyway.
 */
async function synthesizeEdge(text: string, voice: string): Promise<TTSResult> {
  const tts = new MsEdgeTTS()
  try {
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
    const { audioStream } = tts.toStream(text)
    const chunks: Buffer[] = []
    await new Promise<void>((resolve, reject) => {
      audioStream.on('data', (c: Buffer) => chunks.push(c))
      audioStream.on('end', () => resolve())
      audioStream.on('error', (err) => reject(err))
    })
    const buf = Buffer.concat(chunks)
    return { base64: buf.toString('base64'), mimeType: 'audio/mpeg' }
  } finally {
    tts.close()
  }
}

/**
 * GPT-SoVITS api_v2.py path. Requires the server to already have a voice
 * model loaded (and the ref audio path readable from the server's POV).
 *
 * We use `media_type: 'wav'` + non-streaming for simplicity — the renderer
 * gets one buffer to decode, no PCM reassembly. If latency turns out to be
 * an issue we can switch to streaming + raw PCM later; the renderer's
 * AudioContext can play AudioBuffers built from raw int16 too.
 */
async function synthesizeSovits(
  text: string,
  cfg: Config['tts']['sovits'],
): Promise<TTSResult> {
  if (!cfg.refAudio || !cfg.refText) {
    throw new Error(
      'GPT-SoVITS 需要在设置里填 ref_audio 路径和它的文字转写（同一段录音的内容）。',
    )
  }
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/tts`
  const payload = {
    text,
    text_lang: cfg.textLang,
    ref_audio_path: cfg.refAudio,
    prompt_text: cfg.refText,
    prompt_lang: cfg.refLang,
    media_type: 'wav',
    streaming_mode: false,
    top_k: cfg.topK,
    top_p: cfg.topP,
    temperature: cfg.temperature,
    speed_factor: cfg.speedFactor,
  }

  // 120s timeout because cold-start SoVITS inference on CPU can run that
  // long for medium-length text. On GPU it's typically <5s.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)
  let resp: Response
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error('GPT-SoVITS 请求超时（120s）—— 服务器是否在跑？')
    }
    throw new Error(
      `连不上 GPT-SoVITS (${cfg.baseUrl}) — 检查 api_v2.py 是否在跑，端口是否对。底层错误：${err instanceof Error ? err.message : String(err)}`,
    )
  } finally {
    clearTimeout(timer)
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(
      `GPT-SoVITS HTTP ${resp.status}: ${body.slice(0, 300) || resp.statusText}`,
    )
  }

  const buf = Buffer.from(await resp.arrayBuffer())
  if (buf.length === 0) {
    throw new Error('GPT-SoVITS 返回空响应 — 检查 ref_audio 路径在服务器上是否可读')
  }
  return { base64: buf.toString('base64'), mimeType: 'audio/wav' }
}
