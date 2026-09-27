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
 * needs vision for screenshot perception) unless noted, verified against
 * each provider's GET /models 2026-09.
 */
export const MODEL_SUGGESTIONS_BY_HOST: {
  match: (url: string) => boolean
  models: string[]
}[] = [
  {
    match: (url) => url.includes('openai.com'),
    models: ['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra'],
  },
  {
    match: (url) => url.includes('googleapis.com'),
    // 3.8-flash + 3.5-flash-lite have a free tier; 3.1-pro-preview doesn't.
    models: ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-pro-preview'],
  },
  {
    match: (url) => url.includes('anthropic.com'),
    models: ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5'],
  },
  {
    match: (url) => url.includes('bigmodel.cn'),
    // glm-4.6v-flash (free, vision) → glm-5.1 (default; text-only, image
    // turns auto-switch to glm-4.6v) → glm-5.3-flash (2026-08, natively
    // multimodal, ~1/10 of glm-5.3's price, always thinks) → glm-5.3
    // (newest text flagship).
    models: ['glm-4.6v-flash', 'glm-5.1', 'glm-5.3-flash', 'glm-5.3'],
  },
  {
    // DeepSeek (2026-07 lineup): deepseek-flash is multimodal and cheap;
    // deepseek-v4-pro is text-only (image turns auto-switch to flash —
    // see lightweight-models.ts). The old deepseek-v4-flash / deepseek-chat
    // names are aliases of flash.
    match: (url) => url.includes('deepseek.com'),
    models: ['deepseek-v4-pro', 'deepseek-flash'],
  },
  {
    match: (url) => url.includes('dashscope.aliyuncs.com'),
    models: ['qwen3.8-flash', 'qwen3.7-plus', 'qwen3.8-max'],
  },
  {
    match: (url) => url.includes('volces.com') || url.includes('ark.cn-beijing'),
    models: ['doubao-seed-2-1-lite-260915', 'doubao-seed-2-1-pro-260915'],
  },
  {
    // Moonshot Kimi — both endpoints (api.moonshot.cn / api.moonshot.ai)
    // carry the same lineup after the 2026-05-25 and 2026-08-31
    // retirements: kimi-k2.6 (multimodal, default) and kimi-k3 (flagship,
    // multimodal, pricier). Keys are NOT interchangeable between the two
    // platforms. Verified via GET /v1/models 2026-09.
    match: (url) => url.includes('moonshot.cn') || url.includes('moonshot.ai'),
    models: ['kimi-k2.6', 'kimi-k3'],
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
