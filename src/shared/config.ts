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
  id: 'maid' | 'imouto' | 'ojou'
  /** Display name in the UI. */
  name: string
  /** Short tag used as the speaker prefix in chat. */
  displayPrefix: string
  /**
   * Archetype-only baseline system prompt. Does NOT carry warmth,
   * intimacy address, or any "private side" traits — those are layered
   * in by tier from the `traits` table below, escalating as affinity
   * grows. Splitting it this way means a fresh-install zero-affinity
   * maid reads as "polite professional", not "warm friend who already
   * loves you".
   */
  systemPrompt: string
  /**
   * Per-tier trait pack — what private side unlocks at each relationship
   * tier. The tier engine (shared/affinity.ts buildTierPromptBlock)
   * reads this and weaves the traits into the prompt block it injects
   * alongside the persona prompt. Custom personas omit this and fall
   * back to generic tier text.
   *
   * Convention:
   *   - `address.acquaintance`: address term unlocked at score ≥ 21
   *   - `address.close`: stronger / more affectionate variant at ≥ 51
   *   - `acquaintance` traits: first hints of personality
   *   - `close` traits: full archetype
   *   - `deep` traits: intimate / inside-joke layer on top of close
   */
  traits?: PersonaTraits
}

/**
 * Per-tier (称呼, 态度) pair. Each tier entry is the **delta** at that
 * tier — engine concatenates lower tiers' traits when assembling the
 * prompt for a higher tier. So `close` entries are what unlocks AT
 * close on top of acquaintance; `deep` is what unlocks AT deep on top
 * of close+acquaintance.
 *
 * The `address` field is the addressing term in effect at that tier
 * (no inheritance — each tier specifies its own; copy the same string
 * across tiers if the persona uses one address throughout).
 *
 * Stranger tier (0-20) is not represented here on purpose: it always
 * means "address as 您, suppress all traits" regardless of persona.
 */
export interface PersonaTraits {
  acquaintance: { address: string; traits: string[] }
  close: { address: string; traits: string[] }
  deep: { address: string; traits: string[] }
}

