/**
 * The fetch every LLM provider client in main goes through.
 *
 * Layers, outermost first:
 *   1. Transient-error retry — 429 / 502 / 503 / 504 / 529 are retried up
 *      to twice with a short backoff BEFORE any body is streamed, so a
 *      retry can never duplicate visible output (which is why the SDK's
 *      own `maxRetries` stays 0 in chat/run.ts). Quota / balance errors
 *      come back as 429 on some hosts (GLM code 1113) and are NOT
 *      retried — waiting doesn't refill a wallet.
 *   2. Provider body quirks (openai-compat-body.ts).
 *   3. Kimi `$web_search` round-trip (chat/kimi-search-stream.ts).
 */

import { transformOpenAIBody, needsBodyTransform, type BodyTransformFlags } from './openai-compat-body.js'
import { wrapKimiSearchResponse } from './chat/kimi-search-stream.js'

const TRANSIENT_STATUS = new Set([429, 502, 503, 504, 529])
const NOT_TRANSIENT_BODY = /余额|欠费|充值|"1113"|insufficient|quota|billing|balance/i
const MAX_RETRIES = 2

type FetchInput = Parameters<typeof globalThis.fetch>[0]
type FetchInit = Parameters<typeof globalThis.fetch>[1]

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(signal.reason ?? new Error('aborted'))
      },
      { once: true },
    )
  })
}

export async function fetchWithTransientRetry(input: FetchInput, init?: FetchInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await globalThis.fetch(input, init)
    if (attempt >= MAX_RETRIES || !TRANSIENT_STATUS.has(res.status)) return res
    const detail = await res.clone().text().catch(() => '')
    if (NOT_TRANSIENT_BODY.test(detail)) return res
    const retryAfter = Number(res.headers.get('retry-after'))
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 5000)
        : 1200 * (attempt + 1)
    console.warn(
      `[llm] ${res.status} (transient) — retry ${attempt + 1}/${MAX_RETRIES} in ${waitMs}ms: ${detail.slice(0, 120)}`,
    )
    await sleep(waitMs, init?.signal)
  }
}

export interface ProviderFetchOptions extends BodyTransformFlags {}

/** Build the fetch for one provider client. */
export function makeProviderFetch(flags: ProviderFetchOptions = {}): typeof globalThis.fetch {
  const transform = needsBodyTransform(flags)
  return (async (input: FetchInput, init?: FetchInit) => {
    let parsedBody: Record<string, unknown> | null = null
    if (transform && init && init.method === 'POST' && typeof init.body === 'string') {
      try {
        parsedBody = JSON.parse(init.body) as Record<string, unknown>
        transformOpenAIBody(parsedBody, flags)
        init = { ...init, body: JSON.stringify(parsedBody) }
      } catch {
        parsedBody = null // malformed body — send as-is
      }
    }
    const response = await fetchWithTransientRetry(input, init)
    if (flags.injectKimiSearch && parsedBody) {
      const baseInit = init
      return wrapKimiSearchResponse(response, {
        body: parsedBody,
        refetch: (body) => fetchWithTransientRetry(input, { ...baseInit, body: JSON.stringify(body) }),
      })
    }
    return response
  }) as typeof globalThis.fetch
}
