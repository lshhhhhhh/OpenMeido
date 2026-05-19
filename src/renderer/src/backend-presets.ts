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
    models: ['gemini-2.5-flash', 'gemini-3.1-flash-lite', 'gemini-3.1-pro-preview'],
  },
  {
    match: (url) => url.includes('anthropic.com'),
    models: ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-7'],
  },
  {
    match: (url) => url.includes('bigmodel.cn'),
    models: ['glm-4.6v-flash', 'glm-4.6v', 'glm-5'],
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
