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
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { generateText, type LanguageModel } from 'ai'

import type { Config } from '../shared/config.js'
import { getConfig, resolveApiKey, resolveBackendKey } from './config.js'
import { lightweightModel, resolveTemperature } from '../shared/lightweight-models.js'
import { recordUsage, providerFromUrl } from './usage-host.js'

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

/**
 * One-shot text generation against the configured backend's LIGHTWEIGHT
 * tier. Used for "side LLM tasks": reflection (fact extraction), greeting
 * line, reminder line, proactive observer, notification gate, emotion
 * classification.
 *
 * Routes to a cheap fast text-only model when one is known for the host
 * (see src/shared/lightweight-models.ts) — falls back to the user's
 * configured chat model otherwise. Picking lightweight per host means
 * every reply that triggers an emotion classifier doesn't double our
 * inference cost or latency.
 *
 * `opts.temperature` defaults to 0.2 — good for structured/JSON extraction
 * where determinism matters (reflection, notif gate, emotion classifier).
 * Creative tasks (greeting, proactive remark, reminder line, goodbye)
 * should pass 0.7+ to avoid the model producing the same line every
 * time when the input is similar.
 *
 * Picks the same provider chat.ts picks (Google native for Gemini,
 * OpenAI-compat for everything else). Throws on failure — the caller
 * handles retries and parse failures.
 */
export async function runExtraction(
  prompt: string,
  opts: { temperature?: number; feature?: string } = {},
): Promise<string> {
  const cfg = getConfig()
  const apiKey = resolveApiKey(cfg)
  if (!apiKey) throw new Error('no API key')
  // Prefer the lightweight tier; fall back to the user's configured model
  // when no lightweight tier is known (e.g., LM Studio with one loaded
  // model).
  const modelId = lightweightModel(cfg.backend.baseUrl) ?? cfg.backend.model
  // Kimi requires temperature exactly 0.6 (HTTP 400 otherwise). Every
  // other provider takes the lower 0.2 we want for structured extraction.
  const isKimi =
    cfg.backend.baseUrl.includes('moonshot.cn') ||
    cfg.backend.baseUrl.includes('moonshot.ai')
  let model: LanguageModel
  if (cfg.backend.baseUrl.includes('googleapis.com')) {
    const google = createGoogleGenerativeAI({ apiKey })
    model = google(modelId)
  } else {
    // For Kimi: inject `thinking: {type: "disabled"}` even though
    // runExtraction is single-turn (so the reasoning_content-missing
    // 400 we saw in chat.ts shouldn't fire here). Cheap insurance —
    // if a future Kimi model adds new validations around thinking,
    // we're already covered.
    const wrappedFetch = isKimi
      ? (async (url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
          if (init && init.method === 'POST' && typeof init.body === 'string') {
            try {
              const body = JSON.parse(init.body) as {
                thinking?: { type: 'enabled' | 'disabled' }
              }
              body.thinking = { type: 'disabled' }
              init = { ...init, body: JSON.stringify(body) }
            } catch {
              /* malformed body — fall through */
            }
          }
          return globalThis.fetch(url, init)
        })
      : undefined
    const openai = createOpenAI({
      baseURL: cfg.backend.baseUrl,
      apiKey,
      ...(wrappedFetch
        ? { fetch: wrappedFetch as unknown as typeof globalThis.fetch }
        : {}),
    })
    // .chat() — see chat.ts for why we don't use the default factory.
    model = openai.chat(modelId)
  }
  // resolveTemperature handles per-model constraints (OpenAI gpt-5 omit,
  // Kimi pin to 0.6, everyone else free). Caller's opts.temperature
  // becomes the "desired" — used when the model has no constraint.
  // Default 0.2 (structured / deterministic).
  const temperature = resolveTemperature(modelId, opts.temperature ?? 0.2)
  const result = await generateText({ model, prompt, temperature })
  // Record token usage for the Settings → AI 用量 dashboard. Wraps
  // every call defensively — usage shape varies slightly across
  // provider impls in Vercel AI SDK and a missing field shouldn't
  // crash the LLM path it's instrumenting.
  try {
    const usage = result.usage as
      | {
          inputTokens?: number
          outputTokens?: number
          promptTokens?: number
          completionTokens?: number
          cachedInputTokens?: number
        }
      | undefined
    if (usage) {
      recordUsage({
        provider: providerFromUrl(cfg.backend.baseUrl),
        model: modelId,
        feature: opts.feature ?? 'extraction',
        promptTokens: usage.inputTokens ?? usage.promptTokens ?? 0,
        completionTokens: usage.outputTokens ?? usage.completionTokens ?? 0,
        cachedTokens: usage.cachedInputTokens ?? 0,
      })
    }
  } catch (err) {
    console.warn('[usage] runExtraction record failed (non-fatal):', err)
  }
  return result.text
}

