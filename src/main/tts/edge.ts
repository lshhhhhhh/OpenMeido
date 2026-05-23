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
 * Microsoft Edge TTS path. Each call opens a fresh WebSocket — connections
 * are bursty (one per reply) so a kept-warm pool buys little, and idle
 * connections get evicted by the Edge service anyway.
 */
export async function synthesizeEdge(text: string, voice: string): Promise<TTSResult> {
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
