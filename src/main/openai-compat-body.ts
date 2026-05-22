/**
 * Provider-specific quirks for the OpenAI-compatible POST body.
 *
 * Some backends accept the standard OpenAI request shape only with
 * additional fields or with extra entries inside `tools` / `messages`.
 * Rather than scattering that logic inside an inline fetch wrapper, the
 * mutation rules live here as a pure function — easier to unit-test
 * and easier to extend when the next provider has its own quirk.
 *
 * Detection (URL / model substring matching) is intentionally left to
 * the caller; this module only knows "given these flags, mutate the
 * body this way".
 */

export interface BodyTransformFlags {
  /** GLM (bigmodel.cn) supports a non-standard `web_search` tool; we
   *  inject it into the `tools` array when web search is enabled. */
  injectGlmSearch?: boolean
  /** Kimi (Moonshot) — kimi-k2.6 defaults thinking ON and then demands
   *  `reasoning_content` on every replayed assistant tool-call message.
   *  Force-disable to avoid the 400. */
  isKimi?: boolean
  /** DeepSeek reasoner — when replaying an assistant tool-call message
   *  back to the API, `reasoning_content` is required. Vercel AI SDK
   *  doesn't capture it, so we fill an empty string. */
  isDeepSeek?: boolean
}

interface OpenAIRequestBody {
  tools?: unknown[]
  thinking?: { type: 'enabled' | 'disabled' }
  messages?: Array<{
    role: string
    tool_calls?: unknown
    reasoning_content?: string
  }>
}

/**
 * Apply the configured body mutations in place and return the same
 * object. The function takes a parsed body so callers can validate /
 * fall through cheaply when the raw body isn't valid JSON.
 */
export function transformOpenAIBody(
  body: OpenAIRequestBody,
  flags: BodyTransformFlags,
): OpenAIRequestBody {
  if (flags.injectGlmSearch) {
    const entry = { type: 'web_search', web_search: { enable: true } }
    if (Array.isArray(body.tools)) body.tools.push(entry)
    else body.tools = [entry]
  }
  if (flags.isKimi) {
    body.thinking = { type: 'disabled' }
  }
  if (flags.isDeepSeek && Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (
        msg.role === 'assistant' &&
        msg.tool_calls &&
        msg.reasoning_content === undefined
      ) {
        msg.reasoning_content = ''
      }
    }
  }
  return body
}

/** True iff any flag is set — caller can skip wrapping fetch when false. */
export function needsBodyTransform(flags: BodyTransformFlags): boolean {
  return Boolean(flags.injectGlmSearch || flags.isKimi || flags.isDeepSeek)
}
