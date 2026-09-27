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

/** fetch that forces `thinking: {type: 'disabled'}` on every POST body —
 *  Kimi / DeepSeek / GLM think by default, which costs latency and makes
 *  replayed tool-call turns demand reasoning_content. */
function noThinkingFetch(url, init) {
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

/**
 * OpenRouter slugs mirroring what the app uses per provider by default
 * (lightweight-models.ts perf tiers). One OPENROUTER_API_KEY covers them
 * all — good for MODEL behaviour (persona, tool-calling reliability).
 * It does NOT exercise provider-API quirks the app handles itself (Kimi
 * $web_search round-trip, GLM web_search inject + error codes, per-host
 * model retirement, Kimi's temperature pin): those still need the real
 * endpoints. Override with OPENROUTER_TEST_MODELS=slug1,slug2.
 */
const OPENROUTER_DEFAULT_MODELS = [
  'deepseek/deepseek-v4-pro',
  'moonshotai/kimi-k2.6',
  'z-ai/glm-5.1',
  'google/gemini-3.8-flash',
  'bytedance-seed/seed-2-1-turbo',
]

/** @returns {Backend[]} */
function openRouterBackends() {
  if (!process.env.OPENROUTER_API_KEY) return []
  const slugs = (process.env.OPENROUTER_TEST_MODELS || OPENROUTER_DEFAULT_MODELS.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const openai = createOpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
    headers: { 'X-Title': 'OpenMeido smoke tests' },
  })
  return slugs.map((slug) => ({
    label: `OpenRouter · ${slug}`,
    model: openai.chat(slug),
    modelName: slug,
  }))
}

/**
 * Returns the configured set of backends. Each entry has `label` for the
 * test header, `model` for streamText, and `modelName` for diagnostics.
 *
 * **Default mode (省钱)**: returns ONLY DeepSeek. Cheap, fast, supports
 * tool calling reliably — good enough to catch most regressions, while
 * costing a fraction of running Gemini / GLM / Kimi in parallel. Without
 * a DEEPSEEK_API_KEY, falls back to DeepSeek via OpenRouter.
 *
 * **OpenRouter mode**: `TEST_OPENROUTER=1` runs every model in
 * OPENROUTER_DEFAULT_MODELS (or OPENROUTER_TEST_MODELS) through one
 * OpenRouter key — no per-provider accounts needed.
 *
 * **Multi-backend mode**: `TEST_ALL_BACKENDS=1` runs every provider you
 * have a direct key for (DeepSeek / Gemini / GLM / Kimi), plus the
 * OpenRouter set if OPENROUTER_API_KEY is present. Use this when:
 *   - you're testing a fix for a provider-specific bug
 *   - you suspect a tool description change might break one provider
 *   - you're preparing a release and want full confidence
 *
 * @returns {Backend[]}
 */
export function getAgentBackends() {
  if (process.env.TEST_OPENROUTER === '1') {
    const or = openRouterBackends()
    if (or.length === 0) throw new Error('TEST_OPENROUTER=1 needs OPENROUTER_API_KEY in .env')
    return or
  }

  /** @type {Backend[]} */
  const out = []

  // DeepSeek — the default test backend. Cheap, OpenAI-compat, fast tool
  // calling. `deepseek-flash` with thinking off behaves like the old
  // `deepseek-chat` alias (which DeepSeek is retiring).
  if (process.env.DEEPSEEK_API_KEY) {
    const name = 'deepseek-flash'
    const openai = createOpenAI({
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: process.env.DEEPSEEK_API_KEY,
      fetch: noThinkingFetch,
    })
    out.push({
      label: `DeepSeek · ${name}`,
      model: openai.chat(name),
      modelName: name,
    })
  }

  // If we're not in multi-backend mode, bail with DeepSeek only.
  if (process.env.TEST_ALL_BACKENDS !== '1') {
    if (out.length === 0 && process.env.OPENROUTER_API_KEY) {
      const [ds] = openRouterBackends().filter((b) => b.modelName.startsWith('deepseek/'))
      if (ds) return [ds]
    }
    if (out.length === 0) {
      throw new Error(
        'no agent backends available — set DEEPSEEK_API_KEY (or OPENROUTER_API_KEY) in .env ' +
          '(or set TEST_ALL_BACKENDS=1 to use one of GEMINI/ZHIPU/MOONSHOT)',
      )
    }
    return out
  }

  if (process.env.GEMINI_API_KEY) {
    const name = process.env.GEMINI_TEST_MODEL || 'gemini-3.8-flash'
    const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY })
    out.push({
      label: `Gemini · ${name}`,
      model: google(name),
      modelName: name,
    })
  }

  if (process.env.ZHIPU_API_KEY) {
    // glm-5.1 is the current perf-tier default (text-only flagship, paid)
    // and passes the fake-mail-agent suite reliably. For a zero-balance
    // account use GLM_TEST_MODEL=glm-4.6v-flash (free, but often returns
    // 1305 "访问量过大" under load).
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
    // Moonshot Kimi — OpenAI-compat, tool calls supported. Two regional
    // endpoints with SEPARATE auth: api.moonshot.cn (mainland) vs
    // api.moonshot.ai (international). The key only works on the org it
    // was issued for — the wrong endpoint returns 401 "Invalid
    // Authentication". Default to .ai; set KIMI_BASE_URL to override.
    // kimi-k2.6 is the only chat model left on both after the 2026
    // retirements (plus the pricier kimi-k3). Temperature must be 0.6.
    const name = process.env.KIMI_TEST_MODEL || 'kimi-k2.6'
    const baseURL = process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1'
    const openai = createOpenAI({
      baseURL,
      apiKey: process.env.MOONSHOT_API_KEY,
      fetch: noThinkingFetch,
    })
    out.push({
      label: `Kimi · ${name}`,
      model: openai.chat(name),
      modelName: name,
    })
  }

  out.push(...openRouterBackends())

  if (out.length === 0) {
    throw new Error(
      'TEST_ALL_BACKENDS=1 was set but no backends configured — ' +
        'need at least one of DEEPSEEK_API_KEY / GEMINI_API_KEY / ZHIPU_API_KEY / MOONSHOT_API_KEY / OPENROUTER_API_KEY',
    )
  }
  return out
}
