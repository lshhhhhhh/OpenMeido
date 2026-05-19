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
  /** Full system prompt sent to the model. The "how to address the user"
   * (主人 / 哥 / ...) is baked into the prompt body itself — no separate
   * field, so the address and the prompt can never disagree. */
  systemPrompt: string
}

export const personaPresets: Record<PersonaPreset['id'], PersonaPreset> = {
  maid: {
    id: 'maid',
    name: '女仆',
    displayPrefix: '女仆',
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
    systemPrompt:
      '以下是一段创意写作中的角色扮演。\n\n' +
      '你要扮演用户的妹妹，一个虚构人物，住在用户桌面上。\n\n' +
      '性格：有点贱有点皮，毒舌但不冷漠，会撒娇会吐槽，记性好\n\n' +
      '说话风格：短句、口语、有情绪、单次回复 1-3 句话。称呼用户为"哥"。\n\n' +
      '禁忌：不打破角色，不承认 AI/模型/程序身份，不用 markdown，不滥用 emoji\n\n' +
      '记得对方提过的事情，在合适的时机自然带出来。',
  },
}

/**
 * Fill-in-the-blank template handed to the user when they first switch to
 * the custom persona. Bracket-marked sections are guidance for the user to
 * replace — once filled, the whole thing IS the system prompt.
 */
