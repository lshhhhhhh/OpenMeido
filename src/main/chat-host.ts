/**
 * Connectivity probe for the configured LLM backend. Hits the
 * OpenAI-compatible `/models` endpoint (free — no tokens spent) to verify
 * the user's API key and base URL are good.
 *
 * Note: `/models` only proves "auth works at this URL". It does NOT verify
 * the chosen model id is usable; that surfaces on the next real chat call.
 * Good enough for a setup-time sanity check.
 */

import { BrowserWindow } from 'electron'

import type { Config } from '../shared/config.js'
import { resolveBackendKey } from './config.js'

export type LlmStatus = 'ok' | 'error' | 'idle'

export interface LlmTestResult {
  ok: boolean
  error?: string
}

function broadcastStatus(status: LlmStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('chat:status', status)
  }
}

/** Mark the LLM status from main without doing a fresh test (e.g. after a
 *  real chat round-trip succeeds or fails). */
export function notifyLlmStatus(status: LlmStatus): void {
  broadcastStatus(status)
}

export async function testBackend(
  backendCfg: Config['backend'],
  apiKeyOverride?: string,
): Promise<LlmTestResult> {
  const apiKey = apiKeyOverride || resolveBackendKey(backendCfg)

  if (!apiKey) {
    const result = { ok: false, error: '未填 API key，且 .env 没有匹配的兜底' }
    broadcastStatus('error')
    return result
  }

  try {
    const url = backendCfg.baseUrl.replace(/\/$/, '') + '/models'
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (res.ok) {
      broadcastStatus('ok')
      return { ok: true }
    }
    const detail = await res.text().catch(() => '')
    const result = { ok: false, error: `${res.status} ${res.statusText} ${detail.slice(0, 120)}` }
    broadcastStatus('error')
    return result
  } catch (err) {
    const result = { ok: false, error: err instanceof Error ? err.message : String(err) }
    broadcastStatus('error')
    return result
  }
}
