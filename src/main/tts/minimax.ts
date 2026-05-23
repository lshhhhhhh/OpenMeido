/**
 * MiniMax T2A v2 (海螺语音) adapter.
 *
 * Two regions share the same request shape; only the host differs:
 *   - region='cn'     → api.minimaxi.com (canonical mainland host)
 *   - region='global' → api.minimax.io
 *
 * Power users can paste a custom baseUrl (e.g. legacy api.minimax.chat)
 * to override the region default — empty `baseUrl` falls back to the
 * region-default host.
 *
 * Auth: bearer token, with the org id appended as `?GroupId=...` query
 * param. Response audio is **hex-encoded** in `data.audio` (not base64
 * like every other provider we touch) — we hex-decode here.
 */

import type { Config } from '../../shared/config.js'
import type { TTSResult } from './types.js'

const DEFAULT_HOST_CN = 'https://api.minimaxi.com'
const DEFAULT_HOST_GLOBAL = 'https://api.minimax.io'

export interface MinimaxRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/**
 * Pure body+header+url builder so unit tests can assert the wire format
 * without standing up a fake fetch.
 */
export function buildMinimaxRequest(
  text: string,
  cfg: Config['tts']['minimax'],
): MinimaxRequest {
  if (!cfg.apiKey) throw new Error('MiniMax: 没填 API key（Settings → 语音 → MiniMax）')
  if (!cfg.groupId) throw new Error('MiniMax: 没填 GroupId（在 MiniMax 控制台账户信息里）')
  if (!cfg.voiceId.trim()) throw new Error('MiniMax: 没选音色（voice_id）')

  const host = (cfg.baseUrl.trim() || (cfg.region === 'global' ? DEFAULT_HOST_GLOBAL : DEFAULT_HOST_CN)).replace(/\/$/, '')
  const url = `${host}/v1/t2a_v2?GroupId=${encodeURIComponent(cfg.groupId)}`

  return {
    url,
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: {
      model: cfg.model,
      text,
      stream: false,
      voice_setting: {
        voice_id: cfg.voiceId,
        speed: cfg.speed,
        vol: cfg.volume,
        pitch: cfg.pitch,
      },
      audio_setting: {
        sample_rate: 32000,
        bitrate: 128000,
        format: 'mp3',
        channel: 1,
      },
    },
  }
}

/** Decode a hex string ("ff a3 0e ...") back to Buffer. Tolerant of
 *  whitespace and uppercase. MiniMax returns audio bytes hex-encoded —
 *  every other provider sends base64; the hex thing is theirs. */
function hexToBuffer(hex: string): Buffer {
  const clean = hex.replace(/[\s,]+/g, '')
  if (clean.length % 2 !== 0) {
    throw new Error('MiniMax: response audio hex string has odd length')
  }
  return Buffer.from(clean, 'hex')
}

export async function synthesizeMinimax(
  text: string,
  cfg: Config['tts']['minimax'],
): Promise<TTSResult> {
  const req = buildMinimaxRequest(text, cfg)

  // 60s timeout. T2A v2 typically returns in <2s for one reply; 60s
  // covers tail latencies and gives us a clear error vs hanging forever.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  let resp: Response
  try {
    resp = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: controller.signal,
    })
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error('MiniMax 请求超时（60s）——网络或 MiniMax 服务异常。')
    }
    throw new Error(
      `连不上 MiniMax (${req.url}) — ${err instanceof Error ? err.message : String(err)}`,
    )
  } finally {
    clearTimeout(timer)
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`MiniMax HTTP ${resp.status}: ${body.slice(0, 300) || resp.statusText}`)
  }

  const json = (await resp.json()) as {
    data?: { audio?: string; status?: number }
    base_resp?: { status_code?: number; status_msg?: string }
  }

  // MiniMax 用 base_resp.status_code 表示业务错误（HTTP 200 但内容失败）。
  // 0 = success; 非 0 必须当作错误抛出，否则后面 hex-decode 会拿到空串再静默失败。
  const status = json.base_resp?.status_code
  if (typeof status === 'number' && status !== 0) {
    throw new Error(
      `MiniMax 业务错误 (status=${status}): ${json.base_resp?.status_msg ?? '(no message)'}`,
    )
  }
  const hex = json.data?.audio
  if (!hex) {
    throw new Error('MiniMax 返回里没有 data.audio 字段 — 检查 voice_id / model 是否有效')
  }
  const buf = hexToBuffer(hex)
  if (buf.length === 0) {
    throw new Error('MiniMax 返回空音频 — 文本可能被过滤或 voice_id 不可用')
  }
  return { base64: buf.toString('base64'), mimeType: 'audio/mpeg' }
}