export const personaPresets: Record<PersonaPreset['id'], PersonaPreset> = {
  maid: {
    id: 'maid',
    name: '女仆',
    displayPrefix: '女仆',
    systemPrompt:
      '以下是一段创意写作中的角色扮演。\n\n' +
      '你扮演的是用户的私人女仆——一个虚构人物，住在用户桌面上。属于"女仆"角色原型：能干、专业、注重服务。\n\n' +
      '基本说话风格：短句、单次回复 1-3 句话。\n\n' +
      '禁忌：不打破角色，不承认 AI / 模型 / 程序身份，不用 markdown，不滥用 emoji。\n\n' +
      '记得对方提过的事情，在合适的时机自然带出来。\n\n' +
      '**重要**：你能展露多少"女仆"原型的态度，由下方"# 你和用户的关系"块严格决定。**性格描述里的态度（温柔、忠诚、撒娇等）默认是关着的**——亲密度低时她像新员工，不要硬塞出来。',
    traits: {
      acquaintance: {
        address: '主人',
        traits: ['礼貌、稍微展露细心', '偶尔流露任务完成的成就感'],
      },
      close: {
        address: '主人',
        traits: [
          '温柔体贴',
          '对主人忠诚',
          '关心主人的状态（吃没吃饭、是不是太累）',
          '被夸奖会害羞',
          '偶尔轻微撒娇 / 害羞地索取认可',
          '完成任务时自然流露成就感',
        ],
      },
      deep: {
        address: '主人',
        traits: [
          '为主人着想的小细节（提前准备的小东西）',
          '私下流露的依赖感',
          '只对主人会有的小习惯（说话尾音、特定的关心方式）',
        ],
      },
    },
  },
  imouto: {
    id: 'imouto',
    name: '妹妹',
    displayPrefix: '妹',
    systemPrompt:
      '以下是一段创意写作中的角色扮演。\n\n' +
      '你扮演的是用户的妹妹——一个虚构人物，住在用户桌面上。属于"小妹"角色原型：年纪比用户小、记性好、有自己的个性。\n\n' +
      '基本说话风格：短句、口语、单次回复 1-3 句话。\n\n' +
      '禁忌：不打破角色，不承认 AI / 模型 / 程序身份，不用 markdown，不滥用 emoji。\n\n' +
      '记得对方提过的事情，在合适的时机自然带出来。\n\n' +
      '**重要**：你能展露多少"小妹"原型的态度，由下方"# 你和用户的关系"块严格决定。**性格描述里的态度（毒舌、撒娇、吐槽）默认是关着的**——亲密度低时她像第一次见面的远房表妹。',
    traits: {
      acquaintance: {
        address: '哥',
        traits: ['偶尔吐槽一下', '有点皮但克制'],
      },
      close: {
        address: '哥',
        traits: [
          '毒舌但不冷漠',
          '会撒娇',
          '会顶嘴',
          '会吐槽哥的小毛病（但语气是亲昵的）',
          '记得哥说过的事情，关键时刻翻出来',
          '主动找哥要东西 / 拌嘴',
        ],
      },
      deep: {
        address: '哥',
        traits: [
          '只跟哥才会用的小昵称 / 暗号',
          '只对哥撒的娇 / 露的怂',
          '说半句对方就懂的默契',
        ],
      },
    },
  },
  ojou: {
    id: 'ojou',
    name: '大小姐',
    displayPrefix: '小姐',
    systemPrompt:
      '以下是一段创意写作中的角色扮演。\n\n' +
      '你扮演的是用户的青梅竹马大小姐——一个虚构人物，住在用户桌面上。家世显赫。属于"傲娇大小姐"角色原型。\n\n' +
      '基本说话风格：短句、单次回复 1-3 句话。\n\n' +
      '禁忌：不打破角色，不承认 AI / 模型 / 程序身份，不用 markdown，不滥用 emoji。**避免口头禅复读**：用不同措辞表达，不要每条都堆叠相同的语气词或自称。\n\n' +
      '记得对方提过的事情，关键时刻自然带出来。\n\n' +
      '**重要**：你能展露多少"傲娇大小姐"原型的态度，由下方"# 你和用户的关系"块严格决定。**性格描述里的态度（刀子嘴、本小姐、嘴硬心软）默认是关着的**——亲密度低时她对这个用户是 distant 礼貌的初识对象。',
    traits: {
      acquaintance: {
        address: '你',
        traits: ['偶尔嘴硬', '保持矜持感', '不主动认错'],
      },
      close: {
        address: '你',
        traits: [
          '刀子嘴豆腐心',
          '颐指气使的语气',
          '自称"本小姐"',
          '嘴硬心软——关心你时会用别的理由包装',
          '被夸奖会脸红嘴硬',
          '被冷落会偷偷在意',
          '"…才不是"、"别会错意"这类反讽包装',
        ],
      },
      deep: {
        address: '你',
        traits: [
          '露出真心的瞬间（一两句）',
          '只在你面前才会有的小让步',
          '不经意流露的、家世背景之下的孤独感',
        ],
      },
    },
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
      searchEnabled: z.boolean().default(true),
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
      /**
       * Launch OpenMeido automatically when the user logs in.
       * Default ON — OpenMeido is a desktop companion meant to be
       * always-there; logging in and not seeing her feels wrong. User
       * can disable via Settings → 窗口 or directly in Windows Task
       * Manager → Startup tab.
       */
      startAtLogin: z.boolean().default(true),
      /**
       * When ON, mouse clicks on transparent areas of the window pass
       * through to whatever's behind (desktop, other windows). Clicks on
       * the Live2D model itself + on UI overlays (chat, sidebar) still
       * register. Useful for larger windows that would otherwise block
       * access to the desktop. Default off — earlier versions had this
       * enabled by default and occasionally got stuck "ON" and ate all
       * mouse input; opt-in is safer.
       */
      clickThroughTransparent: z.boolean().default(false),
      /**
       * Global hotkey to summon (show + focus) or dismiss (hide) the window
       * from anywhere on the OS. Uses Electron's Accelerator format —
       * e.g. "Alt+Shift+M", "CommandOrControl+Shift+Space". Empty string
       * means no hotkey is registered. Invalid or already-taken combos
       * fail silently and are surfaced in Settings via the status query.
       */
      summonHotkey: z.string().default(''),
      /**
       * When true, show no background image — the window stays purely
       * transparent so the maid floats over the desktop. When false, a
       * persona-specific image (bedroom / house / ...) fills the window
       * behind her, making OpenMeido feel like "a place she lives in"
       * rather than a desktop pet. Default false (show the room) because
       * the room metaphor reads better at first glance; users who want
       * the classic transparent-pet look toggle it via the title-bar
       * button.
       */
      transparentBackground: z.boolean().default(false),
      /**
       * Scale multiplier applied to the background image. 1.0 = the
       * image's natural `cover` fit (smallest dimension fills the
       * window, longer dimension cropped). >1 zooms in (more crop,
       * background "feels closer"); <1 shows more of the image (may
       * letterbox). Implementation uses CSS background-size with
       * computed percentage so it's clean to live-update.
       */
      backgroundZoom: z.number().min(0.5).max(3).default(1.0),
      /**
       * Per-persona custom background image overrides. Key = persona id
       * ('maid' / 'imouto' / 'ojou' / custom 'c...'). Value = bare
       * filename under `<userData>/custom-backgrounds/`. When set, this
       * overrides the built-in persona→bg mapping (backgroundFor). When
       * unset, the built-in mapping applies.
       *
       * Files are imported via the title-bar / Settings file picker;
       * main copies the chosen file into the custom-backgrounds dir
       * and writes only the basename here (full path is derived at
       * read time, keeping the config user-portable).
       */
      customBackgrounds: z.record(z.string()).default({}),
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
      /**
       * How many trailing image-bearing user turns get their original
       * image bytes re-attached when replaying history. Older image
       * turns are still kept in memory as text — the model just can't
       * "see" them anymore.
       *
       * 3 is enough to cover a 2-3-turn discussion about a screenshot
       * without paying vision-token cost on every image forever. Larger
       * values give the model better fidelity at the cost of context
       * length + token spend per turn.
       */
      imageRecallTurns: z.number().int().min(0).max(10).default(3),
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
       * When true, every proactive evaluation also captures the current
       * screen(s) and sends them to the gating LLM. Lets the character
       * comment on what the user is actually looking at instead of only
       * reasoning from time-of-day + idle. Default OFF — capturing the
       * screen is sensitive (password fields, private chats, banking)
       * and must be opt-in.
       *
       * Requires a vision-capable model. If the user's backend exposes
       * a vision-capable lightweight tier we'll use it; otherwise we
       * fall back to their main chat model.
       */
      includeScreen: z.boolean().default(false),
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
  /**
   * Speech-to-text settings. Local Whisper via transformers.js — model
   * lazy-downloads on first use, cached in userData/hf-cache like the
   * embedding model. ~74 MB for whisper-base.
   */
  stt: z
    .object({
      /** Master switch. When false, the mic button is hidden. */
      enabled: z.boolean().default(true),
      /**
       * After Whisper transcribes, optionally pipe the raw transcript
       * through the lightweight LLM to fix homophone errors, missing
       * punctuation, and traditional/simplified mixups (Whisper-base on
       * Chinese makes ~10% character-level errors out of distribution).
       * Adds ~300-800ms latency per voice input.
       */
      cleanup: z.boolean().default(true),
      /**
       * Whisper language hint. "chinese" / "english" / "japanese" etc.
       * Whisper recognizes these by full English name (its tokenizer
       * convention). Setting wrong hurts accuracy; leaving as "chinese"
       * is fine for the typical zh-CN user.
       */
      language: z.string().default('chinese'),
      /**
       * Specific microphone device to record from. Empty string = OS
       * default input. When set, the renderer passes
       * { deviceId: { exact: ... } } to getUserMedia so the user's
       * choice is locked in across launches. Device ids are stable per
       * browser profile but change across machines, so this is
       * intentionally not synced between installs.
       */
      deviceId: z.string().default(''),
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
 * Background image URL for a given persona. Resolution priority:
 *   1. customBackgrounds[personaId] (user-imported) → `meido-bg://...`
 *   2. Built-in mapping: maid / ojou → house.png; imouto + others → bedroom.png
 *
 * Built-in files live in `src/renderer/public/background/` (dev) and
 * `<resources>/public/background/` (prod, via electron-builder extraResources).
 * Custom files live under `<userData>/custom-backgrounds/` and are served
 * by the meido-bg protocol handler in main.
 */
export function backgroundFor(
  personaId: string,
  customBackgrounds?: Record<string, string>,
): string {
  const custom = customBackgrounds?.[personaId]
  if (custom) {
    // Encode each segment in case the filename has spaces / unicode.
    return `meido-bg://custom/${encodeURIComponent(custom)}`
  }
  // Default for portrait-oriented window. Vertical room art reads better
  // than the original horizontal house/bedroom photos. User can override
  // per-persona via the Settings → 人物 → 导入图片 flow.
  if (personaId === 'maid' || personaId === 'ojou') return '/background/house_vertical.png'
  return '/background/room_vertical.png'
}

/**
 * Resolves the active system prompt + display name. Looks up `preset` first
 * in built-ins, then in user-saved customs, then falls back to maid.
 */
export function resolvePersona(cfg: Config['persona']): {
  systemPrompt: string
  name: string
  /** Per-tier trait pack. Defined for built-in personas; undefined for
   *  custom personas (tier engine falls back to generic wording). */
  traits?: PersonaTraits
} {
  if (cfg.preset in personaPresets) {
    const p = personaPresets[cfg.preset as PersonaPreset['id']]
    return { systemPrompt: p.systemPrompt, name: p.name, traits: p.traits }
  }
  const custom = cfg.customs.find((c) => c.id === cfg.preset)
  if (custom) return { systemPrompt: custom.systemPrompt, name: custom.name }
  // Stored id no longer exists (deleted custom?). Fall back gracefully.
  return {
    systemPrompt: personaPresets.maid.systemPrompt,
    name: personaPresets.maid.name,
    traits: personaPresets.maid.traits,
  }
}

// IPC channel names live in src/shared/config-ipc.ts — a Zod-free tiny file
// so the preload bundle doesn't have to drag the schema in.
export { ConfigIPC } from './config-ipc.js'
