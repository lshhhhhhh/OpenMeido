/**
 * Three-tier model policy per provider:
 *
 *   fast   — cheap text-only tier for "side LLM tasks": emotion classifier,
 *            greeting / goodbye / reminder lines, proactive observer gate,
 *            notification gate, L3 reflection.
 *   perf   — best text-quality tier for regular chat (no images attached).
 *            What `chat.ts` should use as its default `cfg.backend.model`.
 *   vision — vision-capable tier for chat turns with image attachments
 *            (screenshots, pasted images). Most modern flagships are
 *            multimodal, so `vision === perf` for most hosts. The split
 *            matters for providers where the flagship is text-only or
 *            where the vision tier is more expensive.
 *
 * Lives in shared/ so both the main process (which actually invokes
 * model calls) and the renderer (which surfaces model info in Settings)
 * can read the mapping.
 *
 * Each getter returns null when there's no canonical tier for the host
 * (e.g. LM Studio — user's loaded model is the only choice). Callers
 * fall back to whatever the user has manually configured.
 */

interface ModelTiers {
  fast: string
  perf: string
  /** null when the provider has no vision-capable tier at all. Callers
   *  should fall back to `perf` and accept that images won't be processed. */
  vision: string | null
}

const TIERS_BY_HOST: { match: (url: string) => boolean; tiers: ModelTiers }[] = [
  {
    match: (u) => u.includes('openai.com'),
    tiers: { fast: 'gpt-5.4-mini', perf: 'gpt-5.5', vision: 'gpt-5.5' },
  },
  {
    // Gemini 3.5 Flash dropped 2026-05-20 — cheaper/faster than 2.5 Flash
    // and still multimodal. Promoted to the fast tier.
    match: (u) => u.includes('googleapis.com'),
    tiers: {
      fast: 'gemini-3.5-flash',
      perf: 'gemini-3.1-pro-preview',
      vision: 'gemini-3.1-pro-preview',
    },
  },
  {
    match: (u) => u.includes('anthropic.com'),
    tiers: { fast: 'claude-haiku-4-5', perf: 'claude-opus-4-7', vision: 'claude-opus-4-7' },
  },
  {
    // GLM 5.1 is text-only flagship — chat in mixed contexts is fine but
    // can't take images. For image turns we fall back to glm-4.6v (the
    // dedicated vision variant of 4.6).
    match: (u) => u.includes('bigmodel.cn'),
    tiers: { fast: 'glm-4.6v-flash', perf: 'glm-5.1', vision: 'glm-4.6v' },
  },
  {
    // DeepSeek V4 chat-completions endpoint is text-only despite some
    // community articles claiming "V4 vision". Sending image_url returns
    // a JSON-deserialize error from their parser. vision: null = no
    // vision support; callers fall back to the perf text model and accept
    // that images won't be processed.
    match: (u) => u.includes('deepseek.com'),
    tiers: { fast: 'deepseek-v4-flash', perf: 'deepseek-v4-pro', vision: null },
  },
  {
    match: (u) => u.includes('dashscope.aliyuncs.com'),
    tiers: { fast: 'qwen3-vl-flash', perf: 'qwen3-vl-plus', vision: 'qwen3-vl-plus' },
  },
  {
    match: (u) => u.includes('volces.com') || u.includes('ark.cn-beijing'),
    tiers: {
      fast: 'doubao-1-5-vision-pro-32k-250115',
      perf: 'doubao-1-5-vision-pro-250328',
      vision: 'doubao-1-5-vision-pro-250328',
    },
  },
  {
    // Kimi 国内 has the full lineup including kimi-k2-turbo-preview
    // (text-only, cheap/fast). kimi-k2.6 is multimodal flagship.
    match: (u) => u.includes('moonshot.cn'),
    tiers: { fast: 'kimi-k2-turbo-preview', perf: 'kimi-k2.6', vision: 'kimi-k2.6' },
  },
  {
    // Kimi 国际 doesn't expose the turbo-preview tier; smallest available
    // is kimi-k2.5. Vision uses kimi-k2.6.
    match: (u) => u.includes('moonshot.ai'),
    tiers: { fast: 'kimi-k2.5', perf: 'kimi-k2.6', vision: 'kimi-k2.6' },
  },
]

function tiersFor(baseUrl: string): ModelTiers | null {
  for (const entry of TIERS_BY_HOST) {
    if (entry.match(baseUrl)) return entry.tiers
  }
  return null
}

/** Fast text-only model for side LLM tasks. Null = no canonical tier
 *  (e.g. LM Studio); caller falls back to the user's chat model. */
export function lightweightModel(baseUrl: string): string | null {
  return tiersFor(baseUrl)?.fast ?? null
}

/** Best text-quality model for regular chat (no images). Null = caller
 *  should fall back to the user's manually-configured cfg.backend.model. */
export function performanceModel(baseUrl: string): string | null {
  return tiersFor(baseUrl)?.perf ?? null
}

/** Vision-capable model for chat turns with image attachments. Null = the
 *  provider has no multimodal tier; caller should fall back to perf and
 *  warn the user that images won't be processed. */
export function visionModel(baseUrl: string): string | null {
  return tiersFor(baseUrl)?.vision ?? null
}

/**
 * Per-model temperature constraint. Different model families have
 * different rules:
 *
 *   - OpenAI gpt-5 reasoning lineup: locked to default 1, REJECTS any
 *     explicit setting. Caller must OMIT temperature from the request.
 *   - Kimi (Moonshot k2 lineup): clamped to exactly 0.6, rejects any
 *     other value. Caller must PIN to 0.6.
 *   - Everyone else: free — caller's desired value is fine.
 *
 * Returning a tagged result instead of a bare number lets the omit case
 * be distinct from "use 0" without sentinel magic.
 */
export type TemperatureConstraint =
  | { mode: 'omit' } // do not send temperature at all
  | { mode: 'pin'; value: number } // must use exactly this value
  | { mode: 'free' } // caller's choice

export function temperatureConstraint(modelId: string): TemperatureConstraint {
  if (modelId.startsWith('gpt-5')) return { mode: 'omit' }
  if (modelId.startsWith('kimi-')) return { mode: 'pin', value: 0.6 }
  return { mode: 'free' }
}

/**
 * Resolve a request's temperature: honors model-specific constraints,
 * falls back to `desired` when the model is free. Returns undefined
 * when the model requires omission (caller should NOT pass the field).
 */
export function resolveTemperature(modelId: string, desired: number): number | undefined {
  const c = temperatureConstraint(modelId)
  if (c.mode === 'omit') return undefined
  if (c.mode === 'pin') return c.value
  return desired
}
