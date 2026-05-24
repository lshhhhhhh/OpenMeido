/**
 * Shared backend setup for agent smoke tests. Lets a single test script
 * run against multiple LLM providers without duplicating the model-creation
 * boilerplate.
 *
 * Usage:
 *   import { getAgentBackends } from './agent-backends.mjs'
 *   const backends = getAgentBackends()  // filters to ones that have keys
 *   for (const { label, model } of backends) {
 *     // run scenarios against `model`
 *   }
 *
 * Env-key gating means tests skip backends the user hasn't configured
 * rather than failing loudly. Per-backend tests are reported separately
 * so a GLM regression doesn't get hidden by Gemini's green.
 */
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'

/**
 * @typedef {{ label: string; model: import('ai').LanguageModel; modelName: string }} Backend
 */

/**
 * Returns the configured set of backends. Each entry has `label` for the
 * test header, `model` for streamText, and `modelName` for diagnostics.
 *
 * **Default mode (省钱)**: returns ONLY DeepSeek. Cheap, fast, supports
 * tool calling reliably — good enough to catch most regressions, while
 * costing a fraction of running Gemini / GLM / Kimi in parallel.
 *
 * **Multi-backend mode**: set `TEST_ALL_BACKENDS=1` to opt into running
 * Gemini + GLM + Kimi alongside DeepSeek for cross-provider regression
 * coverage. Use this when:
 *   - you're testing a fix for a provider-specific bug
 *   - you suspect a tool description change might break one provider
 *   - you're preparing a release and want full confidence
 *
 * @returns {Backend[]}
 */
export function getAgentBackends() {
  /** @type {Backend[]} */
  const out = []

  // DeepSeek — the default test backend. Cheap, OpenAI-compat, fast tool
  // calling. v3 doesn't support image_url content, but no smoke that uses
  // this util sends images, so that's a non-issue here.
  if (process.env.DEEPSEEK_API_KEY) {
    const name = 'deepseek-chat'
    const openai = createOpenAI({
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: process.env.DEEPSEEK_API_KEY,
    })
    out.push({
      label: `DeepSeek · ${name}`,
      model: openai.chat(name),
      modelName: name,
    })
  }

  // If we're not in multi-backend mode, bail with DeepSeek only.
  if (process.env.TEST_ALL_BACKENDS !== '1') {
    if (out.length === 0) {
      throw new Error(
        'no agent backends available — set DEEPSEEK_API_KEY in .env ' +
          '(or set TEST_ALL_BACKENDS=1 to use one of GEMINI/ZHIPU/MOONSHOT)',
      )
    }
    return out
  }

  if (process.env.GEMINI_API_KEY) {
    const name = 'gemini-2.5-flash'
    const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY })
    out.push({
      label: `Gemini · ${name}`,
      model: google(name),
      modelName: name,
    })
  }

  if (process.env.ZHIPU_API_KEY) {
    // GLM 4.6 thinking model fits OpenMeido's default user. We use the
    // OpenAI-compat endpoint via @ai-sdk/openai's .chat() — Vercel AI SDK
    // works against bigmodel.cn this way and tool calls are supported.
    // Use a non-thinking variant where available; the thinking variant
    // adds significant latency and hits our test stepCountIs budget more
    // often. glm-4.6-flash is the free tier and what most users hit.
    // glm-5.1 is the current perf-tier default (text-only flagship) and
    // passes the fake-mail-agent suite reliably; glm-4.6 was flaky.
    const name = process.env.GLM_TEST_MODEL || 'glm-5.1'
    const openai = createOpenAI({
      baseURL: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: process.env.ZHIPU_API_KEY,
    })
    out.push({
      label: `GLM · ${name}`,
      model: openai.chat(name),
      modelName: name,
    })
  }

  if (process.env.MOONSHOT_API_KEY) {
    // Moonshot Kimi K2 series — OpenAI-compat, tool calls supported.
    // Two regional endpoints with SEPARATE auth: api.moonshot.cn (mainland)
    // vs api.moonshot.ai (international). The key only works on the org it
    // was issued for — testing against the wrong endpoint returns 401
    // "Invalid Authentication". Default to .ai; set KIMI_BASE_URL to
    // override (e.g. for mainland-only accounts).
    // Default to kimi-k2.6 — it's on BOTH the .cn and .ai endpoints, while
    // kimi-k2-turbo-preview is .cn-only and would 404 on international keys.
    //
    // One Kimi-specific quirk patched via wrapped fetch: kimi-k2.6 defaults
    // to thinking ON, which requires every replayed assistant tool-call
    // message to carry `reasoning_content`. We don't capture that — disable
    // thinking on the wire. (Temperature is already 0.6 globally now, so
    // no override needed for Kimi's 0.6-only constraint.)
    const name = process.env.KIMI_TEST_MODEL || 'kimi-k2.6'
    const baseURL = process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1'
    const wrappedFetch = async (url, init) => {
      if (init && init.method === 'POST' && typeof init.body === 'string') {
        try {
          const body = JSON.parse(init.body)
          body.thinking = { type: 'disabled' }
          init = { ...init, body: JSON.stringify(body) }
        } catch {
          /* malformed body — fall through */
        }
      }
      return globalThis.fetch(url, init)
    }
    const openai = createOpenAI({
      baseURL,
      apiKey: process.env.MOONSHOT_API_KEY,
      fetch: wrappedFetch,
    })
    out.push({
      label: `Kimi · ${name}`,
      model: openai.chat(name),
      modelName: name,
    })
  }

  if (out.length === 0) {
    throw new Error(
      'TEST_ALL_BACKENDS=1 was set but no backends configured — ' +
        'need at least one of DEEPSEEK_API_KEY / GEMINI_API_KEY / ZHIPU_API_KEY / MOONSHOT_API_KEY',
    )
  }
  return out
}
