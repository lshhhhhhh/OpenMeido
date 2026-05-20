/**
 * Shared backend preset table — used by both the Settings AI tab and the
 * first-run SetupWizard. Each entry carries:
 *   - the OpenAI-compatible base URL we POST to
 *   - a deeplink that opens the provider's API-key page in the user's browser
 *   - the env var name main falls back to (so .env can fill the key for devs)
 *   - a short hint shown next to the signup link (free tier, China-only, etc.)
 *
 * Lived inside Settings.tsx originally; lifted to its own module so the wizard
 * doesn't have to depend on the (much larger) Settings UI file.
 */

export interface BackendPreset {
  label: string
  url: string
  signupUrl: string
  /** Empty string for local / no-auth endpoints (e.g. LM Studio). */
  envVar: string
  note?: string
}

export const BASE_URL_PRESETS: BackendPreset[] = [
  {
    label: 'OpenAI',
    url: 'https://api.openai.com/v1',
    signupUrl: 'https://platform.openai.com/api-keys',
    envVar: 'OPENAI_API_KEY',
  },
  {
    label: 'Gemini (OpenAI 兼容)',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    signupUrl: 'https://aistudio.google.com/apikey',
    envVar: 'GEMINI_API_KEY',
    note: '有免费额度',
  },
  {
    label: '智谱 GLM',
    url: 'https://open.bigmodel.cn/api/paas/v4',
    signupUrl: 'https://www.bigmodel.cn/usercenter/proj-mgmt/apikeys',
    envVar: 'ZHIPU_API_KEY',
    note: 'glm-4.6v-flash 免费',
  },
  {
    label: 'Kimi 月之暗面 (国内)',
    url: 'https://api.moonshot.cn/v1',
    signupUrl: 'https://platform.kimi.com/console/api-keys',
    envVar: 'MOONSHOT_API_KEY',
    note: '性能强，国内直连',
  },
  {
    label: 'Kimi (国际)',
    url: 'https://api.moonshot.ai/v1',
    signupUrl: 'https://platform.kimi.ai/',
    envVar: 'MOONSHOT_API_KEY',
    note: '性能强，需充值',
  },
  {
    label: 'DeepSeek',
    url: 'https://api.deepseek.com/v1',
    signupUrl: 'https://platform.deepseek.com/api_keys',
    envVar: 'DEEPSEEK_API_KEY',
    note: 'V4 价格屠夫',
  },
  {
    label: '通义千问 Qwen',
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    signupUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    envVar: 'DASHSCOPE_API_KEY',
    note: '新用户送 token',
  },
  {
    label: '豆包 Doubao',
    url: 'https://ark.cn-beijing.volces.com/api/v3',
    signupUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    envVar: 'ARK_API_KEY',
    note: '需国内手机号',
  },
  {
    label: 'LM Studio (本地)',
    url: 'http://127.0.0.1:1234/v1',
    signupUrl: 'https://lmstudio.ai/',
    envVar: '',
    note: '本地跑，无需 key',
  },
]

export function findPreset(url: string): BackendPreset | undefined {
  return BASE_URL_PRESETS.find((p) => p.url === url)
}

/**
 * Suggested multimodal-capable model ids per provider, three per family —
 * cheap / balanced / flagship. ALL entries support image input (OpenMeido
 * needs vision for screenshot perception), verified against provider docs
 * 2026-05.
 */
export const MODEL_SUGGESTIONS_BY_HOST: {
  match: (url: string) => boolean
  models: string[]
}[] = [
  {
    match: (url) => url.includes('openai.com'),
    models: ['gpt-5.4-mini', 'gpt-5.5', 'gpt-5.5-pro'],
  },
  {
    match: (url) => url.includes('googleapis.com'),
    models: ['gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-3.1-pro-preview'],
  },
  {
    match: (url) => url.includes('anthropic.com'),
    models: ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-7'],
  },
  {
    match: (url) => url.includes('bigmodel.cn'),
    // glm-4.6v-flash (free, fast, vision) → glm-4.6v (vision flagship) →
    // glm-5.1 (text-only newest flagship; only safe when no images in
    // the turn).
    models: ['glm-4.6v-flash', 'glm-4.6v', 'glm-5.1'],
  },
  {
    // DeepSeek V4 — chat completions endpoint is TEXT-ONLY despite some
    // community articles claiming "V4 vision". Sending `image_url` content
    // returns a JSON-deserialize error from their parser. For screenshots
    // switch backends (GLM / Gemini / Qwen all work).
    // Legacy `deepseek-chat` / `deepseek-reasoner` aliases retire 2026-07-24.
    match: (url) => url.includes('deepseek.com'),
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  },
  {
    match: (url) => url.includes('dashscope.aliyuncs.com'),
    models: ['qwen3-vl-plus', 'qwen3-vl-flash'],
  },
  {
    match: (url) => url.includes('volces.com') || url.includes('ark.cn-beijing'),
    models: [
      'doubao-1-5-vision-pro-250328',
      'doubao-1-5-vision-pro-32k-250115',
    ],
  },
  {
    // Moonshot Kimi — mainland (api.moonshot.cn). Full K2 lineup including
    // the cheap/fast preview tiers. OpenMeido leads with kimi-k2.6 (the
    // only multimodal flagship); turbo-preview and 0905-preview are
    // text-only fallbacks for users who don't need vision.
    // Verified against platform.kimi.com/docs/models.md 2026-05.
    match: (url) => url.includes('moonshot.cn'),
    models: ['kimi-k2.6', 'kimi-k2-0905-preview', 'kimi-k2-turbo-preview'],
  },
  {
    // Moonshot Kimi — international (api.moonshot.ai). Narrower model list:
    // verified via GET /v1/models 2026-05 → only kimi-k2.6, kimi-k2.5,
    // moonshot-v1-* are available. NO kimi-k2-turbo-preview / k2-thinking
    // / 0905-preview on this endpoint. Keys from platform.kimi.ai are NOT
    // interchangeable with platform.kimi.com keys.
    match: (url) => url.includes('moonshot.ai'),
    models: ['kimi-k2.6', 'kimi-k2.5', 'moonshot-v1-128k-vision-preview'],
  },
  {
    match: (url) => url.includes('127.0.0.1') || url.includes('localhost'),
    models: ['qwen/qwen3-vl-30b'],
  },
]

export function suggestedModels(baseUrl: string): string[] {
  for (const entry of MODEL_SUGGESTIONS_BY_HOST) {
    if (entry.match(baseUrl)) return entry.models
  }
  return []
}
