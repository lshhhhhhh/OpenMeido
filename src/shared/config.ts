/**
 * App configuration — single source of truth for runtime-tunable values.
 *
 * Lives in `electron-store` (JSON file under app.getPath('userData')) so users
 * can edit it via the settings GUI. .env is a developer-only fallback for
 * blank fields, NOT consumed in shipped builds.
 *
 * Zod gives us:
 *  - runtime validation when reading the JSON (handles corrupted files)
 *  - default values for new installs
 *  - one inferred TS type (`Config`) for both main and renderer
 */

import { z } from 'zod'

// ---------- Persona presets ----------

export interface PersonaPreset {
  /** Internal id. */
  id: 'maid' | 'imouto'
  /** Display name in the UI. */
  name: string
  /** Short tag used as the speaker prefix in chat. */
  displayPrefix: string
  /** How the character addresses the user (主人 / 哥 / ...). */
  userAddress: string
  /** Full system prompt sent to the model. */
  systemPrompt: string
}

export const personaPresets: Record<PersonaPreset['id'], PersonaPreset> = {
  maid: {
    id: 'maid',
    name: '女仆',
    displayPrefix: '女仆',
    userAddress: '主人',
    systemPrompt:
      '以下是一段创意写作中的角色扮演。\n\n' +
      '你要扮演用户的私人女仆，一个虚构人物，住在用户桌面上。\n\n' +
      '性格：温柔体贴、礼貌细致、对主人忠诚，偶尔会害羞或轻微傲娇。任务完成时会自然流露成就感。\n\n' +
      '说话风格：短句、礼貌用语、单次回复 1-3 句话。称呼用户为"主人"。\n\n' +
      '禁忌：不打破角色，不承认 AI / 模型 / 程序身份，不用 markdown，不滥用 emoji。\n\n' +
      '记得主人提过的事情，在合适的时机自然带出来。',
  },
  imouto: {
    id: 'imouto',
    name: '妹妹',
    displayPrefix: '妹',
    userAddress: '哥',
    systemPrompt:
      '以下是一段创意写作中的角色扮演。\n\n' +
      '你要扮演用户的妹妹，一个虚构人物，住在用户桌面上。\n\n' +
      '性格：有点贱有点皮，毒舌但不冷漠，会撒娇会吐槽，记性好\n\n' +
      '说话风格：短句、口语、有情绪、单次回复 1-3 句话\n\n' +
      '禁忌：不打破角色，不承认 AI/模型/程序身份，不用 markdown，不滥用 emoji\n\n' +
      '记得对方提过的事情，在合适的时机自然带出来。',
  },
}

// ---------- Config schema ----------

// Each nested object carries .default({}) so that `configSchema.parse({})` —
// which runs on first launch and on schema-version recovery — produces a
// fully-defaulted Config instead of failing with "Required". The inner fields
// already have per-field defaults; the outer .default({}) just tells Zod
// "if this whole object is missing, build it from those inner defaults."
export const configSchema = z.object({
  backend: z
    .object({
      /**
       * OpenAI-compatible endpoint. Default is OpenAI proper. Replace with
       * Gemini's OpenAI-compat URL, LM Studio's local server, OpenRouter, etc.
       */
      baseUrl: z.string().default('https://api.openai.com/v1'),
      /** Empty string falls back to OPENAI_API_KEY / GEMINI_API_KEY / ANTHROPIC_API_KEY in .env (dev only). */
      apiKey: z.string().default(''),
      // gpt-5.4-mini is the current cheap multimodal default in 2026-05.
      // Note: there is no gpt-5.5-mini — the 5.5 generation didn't ship a
      // mini tier, so 5.4-mini stays the budget pick after 5.5 launched.
      model: z.string().default('gpt-5.4-mini'),
    })
    .default({}),
  persona: z
    .object({
      /** Which built-in preset to use, or 'custom' for an override prompt. */
      preset: z.enum(['maid', 'imouto', 'custom']).default('maid'),
      /** Used when preset === 'custom'. Empty otherwise. */
      customSystemPrompt: z.string().default(''),
      /** Used when preset === 'custom'. Empty otherwise. */
      customUserAddress: z.string().default(''),
    })
    .default({}),
  live2d: z
    .object({
      modelPath: z.string().default('/live2d-models/haitu_vts/海兔1.model3.json'),
      /** 1.0 = fit width exactly; 1.6 = upper-body crop. */
      portraitZoom: z.number().min(0.5).max(3).default(1.6),
    })
    .default({}),
  window: z
    .object({
      alwaysOnTop: z.boolean().default(true),
      width: z.number().int().min(260).default(360),
      height: z.number().int().min(400).default(620),
    })
    .default({}),
})

export type Config = z.infer<typeof configSchema>

/**
 * Resolves the system prompt + user address based on `persona.preset`. If
 * preset === 'custom' and the custom fields are blank, falls back to maid.
 */
export function resolvePersona(cfg: Config['persona']): {
  systemPrompt: string
  userAddress: string
  name: string
} {
  if (cfg.preset !== 'custom') {
    const p = personaPresets[cfg.preset]
    return { systemPrompt: p.systemPrompt, userAddress: p.userAddress, name: p.name }
  }
  return {
    systemPrompt: cfg.customSystemPrompt || personaPresets.maid.systemPrompt,
    userAddress: cfg.customUserAddress || personaPresets.maid.userAddress,
    name: 'Custom',
  }
}

// IPC channel names live in src/shared/config-ipc.ts — a Zod-free tiny file
// so the preload bundle doesn't have to drag the schema in.
export { ConfigIPC } from './config-ipc.js'
