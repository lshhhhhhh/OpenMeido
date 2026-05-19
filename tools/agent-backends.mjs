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
 * @returns {Backend[]}
 */
export function getAgentBackends() {
  /** @type {Backend[]} */
  const out = []

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
    const name = process.env.GLM_TEST_MODEL || 'glm-4.6'
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

  if (out.length === 0) {
    throw new Error(
      'no agent backends available — set GEMINI_API_KEY and/or ZHIPU_API_KEY in .env',
    )
  }
  return out
}
