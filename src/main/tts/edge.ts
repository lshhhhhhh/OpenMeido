import { MsEdgeTTS, OUTPUT_FORMAT, type Voice } from 'msedge-tts'

import type { TTSResult, TTSVoice } from './types.js'

let voicesCache: TTSVoice[] | null = null

export async function listEdgeVoices(): Promise<TTSVoice[]> {
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
 * Escape text for the SSML body. msedge-tts splices `toStream(input)`
 * straight into its `<speak><voice><prosody>…` template with NO escaping
 * (checked 2.0.5 and 2.0.8 — the input is documented as "can include SSML
 * elements"), so a reply like `张三 <a@b.com>` or `R&D` produced malformed
 * SSML and the service silently returned nothing. Escaped exactly once,
 * here — sanitizeForTTS stays plain-text because the cloud engines take
 * raw text and would read `&amp;` aloud.
 *
 * Also drops C0 control chars that are illegal in XML 1.0 (only \t \n \r
 * are allowed); one stray \x1b is enough to break the whole document.
 */
export function escapeSsmlText(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Whole-call budget. A normal reply synthesizes in 1-3s. */
const EDGE_TOTAL_TIMEOUT_MS = 25_000
/** Connect + first audio frame. Edge streams audio almost immediately once
 *  the socket is up, so silence this long means a stalled socket / 墙. */
const EDGE_FIRST_AUDIO_TIMEOUT_MS = 15_000

/**
 * Microsoft Edge TTS path. Each call opens a fresh WebSocket — connections
 * are bursty (one per reply) so a kept-warm pool buys little, and idle
 * connections get evicted by the Edge service anyway.
 *
 * Every failure mode rejects with a short Chinese message (the renderer
 * shows it as a toast via tts-host): connect error, no audio within
 * EDGE_FIRST_AUDIO_TIMEOUT_MS, not done within EDGE_TOTAL_TIMEOUT_MS, stream
 * cut before turn.end (msedge-tts ≥ 2.0.8 surfaces that as an error), or a
 * clean end with zero bytes. The socket is always closed on the way out, so
 * a timed-out call can't leave an orphaned WebSocket behind.
 */
export async function synthesizeEdge(text: string, voice: string): Promise<TTSResult> {
  const tts = new MsEdgeTTS()
  const ssmlText = escapeSsmlText(text)
  try {
    return await new Promise<TTSResult>((resolve, reject) => {
      const chunks: Buffer[] = []
      let settled = false
      const finish = (err: Error | null, result?: TTSResult): void => {
        if (settled) return
        settled = true
        clearTimeout(totalTimer)
        clearTimeout(firstAudioTimer)
        if (err) reject(err)
        else resolve(result!)
      }
      const totalTimer = setTimeout(
        () => finish(new Error(`Edge TTS 超时（${EDGE_TOTAL_TIMEOUT_MS / 1000} 秒内没合成完）`)),
        EDGE_TOTAL_TIMEOUT_MS,
      )
      const firstAudioTimer = setTimeout(
        () =>
          finish(
            new Error(`Edge TTS 连接超时（${EDGE_FIRST_AUDIO_TIMEOUT_MS / 1000} 秒内没收到音频）`),
          ),
        EDGE_FIRST_AUDIO_TIMEOUT_MS,
      )

      tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3).then(
        () => {
          if (settled) return // timed out while connecting; finally{} closes
          let audioStream: ReturnType<MsEdgeTTS['toStream']>['audioStream']
          try {
            audioStream = tts.toStream(ssmlText).audioStream
          } catch (err) {
            finish(new Error(`Edge TTS 请求失败：${errMessage(err)}`, { cause: err }))
            return
          }
          audioStream.on('data', (c: Buffer) => {
            chunks.push(c)
            clearTimeout(firstAudioTimer)
          })
          audioStream.on('end', () => {
            const buf = Buffer.concat(chunks)
            if (buf.length === 0) {
              finish(new Error('Edge TTS 返回了空音频（音色名不对，或文本被服务端拒绝）'))
              return
            }
            finish(null, { base64: buf.toString('base64'), mimeType: 'audio/mpeg' })
          })
          audioStream.on('error', (err) => {
            finish(new Error(`Edge TTS 连接中断，音频不完整：${errMessage(err)}`, { cause: err }))
          })
        },
        (err: unknown) => {
          const msg = errMessage(err).replace(/^Edge TTS WebSocket error:\s*/i, '')
          // setMetadata throws synchronously-ish on a voice name without a
          // locale prefix (e.g. a stale config value); everything else is
          // the WebSocket failing to open.
          finish(
            /voiceLocale/i.test(msg)
              ? new Error(`Edge TTS 音色名无效：${voice}`, { cause: err })
              : new Error(`Edge TTS 连接失败：${msg}`, { cause: err }),
          )
        },
      )
    })
  } finally {
    tts.close()
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
