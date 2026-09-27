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
  /** Kimi web search: inject `$web_search` builtin function tool when
   *  searchEnabled. chat/kimi-search-stream.ts hides the builtin
   *  tool_call from Vercel AI SDK and performs the echo round-trip
   *  Moonshot requires before it streams the grounded answer. */
  injectKimiSearch?: boolean
  /** DeepSeek reasoner — when replaying an assistant tool-call message
   *  back to the API, `reasoning_content` is required. Vercel AI SDK
   *  doesn't capture it, so we fill an empty string. */
  isDeepSeek?: boolean
  /** Hosts whose models think by default (Kimi, DeepSeek, GLM, Doubao)
   *  when thinking isn't wanted — side tasks (one-line outputs) and
   *  Doubao chat. All four accept `thinking: {type: 'disabled'}`, except
   *  the always-thinking ids in ALWAYS_THINKS. */
  disableThinking?: boolean
  /** api.openai.com — GPT-6 on /chat/completions rejects function tools
   *  unless `reasoning_effort` is 'none' (verified 2026-09), so it's set
   *  for every gpt-6 request that doesn't pick one. */
  isOpenAI?: boolean
  /** DashScope (Qwen). Qwen 3.5+ are hybrid thinkers that think by
   *  default in streaming mode; with thinking on, qwen3.7-plus sometimes
   *  reasoned about a tool and then never called it. Its switch is the
   *  non-standard `enable_thinking`, not `thinking`. */
  isQwen?: boolean
}

/** Models that always think and 400 on `thinking: {type: 'disabled'}`
 *  ("该模型始终思考，不支持关闭思考"). */
const ALWAYS_THINKS = /^glm-5\.3-flash/

interface OpenAIRequestBody {
  model?: string
  reasoning_effort?: string
  enable_thinking?: boolean
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
  if (flags.injectKimiSearch) {
    // Moonshot's `$web_search` builtin function. The response-side
    // wrapper (chat/kimi-search-stream.ts) strips the builtin tool_call
    // and does the tool-result echo round-trip.
    const entry = { type: 'builtin_function', function: { name: '$web_search' } }
    if (Array.isArray(body.tools)) body.tools.push(entry)
    else body.tools = [entry]
  }
  const model = typeof body.model === 'string' ? body.model : ''
  if ((flags.isKimi || flags.disableThinking) && !ALWAYS_THINKS.test(model)) {
    body.thinking = { type: 'disabled' }
  }
  if (flags.isOpenAI && /^gpt-6/.test(model) && body.reasoning_effort == null) {
    body.reasoning_effort = 'none'
  }
  if (flags.isQwen && body.enable_thinking == null) {
    body.enable_thinking = false
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
  return Boolean(
    flags.injectGlmSearch ||
      flags.injectKimiSearch ||
      flags.isKimi ||
      flags.isDeepSeek ||
      flags.disableThinking ||
      flags.isOpenAI ||
      flags.isQwen,
  )
}
