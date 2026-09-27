/**
 * LLM plumbing for the main process: side-task runners (runExtraction /
 * runExtractionWithImages) and the Settings / wizard connectivity probe
 * (testBackend: GET /models, then a one-line completion against the
 * chosen model).
 */

import { BrowserWindow } from 'electron'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { generateText, type LanguageModel } from 'ai'

import { isLocalEndpoint, type Config } from '../shared/config.js'
import { getConfig, resolveApiKey, resolveBackendKey } from './config.js'
import {
  isModelUnavailableError,
  pickSideTaskModel,
  resolveTemperature,
} from '../shared/lightweight-models.js'
import { recordUsage, providerFromUrl } from './usage-host.js'
import { fetchWithTransientRetry, makeProviderFetch } from './llm-fetch.js'
import { transformOpenAIBody } from './openai-compat-body.js'
import { friendlyLlmError } from './llm-errors.js'

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
 * Model ids that failed as "unavailable" (retired / not enabled for this
 * key) this session, keyed by baseUrl. pickSideTaskModel skips them, so a
 * provider retiring our hardcoded lightweight id costs one failed call per
 * launch instead of breaking every side task until an app update.
 */
const unavailableByUrl = new Map<string, Set<string>>()
function unavailableFor(baseUrl: string): Set<string> {
  let set = unavailableByUrl.get(baseUrl)
  if (!set) unavailableByUrl.set(baseUrl, (set = new Set()))
  return set
}

/** Hosts whose models think by default — side tasks switch it off. */
function thinksByDefault(baseUrl: string): boolean {
  return (
    baseUrl.includes('moonshot.cn') ||
    baseUrl.includes('moonshot.ai') ||
    baseUrl.includes('deepseek.com') ||
    baseUrl.includes('bigmodel.cn') ||
    baseUrl.includes('volces.com') ||
    baseUrl.includes('ark.cn-beijing')
  )
}

function buildSideModel(cfg: Config, apiKey: string, modelId: string): LanguageModel {
  const url = cfg.backend.baseUrl
  if (url.includes('googleapis.com')) {
    return createGoogleGenerativeAI({ apiKey, fetch: fetchWithTransientRetry })(modelId)
  }
  const openai = createOpenAI({
    baseURL: url,
    apiKey,
    fetch: makeProviderFetch({
      disableThinking: thinksByDefault(url),
      isOpenAI: url.includes('openai.com'),
      isQwen: url.includes('dashscope.aliyuncs.com'),
    }),
  })
  // .chat() — see chat/run.ts for why we don't use the default factory.
  return openai.chat(modelId)
}

/** Side tasks are one-shot and small; anything past this is a hung socket. */
const SIDE_TASK_TIMEOUT_MS = 90_000

/**
 * Resolve the side-task model, run `invoke`, and on a "model unavailable"
 * error retry once with the next candidate (see pickSideTaskModel).
 */
async function withSideTaskModel<T>(
  needVision: boolean,
  invoke: (model: LanguageModel, modelId: string, cfg: Config) => Promise<T>,
): Promise<T> {
  const cfg = getConfig()
  const apiKey = resolveApiKey(cfg)
  if (!apiKey) throw new Error('no API key')
  const url = cfg.backend.baseUrl
  const pick = (): string =>
    pickSideTaskModel({
      baseUrl: url,
      userModel: cfg.backend.model,
      override: cfg.backend.fastModel,
      needVision,
      unavailable: unavailableFor(url),
    })
  const modelId = pick()
  try {
    return await invoke(buildSideModel(cfg, apiKey, modelId), modelId, cfg)
  } catch (err) {
    if (!isModelUnavailableError(err)) throw err
    unavailableFor(url).add(modelId)
    const next = pick()
    if (next === modelId) throw err
    console.warn(
      `[llm] side-task model "${modelId}" unavailable at ${url} — falling back to "${next}"`,
    )
    return await invoke(buildSideModel(cfg, apiKey, next), next, cfg)
  }
}

function recordSideUsage(cfg: Config, modelId: string, feature: string, usage: unknown): void {
  // Wraps every call defensively — usage shape varies slightly across
  // provider impls in Vercel AI SDK and a missing field shouldn't
  // crash the LLM path it's instrumenting.
  try {
    const u = usage as
      | {
          inputTokens?: number
          outputTokens?: number
          promptTokens?: number
          completionTokens?: number
          cachedInputTokens?: number
        }
      | undefined
    if (!u) return
    recordUsage({
      provider: providerFromUrl(cfg.backend.baseUrl),
      model: modelId,
      feature,
      promptTokens: u.inputTokens ?? u.promptTokens ?? 0,
      completionTokens: u.outputTokens ?? u.completionTokens ?? 0,
      cachedTokens: u.cachedInputTokens ?? 0,
    })
  } catch (err) {
    console.warn(`[usage] ${feature} record failed (non-fatal):`, err)
  }
}

