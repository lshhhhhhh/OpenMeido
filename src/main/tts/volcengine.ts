/**
 * 火山引擎 大模型语音合成（豆包）adapter.
 *
 * Endpoint: openspeech.bytedance.com/api/v1/tts (one host, cluster picks
 * between standard 火山 TTS and the 大模型/voice-cloning variants).
 *
 * Quirk worth noting: the Authorization header is the literal string
 *   "Bearer;<access_token>"
 * with a semicolon, NOT a space. This is the documented ByteDance auth
 * scheme — every other provider uses `Bearer <token>` with a space; if
 * you copy this header pattern elsewhere it WILL fail auth.
 *
 * Audio comes back base64-encoded in the top-level `data` field. Default
 * encoding is mp3; we pin it here so the renderer's decoder hint stays
 * constant.
 */

import { randomUUID } from 'node:crypto'

import type { Config } from '../../shared/config.js'
import type { TTSResult } from './types.js'

const DEFAULT_HOST = 'https://openspeech.bytedance.com'

export interface VolcengineRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/**
 * Pure builder for the request envelope. Pulled out so the unit test can
 * assert the literal `Bearer;<token>` auth header — the easiest thing to
 * get wrong about this provider.
 *
 * `reqid` defaults to a fresh uuid each call; tests pass a fixed value so
 * the snapshot stays stable.
 */
export function buildVolcengineRequest(
  text: string,
  cfg: Config['tts']['volcengine'],
  opts?: { reqid?: string },
): VolcengineRequest {
  if (!cfg.appid) throw new Error('火山引擎: 没填 appid（Settings → 语音 → 火山引擎）')
  if (!cfg.accessToken) throw new Error('火山引擎: 没填 access token')
  if (!cfg.voiceType.trim()) throw new Error('火山引擎: 没选音色（voice_type）')
  if (!cfg.cluster.trim()) throw new Error('火山引擎: 没设 cluster（默认 volcano_tts）')

  const host = (cfg.baseUrl.trim() || DEFAULT_HOST).replace(/\/$/, '')
  const url = `${host}/api/v1/tts`

  return {
    url,
    headers: {
      // The semicolon is intentional. ByteDance auth scheme — see header
      // doc-comment at top of file for why we don't "fix" this to a space.
      Authorization: `Bearer;${cfg.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: {
      app: {
        appid: cfg.appid,
        // The body also carries `token` — `accessToken` ≠ `token` in some
        // 火山 plans, but the public TTS doc says use the same access token
        // here too. Users with a separate body-token can paste it; we fall
        // back to accessToken which works for the common case.
        token: cfg.bodyToken.trim() || cfg.accessToken,
        cluster: cfg.cluster,
      },
      user: {
        uid: 'openmeido',
      },
      audio: {
        voice_type: cfg.voiceType,
        encoding: 'mp3',
        speed_ratio: cfg.speedRatio,
        // The doc accepts but doesn't require rate / volume_ratio /
        // pitch_ratio for the 大模型 cluster — leaving them off so the
        // server picks sane defaults per voice.
      },
      request: {
        reqid: opts?.reqid ?? randomUUID(),
        text,
        text_type: 'plain',
        operation: 'query', // non-streaming; one buffer back
      },
    },
  }
}

export async function synthesizeVolcengine(
  text: string,
  cfg: Config['tts']['volcengine'],
): Promise<TTSResult> {
  const req = buildVolcengineRequest(text, cfg)

  // 60s timeout — same rationale as MiniMax.
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
      throw new Error('火山引擎 请求超时（60s）——网络或服务异常。')
    }
    throw new Error(
      `连不上火山引擎 (${req.url}) — ${err instanceof Error ? err.message : String(err)}`,
    )
  } finally {
    clearTimeout(timer)
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`火山引擎 HTTP ${resp.status}: ${body.slice(0, 300) || resp.statusText}`)
  }

  const json = (await resp.json()) as {
    code?: number
    message?: string
    data?: string
  }

  // ByteDance 用 code === 3000 表示成功；任何别的 code 都是错误（哪怕 HTTP 200）。
  // 把业务错误显式抛出来，避免 base64-decode 拿到非音频 payload。
  if (typeof json.code === 'number' && json.code !== 3000) {
    throw new Error(`火山引擎 业务错误 (code=${json.code}): ${json.message ?? '(no message)'}`)
  }

  if (!json.data) {
    throw new Error('火山引擎 返回里没有 data 字段 — 检查 cluster / voice_type 是否匹配')
  }

  const buf = Buffer.from(json.data, 'base64')
  if (buf.length === 0) {
    throw new Error('火山引擎 返回空音频 — voice_type 可能跟 cluster 不匹配')
  }
  return { base64: buf.toString('base64'), mimeType: 'audio/mpeg' }
}