/**
 * Multimodal variant of runExtraction — same routing rules but accepts
 * one or more images alongside the text prompt. Used by the proactive
 * observer's "look at the screen and decide whether to speak" path.
 *
 * Falls back to the user's main chat model when the lightweight tier is
 * text-only — vision-capable lightweight tiers exist on Gemini, GLM,
 * Qwen, Kimi (国际 / k2.6), but not on every provider.
 */
export async function runExtractionWithImages(
  prompt: string,
  images: { mimeType: string; bytes: Uint8Array }[],
  opts: { temperature?: number; feature?: string } = {},
): Promise<string> {
  const cfg = getConfig()
  const apiKey = resolveApiKey(cfg)
  if (!apiKey) throw new Error('no API key')
  const url = cfg.backend.baseUrl
  const isKimi = url.includes('moonshot.cn') || url.includes('moonshot.ai')
  // For vision tasks, prefer the lightweight tier if it's known vision-
  // capable; otherwise drop back to the user's main model (which we
  // guarantee is multimodal — OpenMeido needs it for screenshots).
  // Text-only lightweight tiers: deepseek-v4-flash, kimi-k2-turbo-preview.
  const lwModel = lightweightModel(url)
  const lwIsTextOnly =
    lwModel === 'deepseek-v4-flash' || lwModel === 'kimi-k2-turbo-preview'
  const modelId = lwModel && !lwIsTextOnly ? lwModel : cfg.backend.model
  let model: LanguageModel
  if (url.includes('googleapis.com')) {
    const google = createGoogleGenerativeAI({ apiKey })
    model = google(modelId)
  } else {
    const wrappedFetch = isKimi
      ? (async (u: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
          if (init && init.method === 'POST' && typeof init.body === 'string') {
            try {
              const body = JSON.parse(init.body) as {
                thinking?: { type: 'enabled' | 'disabled' }
              }
              body.thinking = { type: 'disabled' }
              init = { ...init, body: JSON.stringify(body) }
            } catch {
              /* malformed body — fall through */
            }
          }
          return globalThis.fetch(u, init)
        })
      : undefined
    const openai = createOpenAI({
      baseURL: url,
      apiKey,
      ...(wrappedFetch ? { fetch: wrappedFetch as unknown as typeof globalThis.fetch } : {}),
    })
    model = openai.chat(modelId)
  }
  const temperature = resolveTemperature(modelId, opts.temperature ?? 0.2)
  const result = await generateText({
    model,
    temperature,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          ...images.map((img) => ({
            type: 'image' as const,
            image: img.bytes,
            mediaType: img.mimeType,
          })),
        ],
      },
    ],
  })
  try {
    const usage = result.usage as
      | {
          inputTokens?: number
          outputTokens?: number
          promptTokens?: number
          completionTokens?: number
          cachedInputTokens?: number
        }
      | undefined
    if (usage) {
      recordUsage({
        provider: providerFromUrl(url),
        model: modelId,
        feature: opts.feature ?? 'extraction-vision',
        promptTokens: usage.inputTokens ?? usage.promptTokens ?? 0,
        completionTokens: usage.outputTokens ?? usage.completionTokens ?? 0,
        cachedTokens: usage.cachedInputTokens ?? 0,
      })
    }
  } catch (err) {
    console.warn('[usage] runExtractionWithImages record failed (non-fatal):', err)
  }
  return result.text
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
