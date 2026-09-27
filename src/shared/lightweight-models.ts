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
  /** Model ids on this host known to reject or misread images. Anything
   *  not matched is assumed multimodal (optimistic — unknown/custom ids
   *  get to try). */
  textOnly?: RegExp
}

// Verified 2026-09 against each provider's GET /models plus a 1-token probe
// (image probes used a solid-red PNG). Provider lineups churn every few
// months — when one retires an id, side tasks fall back to the user's own
// model (see isModelUnavailableError) and a config migration remaps the
// saved id (shared/config-migrations.ts → migrateRetiredModels).
const TIERS_BY_HOST: { match: (url: string) => boolean; tiers: ModelTiers }[] = [
  {
    // GPT-6 (2026-09): luna $0.10/$0.50, sol $2/$10 per 1M tokens — both
    // cheaper than the gpt-5.4-mini / gpt-5.5 they replace, both read the
    // probe image. On /chat/completions they only take function tools
    // with reasoning_effort 'none' (openai-compat-body.ts sets it).
    match: (u) => u.includes('openai.com'),
    tiers: { fast: 'gpt-6-luna', perf: 'gpt-6-sol', vision: 'gpt-6-sol', textOnly: /^o3-mini/ },
  },
  {
    // Gemini (2026-09): 3.8-flash ($0.75/$3.75) for chat, 3.5-flash-lite
    // ($0.30/$2.50) for side tasks — both on the free tier, both tested
    // for image + tool calls. The previous chat default,
    // gemini-3.1-pro-preview, has NO free tier, so the "有免费额度" preset
    // didn't actually work on a free key. Still offered as a suggestion.
    match: (u) => u.includes('googleapis.com'),
    tiers: {
      fast: 'gemini-3.5-flash-lite',
      perf: 'gemini-3.8-flash',
      vision: 'gemini-3.8-flash',
    },
  },
  {
    // Current generation: Haiku 4.5 / Sonnet 5 ($2/$10) / Opus 5.
    match: (u) => u.includes('anthropic.com'),
    tiers: { fast: 'claude-haiku-4-5', perf: 'claude-sonnet-5', vision: 'claude-sonnet-5' },
  },
  {
    // GLM 5.x text flagships reject image content with HTTP 400
    // ("messages.content.type 参数非法，取值范围 ['text']"). Vision ids all
    // carry a `v` (glm-4.6v, glm-4.6v-flash, glm-5v-turbo, glm-4.1v-…)
    // except glm-5.3-flash(x), which is natively multimodal.
    match: (u) => u.includes('bigmodel.cn'),
    tiers: {
      fast: 'glm-4.6v-flash',
      perf: 'glm-5.1',
      vision: 'glm-4.6v',
      textOnly: /^glm-(?!5\.3-flash)[^v]*$/i,
    },
  },
  {
    // DeepSeek (2026-07 lineup): `deepseek-flash` is multimodal (reads the
    // probe image correctly); `deepseek-v4-pro` ACCEPTS image_url but
    // answers as if blind, so treat it as text-only. The old
    // `deepseek-v4-flash` / `deepseek-chat` names are still aliased to
    // flash server-side.
    match: (u) => u.includes('deepseek.com'),
    tiers: {
      fast: 'deepseek-flash',
      perf: 'deepseek-v4-pro',
      vision: 'deepseek-flash',
      textOnly: /^deepseek-(v4-pro|reasoner)/,
    },
  },
  {
    // Qwen 3.7 / 3.8 are natively multimodal (the separate -vl line is no
    // longer needed); both tested for image + tool calls 2026-09.
    match: (u) => u.includes('dashscope.aliyuncs.com'),
    tiers: { fast: 'qwen3.8-flash', perf: 'qwen3.7-plus', vision: 'qwen3.7-plus' },
  },
  {
    // Doubao Seed 2.1 (Ark model list 2026-09): multimodal + tool calls,
    // thinking on by default (switched off via thinking.type=disabled).
    // The doubao-1-5-vision-pro ids we used to ship are gone from Ark.
    // Ids carry a date suffix and Ark rotates them — keep
    // config-migrations.ts in step when these move.
    match: (u) => u.includes('volces.com') || u.includes('ark.cn-beijing'),
    tiers: {
      fast: 'doubao-seed-2-1-lite-260915',
      perf: 'doubao-seed-2-1-pro-260915',
      vision: 'doubao-seed-2-1-pro-260915',
    },
  },
  {
    // Kimi retired the whole k2-preview line (k2-turbo-preview,
    // k2-0905-preview, k2-thinking*) on 2026-05-25 and kimi-k2.5 plus all
    // moonshot-v1-* on 2026-08-31. What's left: kimi-k2.6 (multimodal,
    // thinking disabled via body flag), kimi-k3 (flagship, pricier), and
    // the text-only kimi-k2.7-code line. No cheaper chat tier exists, so
    // side tasks use k2.6 as well. Same lineup on both endpoints.
    match: (u) => u.includes('moonshot.cn') || u.includes('moonshot.ai'),
    tiers: {
      fast: 'kimi-k2.6',
      perf: 'kimi-k2.6',
      vision: 'kimi-k2.6',
      textOnly: /^kimi-k2\.7-code/,
    },
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

/** False only for ids we KNOW can't see images on this host. Unknown ids
 *  (custom fine-tunes, LM Studio, newer releases) are assumed capable. */
export function supportsVision(baseUrl: string, modelId: string): boolean {
  const re = tiersFor(baseUrl)?.textOnly
  return !(re && re.test(modelId))
}

/**
 * Which model a side task (classifier / greeting / proactive / reflection…)
 * should call. Order: the user's explicit override → our lightweight tier
 * (unless it already failed as unavailable this session) → the user's chat
 * model. With `needVision`, a text-only pick is swapped for the host's
 * vision tier, or the user's model when that can see.
 *
 * The chat-model fallback is what keeps side tasks alive when a provider
 * retires the id we hardcoded — the user can always fix their own model in
 * Settings, but never used to be able to touch this table.
 */
export function pickSideTaskModel(opts: {
  baseUrl: string
  userModel: string
  override?: string
  needVision?: boolean
  unavailable?: ReadonlySet<string>
}): string {
  const { baseUrl, userModel, needVision } = opts
  const override = opts.override?.trim()
  const lw = lightweightModel(baseUrl)
  let pick = override || (lw && !opts.unavailable?.has(lw) ? lw : '') || userModel
  if (needVision && !supportsVision(baseUrl, pick)) {
    const vis = visionModel(baseUrl)
    if (supportsVision(baseUrl, userModel)) pick = userModel
    else if (vis && !opts.unavailable?.has(vis)) pick = vis
  }
  return pick
}

/**
 * True when a provider error means "this model id doesn't exist / was
 * retired / isn't enabled for this key" — i.e. retrying with a different
 * model could work, retrying the same one never will. Matches on the
 * status plus the phrasings seen from OpenAI-compat hosts (OpenAI, Kimi,
 * GLM, DeepSeek, DashScope, Ark) and Gemini.
 */
export function isModelUnavailableError(err: unknown): boolean {
  const e = err as { statusCode?: number; status?: number; message?: string; responseBody?: string }
  const text = `${e?.message ?? ''} ${e?.responseBody ?? ''}`
  if (/model[_ ]not[_ ](found|exists?)|does not exist|not[_ ]found.*model|model.*not[_ ]found/i.test(text))
    return true
  if (/(invalid|unknown|unsupported|not supported|deprecated|retired|discontinued).{0,20}model|model.{0,40}(deprecated|retired|discontinued|no longer)/i.test(text))
    return true
  if (/模型不存在|模型.{0,6}(下线|停用|不可用)|无权访问.{0,6}模型/.test(text)) return true
  const status = e?.statusCode ?? e?.status
  return status === 404 && /model/i.test(text)
}

/**
 * Per-model temperature constraint. Different model families have
 * different rules:
 *
 *   - OpenAI reasoning lineup (gpt-5.x, gpt-6-*, o-series) and Claude
 *     4.7+ / Sonnet 5 / Opus 5: REJECT any explicit setting. Caller must
 *     OMIT temperature from the request.
 *   - Kimi (k2.6 and k3): clamped to exactly 0.6, rejects any other
 *     value. Caller must PIN to 0.6.
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
  if (/^(gpt-5|gpt-6|o\d)/.test(modelId)) return { mode: 'omit' }
  // Claude 4.7+ / Sonnet 5 / Opus 5 / Fable reject sampling params (400).
  if (/^claude-(opus-4-[78]|opus-5|sonnet-5|fable|mythos)/.test(modelId)) return { mode: 'omit' }
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
