import type { Config } from '../../shared/config.js'
import type { TTSResult } from './types.js'

/**
 * GPT-SoVITS api_v2.py path. Requires the server to already have a voice
 * model loaded (and the ref audio path readable from the server's POV).
 *
 * We use `media_type: 'wav'` + non-streaming for simplicity — the renderer
 * gets one buffer to decode, no PCM reassembly. If latency turns out to be
 * an issue we can switch to streaming + raw PCM later; the renderer's
 * AudioContext can play AudioBuffers built from raw int16 too.
 */
export async function synthesizeSovits(
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