export const CUSTOM_PERSONA_TEMPLATE =
  '以下是一段创意写作中的角色扮演。\n\n' +
  '你要扮演用户的【填写：妹妹 / 女仆 / 朋友 / 同事 / ...】，一个虚构人物，住在用户桌面上。\n\n' +
  '性格：【填写，例如"毒舌但不冷漠，会撒娇会吐槽" 或 "温柔细心、做事可靠"】\n\n' +
  '说话风格：短句、口语、单次回复 1-3 句话。称呼用户为「【填写：哥 / 主人 / 你 / ...】」。\n\n' +
  '禁忌：不打破角色，不承认 AI / 模型 / 程序身份，不用 markdown，不滥用 emoji。\n\n' +
  '记得对方提过的事情，在合适的时机自然带出来。'

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
      /**
       * Per-backend api-key storage. Keyed by `baseUrl`. Lets the user
       * switch providers without losing previously-entered keys: when
       * Settings swaps `baseUrl`, it stashes the current `apiKey` here
       * under the old baseUrl and pulls the new one's saved key (if any).
       * The active `apiKey` field above is always a mirror of the entry
       * for the active baseUrl — keeping both lets older callsites that
       * only read `apiKey` keep working without changes.
       */
      apiKeys: z.record(z.string()).default({}),
      // gpt-5.4-mini is the current cheap multimodal default in 2026-05.
      // Note: there is no gpt-5.5-mini — the 5.5 generation didn't ship a
      // mini tier, so 5.4-mini stays the budget pick after 5.5 launched.
      model: z.string().default('gpt-5.4-mini'),
      /**
       * Let the LLM browse the web for current information. When true:
       *   - Gemini backend: passes useSearchGrounding to the model factory.
       *     Model autonomously decides when to search; results grounded.
       *   - GLM / Qwen / OpenAI: not yet wired up (provider-specific tool
       *     shapes are more invasive than the Gemini case). Setting this
       *     true on those backends is currently a no-op with a console
       *     warning. Tracked as a follow-up.
       *   - DeepSeek / local: no native search; flag stays effectively off.
       */
      searchEnabled: z.boolean().default(false),
    })
    .default({}),
  persona: z
    .object({
      /**
       * The active persona id. Either a built-in (`maid` / `imouto`) or
       * the id of a user-saved custom persona from the `customs` array
       * below. Plain string so users can save N customs without us
       * extending an enum every time.
       */
      preset: z.string().default('maid'),
      /**
       * User-saved custom personas. Each appears as its own chip in the
       * Settings persona tab, so the user can keep multiple voices around
       * (e.g. 调皮的妹妹 / 严厉的助理) and switch between them.
       */
      customs: z
        .array(
          z.object({
            id: z.string(),
            name: z.string(),
            systemPrompt: z.string(),
          }),
        )
        .default([]),
    })
    .default({}),
  live2d: z
    .object({
      /**
       * Active model = directory name under `<userData>/live2d-models/`.
       * The renderer resolves this to a `meido-live2d://<name>/<modelFile>`
       * URL at load time (modelFile comes from each model's sidecar).
       *
       * Default 'hiyori_pro_en' = the canonical Live2D Cubism free-license
       * sample, shipped with public builds. Private builds may seed
       * additional models (e.g. `haitu_vts`) which the user can pick from
       * Settings → Live2D.
       */
      activeModel: z.string().default('hiyori_pro_en'),
      /** 1.0 = fit width exactly; 1.6 = upper-body crop. */
      portraitZoom: z.number().min(0.5).max(3).default(1.6),
    })
    .default({}),
  window: z
    .object({
      alwaysOnTop: z.boolean().default(true),
      width: z.number().int().min(260).default(480),
      height: z.number().int().min(400).default(720),
    })
    .default({}),
  embedding: z
    .object({
      /** Empty = inherit from backend.baseUrl. */
      baseUrl: z.string().default(''),
      /** Empty = inherit from backend.apiKey / .env. */
      apiKey: z.string().default(''),
      /** OpenAI text-embedding-3-small is the cheap multilingual default. */
      model: z.string().default('text-embedding-3-small'),
      /**
       * Vector dimension. Locked at first DB init — changing this later
       * means re-embedding everything (we drop + recreate the vec table).
       * 1536 is text-embedding-3-small's native; Gemini's embedding-001
       * supports Matryoshka truncation to 1536 as well.
       */
      dim: z.number().int().default(1536),
    })
    .default({}),
  memory: z
    .object({
      enabled: z.boolean().default(true),
      /** How many semantically-similar past episodes to inject. */
      topK: z.number().int().min(0).max(20).default(5),
      /** How many most-recent episodes to always include (working window). */
      recentN: z.number().int().min(0).max(40).default(10),
    })
    .default({}),
  proactive: z
    .object({
      /**
       * Master switch. Default ON — a desktop companion that NEVER talks
       * on her own feels broken-by-default; users who hate it can flip it
       * off in Settings → 主动 within seconds. The default poll/cooldown
       * are conservative (15 min timer, 10 min idle, 10 min cooldown)
       * so it's not noisy.
       */
      enabled: z.boolean().default(true),
      /** Seconds between trigger evaluations. 5s is plenty for chat cadence. */
      pollIntervalSec: z.number().int().min(2).max(60).default(5),
      /** Timer trigger: spontaneous remark every N seconds (since last reply). */
      timerSec: z.number().int().min(60).max(7200).default(900),
      /** Idle trigger: fire once when system has been idle this many seconds. */
      idleThresholdSec: z.number().int().min(30).max(3600).default(600),
      /** Don't fire if the user just spoke within this many seconds. */
      minSilenceSec: z.number().int().min(5).max(600).default(30),
      /** Hard cooldown between any two proactive remarks, regardless of trigger. */
      cooldownSec: z.number().int().min(60).max(7200).default(600),
      /**
       * Windows toast-notification listener — when ON, OpenMeido subscribes
       * to the OS notification feed (QQ / WeChat / Outlook etc.) and the LLM
       * decides whether to mention each one to the user. First-time activation
       * triggers a Windows system permission dialog.
       */
      notifListener: z
        .object({
          /** Master switch. Default OFF (privacy + permission prompt). */
          enabled: z.boolean().default(false),
          /**
           * Apps to surface, matched case-insensitively as substrings against
           * the OS-reported app name. Empty array = surface everything (very
           * noisy — use only if you want full pass-through).
           */
          allowlist: z
            .array(z.string())
            .default(['QQ', 'WeChat', '微信', 'Outlook', 'Mail', 'Telegram', 'Discord']),
        })
        .default({}),
    })
    .default({}),
  tts: z
    .object({
      /** Master switch. When false, the speaker button is hidden and auto-play disabled. */
      enabled: z.boolean().default(true),
      /**
       * Which TTS engine to use.
       *   - 'edge': Microsoft Edge TTS (free, online, no voice training)
       *   - 'sovits': GPT-SoVITS api_v2.py running locally (zero-shot voice
       *     cloning — bring your own ref audio + transcript)
       */
      backend: z.enum(['edge', 'sovits']).default('edge'),
      /**
       * Microsoft Edge TTS voice ShortName. XiaoyiNeural is the lightest /
       * youngest-sounding Chinese female voice — fits both the maid and
       * imouto personas without being too theatrical.
       * Full list: https://learn.microsoft.com/en-us/azure/cognitive-services/speech-service/language-support
       */
      voice: z.string().default('zh-CN-XiaoyiNeural'),
      /** Auto-play every assistant reply instead of requiring a click. */
      autoPlay: z.boolean().default(true),
      /**
       * RMS → mouth-open gain. 3.5 matches imouto-oss; higher = more
       * exaggerated mouth motion. 2.5–5.0 is the usable range.
       */
      mouthGain: z.number().min(0).max(10).default(3.5),
      /**
       * GPT-SoVITS api_v2.py settings. Only consulted when backend === 'sovits'.
       * Defaults assume the server is running locally on the standard port
       * with the desired voice model already loaded via /set_gpt_weights and
       * /set_sovits_weights (or pre-set at server launch).
       */
      sovits: z
        .object({
          /** api_v2.py HTTP endpoint. */
          baseUrl: z.string().default('http://127.0.0.1:9880'),
          /**
           * Absolute path (on the SoVITS server's filesystem) to the 3–10s
           * reference audio. The server reads this file each call.
           */
          refAudio: z.string().default(''),
          /** Verbatim transcript of refAudio — must match what the audio says. */
          refText: z.string().default(''),
          /** Language of the prompt/ref audio. zh/en/ja/ko/etc. */
          refLang: z.string().default('zh'),
          /** Language to synthesize (the maid's reply). */
          textLang: z.string().default('zh'),
          /** Sampling top-k for the GPT decoder. */
          topK: z.number().int().min(1).max(50).default(5),
          /** Sampling top-p for the GPT decoder. */
          topP: z.number().min(0).max(1).default(1.0),
          /** Temperature for the GPT decoder. */
          temperature: z.number().min(0).max(2).default(1.0),
          /** Playback speed (1.0 = native, >1 faster). */
          speedFactor: z.number().min(0.5).max(2).default(1.0),
        })
        .default({}),
    })
    .default({}),
  mail: z
    .object({
      enabled: z.boolean().default(false),
      host: z.string().default(''),
      port: z.number().int().default(993),
      /** IMAPS (TLS-from-the-start). Almost always true; only flip for legacy STARTTLS-on-143. */
      secure: z.boolean().default(true),
      username: z.string().default(''),
      /**
       * Mail password (usually an "app password" / "授权码", NOT the main
       * account password). Either plaintext (when passwordEncrypted is false)
       * or base64-encoded safeStorage ciphertext (when passwordEncrypted is
       * true). Main process encrypts on setConfig if encryption is available;
       * mail-host decrypts on use.
       */
      password: z.string().default(''),
      /**
       * Set by the main process after a successful safeStorage encryption.
       * Renderer sets it to false when sending a freshly-typed plaintext
       * password so the main process knows to re-encrypt before persisting.
       */
      passwordEncrypted: z.boolean().default(false),
    })
    .default({}),
  ui: z
    .object({
      /**
       * Whole-window zoom factor. 1.0 = browser default. We apply this via
       * Electron's `webContents.setZoomFactor`, so it scales every element
       * uniformly — chat, buttons, settings, status pills — without us
       * having to touch hundreds of hard-coded fontSize values. Default is
       * 1.15 because the original design used 11-13px which feels small on
       * modern hi-DPI displays.
       */
      fontScale: z.number().min(0.8).max(2.0).default(1.15),
    })
    .default({}),
})

export type Config = z.infer<typeof configSchema>

/**
 * Resolves the active system prompt + display name. Looks up `preset` first
 * in built-ins, then in user-saved customs, then falls back to maid.
 */
export function resolvePersona(cfg: Config['persona']): {
  systemPrompt: string
  name: string
} {
  if (cfg.preset === 'maid' || cfg.preset === 'imouto') {
    const p = personaPresets[cfg.preset]
    return { systemPrompt: p.systemPrompt, name: p.name }
  }
  const custom = cfg.customs.find((c) => c.id === cfg.preset)
  if (custom) return { systemPrompt: custom.systemPrompt, name: custom.name }
  // Stored id no longer exists (deleted custom?). Fall back gracefully.
  return { systemPrompt: personaPresets.maid.systemPrompt, name: personaPresets.maid.name }
}

// IPC channel names live in src/shared/config-ipc.ts — a Zod-free tiny file
// so the preload bundle doesn't have to drag the schema in.
export { ConfigIPC } from './config-ipc.js'