/**
 * One-shot text generation for "side LLM tasks": reflection (fact
 * extraction), greeting line, reminder line, proactive observer,
 * notification gate, emotion classification.
 *
 * Model choice: the user's `backend.fastModel` override if set, else the
 * host's cheap lightweight tier (src/shared/lightweight-models.ts), else
 * the user's chat model — and if the provider says the picked id doesn't
 * exist, the next candidate is tried once. Picking lightweight per host
 * means every reply that triggers an emotion classifier doesn't double
 * our inference cost or latency.
 *
 * `opts.temperature` defaults to 0.2 — good for structured/JSON extraction
 * where determinism matters (reflection, notif gate, emotion classifier).
 * Creative tasks (greeting, proactive remark, reminder line, goodbye)
 * should pass 0.7+ to avoid the model producing the same line every
 * time when the input is similar.
 *
 * Throws on failure — the caller handles retries and parse failures.
 */
export async function runExtraction(
  prompt: string,
  opts: { temperature?: number; feature?: string } = {},
): Promise<string> {
  return withSideTaskModel(false, async (model, modelId, cfg) => {
    // resolveTemperature handles per-model constraints (OpenAI reasoning
    // lineup omit, Kimi pin to 0.6, everyone else free).
    const result = await generateText({
      model,
      prompt,
      temperature: resolveTemperature(modelId, opts.temperature ?? 0.2),
      abortSignal: AbortSignal.timeout(SIDE_TASK_TIMEOUT_MS),
    })
    recordSideUsage(cfg, modelId, opts.feature ?? 'extraction', result.usage)
    return result.text
  })
}

/**
 * Multimodal variant of runExtraction — same routing rules but accepts
 * one or more images alongside the text prompt. Used by the proactive
 * observer's "look at the screen and decide whether to speak" path and
 * the quick-screen button. A text-only pick is swapped for a vision-
 * capable one (the user's model if it can see, else the host's vision
 * tier).
 */
export async function runExtractionWithImages(
  prompt: string,
  images: { mimeType: string; bytes: Uint8Array }[],
  opts: { temperature?: number; feature?: string } = {},
): Promise<string> {
  return withSideTaskModel(true, async (model, modelId, cfg) => {
    const result = await generateText({
      model,
      temperature: resolveTemperature(modelId, opts.temperature ?? 0.2),
      abortSignal: AbortSignal.timeout(SIDE_TASK_TIMEOUT_MS),
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
    recordSideUsage(cfg, modelId, opts.feature ?? 'extraction-vision', result.usage)
    return result.text
  })
}

export async function testBackend(
  backendCfg: Config['backend'],
  apiKeyOverride?: string,
): Promise<LlmTestResult> {
  const apiKey = apiKeyOverride || resolveBackendKey(backendCfg)
  const url = backendCfg.baseUrl.replace(/\/$/, '')
  const fail = (err: unknown): LlmTestResult => {
    broadcastStatus('error')
    return { ok: false, error: friendlyLlmError(err, { baseUrl: url, modelId: backendCfg.model }) }
  }

  if (!apiKey) {
    const result = { ok: false, error: '未填 API key，且 .env 没有匹配的兜底' }
    broadcastStatus('error')
    return result
  }

  try {
    // Step 1: GET /models — free, proves the key + base URL.
    const res = await fetch(url + '/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      return fail({ status: res.status, message: `${res.status} ${res.statusText} ${detail.slice(0, 200)}` })
    }
    // Step 2: a one-line completion against the chosen model. /models
    // alone let retired ids and empty wallets (GLM "余额不足" once the
    // signup credit runs out) pass setup and fail on the first real chat.
    // Costs a handful of tokens. Skipped for local servers — LM Studio
    // loads models on demand and the first call can take a minute.
    if (backendCfg.model && !isLocalEndpoint(url)) {
      const isOpenAI = url.includes('openai.com')
      const body: Record<string, unknown> = {
        model: backendCfg.model,
        messages: [{ role: 'user', content: '回复 ok' }],
        ...(isOpenAI ? { max_completion_tokens: 16 } : { max_tokens: 16 }),
      }
      // Same body tweaks as real requests (thinking off where it's on by
      // default, reasoning_effort for GPT-6) so the probe fails only when
      // a real chat would.
      transformOpenAIBody(body, {
        disableThinking: thinksByDefault(url),
        isOpenAI: isOpenAI,
        isQwen: url.includes('dashscope.aliyuncs.com'),
      })
      const temperature = resolveTemperature(backendCfg.model, 0.6)
      if (temperature !== undefined && backendCfg.model.startsWith('kimi-')) body.temperature = temperature
      const probe = await fetchWithTransientRetry(url + '/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(45_000),
      })
      if (!probe.ok) {
        const detail = await probe.text().catch(() => '')
        return fail({
          status: probe.status,
          message: `${probe.status} ${probe.statusText} ${detail.slice(0, 200)}`,
        })
      }
    }
    broadcastStatus('ok')
    return { ok: true }
  } catch (err) {
    return fail(err)
  }
}
