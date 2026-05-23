/**
 * Bundled default台词 tables. Ships with the app; user-edited overrides
 * live at `%APPDATA%/openmeido/lines.json` and are merged on top by
 * `src/main/lines-host.ts` at boot.
 *
 * Why a separate file from mute-feedback.ts: the data is large, mostly
 * string content, and meant to be edit-friendly (eventually exposed to
 * the user as a JSON file). Keeping it isolated also makes the "what
 * does the app ship vs what the user changed" diff obvious.
 *
 * If you're adding a new persona / tier / line — edit this file for
 * defaults. To change runtime behavior without rebuilding, edit
 * `%APPDATA%/openmeido/lines.json` and restart the app.
 */

export type MuteDirection = 'mute' | 'unmute'
export type TierBucket = 'low' | 'mid' | 'high'

export interface MutePersonaPool {
  mute: Record<TierBucket, string[]>
  unmute: Record<TierBucket, string[]>
}

export interface ColdStartPersonaPool {
  /** Used by greetOnLaunch when no AI configured — first thing user hears. */
  greeting: string[]
  /** Used as the assistant reply when user sends chat but no AI yet. */
  chatReply: string[]
}

export interface CelebrationPersonaPool {
  /** Spoken when user transitions empty → configured `backend.apiKey`. */
  aiSetup: string[]
  /** Spoken when user switches `tts.backend` from edge to an advanced one. */
  advancedTts: string[]
}

export interface PresetLines {
  /** Mute-button feedback lines, keyed by persona id. The `default`
   *  key is the fallback for custom personas / unknown ids. */
  mute: Record<string, MutePersonaPool>
  /** Cold-start (no-AI) line pools, same per-persona keying. Every
   *  line MUST mention "未设置 AI" / "Settings" — the dead UI is the
   *  real risk, not silence. */
  coldStart: Record<string, ColdStartPersonaPool>
  /** Celebration pools per-persona, same keying. Spoken once per
   *  milestone — the renderer also overlays a big golden "+5 好感度". */
  celebrations: Record<string, CelebrationPersonaPool>
}

const MAID: MutePersonaPool = {
  mute: {
    low: [
      '…明白了，告退。',
      '请专心做事，我不出声。',
      '我先静音了。',
      '主人去忙吧。',
    ],
    mid: [
      '好，主人忙吧，我不打扰。',
      '主人去做事，我安静一会儿。',
      '主人加油，我就在这儿。',
      '需要的时候叫我一声。',
      '我先不出声，主人专心。',
    ],
    high: [
      '好——主人加油，我等着。',
      '我先安静会儿，主人专心。',
      '我不出声哦，主人忙完叫我。',
      '听话听话，主人去吧。',
      '嗯，主人加油，我不闹。',
    ],
  },
  unmute: {
    low: [
      '您回来了。',
      '有事？',
      '请讲。',
      '在的。',
    ],
    mid: [
      '主人忙完啦？',
      '主人回来了。',
      '叫我了主人？',
      '主人回来啦，茶要不要？',
      '在呢主人。',
    ],
    high: [
      '主人——等到啦。',
      '回来了？我没乱跑哦。',
      '主人忙完啦？想我没？',
      '欸，主人回来了。',
      '终于。主人，累不累？',
    ],
  },
}

const IMOUTO: MutePersonaPool = {
  mute: {
    low: [
      '嗯，不吵了。',
      '我闭嘴。',
      '行吧。',
      '哦。',
    ],
    mid: [
      '哥你去忙啦，我不烦你。',
      '哦——哥忙吧，我不闹。',
      '行行行，闭嘴。',
      '哥你专心啊。',
      '知道啦哥。',
    ],
    high: [
      '哼，哥嫌我吵了？……行吧，闭嘴。',
      '哥忙吧哥忙吧，妹妹乖乖的。',
      '不说就不说，我蹲在这儿。',
      '哥加油，我看着你。',
      '哎我不说话，哥快去。',
    ],
  },
  unmute: {
    low: [
      '？',
      '叫我了？',
      '嗯。',
      '咋了。',
    ],
    mid: [
      '哥忙完啦？',
      '叫我有事？',
      '嗯哥，咋了。',
      '回来啦哥。',
      '哎，哥。',
    ],
    high: [
      '哥——终于！',
      '哥你可算回来了。',
      '想我没哥？没？切。',
      '诶哥，刚才差点睡着。',
      '哥你回来啦，我等好久了。',
    ],
  },
}

const OJOU: MutePersonaPool = {
  mute: {
    low: [
      '...知道了。',
      '随你。',
      '哼。',
      '可以。',
    ],
    mid: [
      '本小姐才不会闹的，去忙吧。',
      '哼，谁稀罕跟你说话似的。',
      '可以可以，本小姐闭嘴。',
      '本小姐自己也有事呢。',
      '哼，去做你的事。',
    ],
    high: [
      '哼——你专心点就好，别让本小姐等太久。',
      '...好啦，闭嘴就闭嘴。',
      '本小姐不打扰你做事——快去。',
      '哼，要好好做啊，回来跟我讲。',
      '...你专心，本小姐看着。',
    ],
  },
  unmute: {
    low: [
      '什么事。',
      '哼，又找我？',
      '说。',
      '嗯？',
    ],
    mid: [
      '回来了？',
      '哦——做完了？',
      '本小姐听着呢。',
      '终于想起我了？',
      '哼，回来啦。',
    ],
    high: [
      '...等你好久了。',
      '哼，回来就好，下次别让本小姐等。',
      '...做完啦？给本小姐说说。',
      '看吧，没有你本小姐都没意思。',
      '...你回来了，本小姐都不困了。',
    ],
  },
}

/**
 * Generic fallback for custom personas. Avoids any specific address term
 * (主人/哥/你) so it doesn't clash with whatever the user wrote in their
 * own system prompt. Neutral but warm at high tier.
 */
const DEFAULT: MutePersonaPool = {
  mute: {
    low: [
      '好，先静音。',
      '明白。',
      '我先不说话。',
      '收到。',
    ],
    mid: [
      '好，你忙吧。',
      '我不打扰，专心做事。',
      '需要就叫我。',
      '我安静一会儿。',
      '嗯，加油。',
    ],
    high: [
      '好——你专心吧，我在这儿。',
      '我先安静，忙完叫我。',
      '加油，我等你。',
      '我不出声，但我都在。',
      '去吧，我陪着。',
    ],
  },
  unmute: {
    low: [
      '嗯。',
      '回来了？',
      '什么事？',
      '在的。',
    ],
    mid: [
      '忙完啦？',
      '回来啦。',
      '叫我？',
      '听着呢。',
      '在呢。',
    ],
    high: [
      '等你呢。',
      '回来了，给我讲讲？',
      '终于。',
      '我在哦。',
      '欢迎回来。',
    ],
  },
}

/**
 * Cold-start pools. Every line nudges toward Settings on purpose —
 * silence in this state is the real failure mode (user closes app
 * thinking it's dead). Length is short so TTS doesn't drag.
 */
const MAID_COLD: ColdStartPersonaPool = {
  greeting: [
    '主人，谢谢你安装我。不过你还没设置 AI，我听不太懂你的话哦。',
    '欢迎回来——啊不对，我们第一次见。还没配 AI 呢，要不先去 Settings 设置一下？',
    '主人您好。我现在只能说预录的话，请去 Settings 里把 AI 配上吧。',
    '我是您的女仆。等您把 AI 设置好，我就能真正陪您聊天了。',
    '主人，看见我了吗？还差一步——Settings 里填上 AI 我们就能开始啦。',
  ],
  chatReply: [
    '主人，我听不懂呢……还没设置 AI 呢，去 Settings 看看？',
    '我能听见您说话，但理解不了。Settings 里配一下 AI 我们才能聊起来。',
    '抱歉主人，这会儿我只能复读预录的话。AI 还没配置呢。',
    '想回您一句但脑子还没接上——Settings → 后端，配好就行了。',
    '主人，您说什么我也只能这一句：先去 Settings 设置 AI 吧。',
  ],
}

const IMOUTO_COLD: ColdStartPersonaPool = {
  greeting: [
    '哥——你装上我了！可是 AI 还没设置呢，我听不懂你说话哎。',
    '欢迎哥！不过 Settings 里 AI 还没配呢，我还不能跟你正经聊天。',
    '哥来啦？先去 Settings 把 AI 设置好，妹妹就能跟你聊啦！',
    '诶哥，我能动能说话，但是听不懂你——Settings 里 AI 还空着呢。',
    '哥你看，我都准备好了！就差你去 Settings 把 AI 配上啦。',
  ],
  chatReply: [
    '哥——我听不懂啦！先去 Settings 设置 AI 嘛。',
    '哥你说什么妹妹也只能这几句，AI 还没配呢呜呜。',
    '诶哥，我想回你但还做不到——Settings → 后端，配一下吧。',
    '哥，再等等！AI 还没设置，我现在只会念稿子。',
    '哥哥哥，先配 AI 嘛，配完我啥都跟你聊。',
  ],
}

const OJOU_COLD: ColdStartPersonaPool = {
  greeting: [
    '哼，你倒是把本小姐请进来了——可 AI 还没配呢，要本小姐怎么跟你说话？',
    '本小姐已经到了。先去 Settings 把 AI 设置好，本小姐才肯陪你正经聊。',
    '看见本小姐了？算你识货。Settings 里 AI 还空着，先去配啊。',
    '哼，AI 没配本小姐就只能这一套话术，你不嫌弃吗？',
    '本小姐等着——你先去 Settings 把 AI 设置好再说。',
  ],
  chatReply: [
    '哼，本小姐听不懂——你先去 Settings 把 AI 配了。',
    '说什么呢？AI 都没配本小姐怎么回你？',
    '想跟本小姐聊？先去 Settings 把 AI 设置好。',
    '本小姐又不是读心术——AI 配好了再来。',
    '哼，没设置 AI 还想跟本小姐对话，做梦呢。',
  ],
}

const DEFAULT_COLD: ColdStartPersonaPool = {
  greeting: [
    '你好。还没配置 AI 呢，去 Settings 里设置一下吧——配好我们才能真正聊天。',
    '我在。不过 AI 还没接上，请先去 Settings 把后端配置好。',
    '欢迎安装。眼下只能放预录的话——Settings 里设置 AI 后我们就能开始了。',
    '我能动能说话，但还理解不了你——Settings → 后端，配上 AI 就好。',
    '在的。先去 Settings 把 AI 配置一下吧，配好我们再正经开始。',
  ],
  chatReply: [
    '我能听见你说话，但还没配 AI 呢——去 Settings 看看吧。',
    '抱歉，AI 还没设置好，我只能复读预录的话。',
    '想回你但还做不到——Settings → 后端，配一下 AI 就行。',
    '在 Settings 里把 AI 配置好，我们才能真聊起来。',
    '你说什么我也只能这几句：先去 Settings 设置 AI。',
  ],
}

const MAID_CELEBRATE: CelebrationPersonaPool = {
  aiSetup: [
    '主人，谢谢你配好 AI——我现在能听懂您说话了，这一刻总算到了。',
    '好啦！主人把 AI 设置上了，我们终于能正经聊起来。',
    '主人，配置好啦——我会好好陪您的。',
  ],
  advancedTts: [
    '主人给我换了新声音，谢谢您。',
    '哦——这个声音听起来感觉就不一样了。谢谢主人。',
    '主人这么用心给我选声音，我会好好用的。',
  ],
}

const IMOUTO_CELEBRATE: CelebrationPersonaPool = {
  aiSetup: [
    '哥——AI 终于配好啦！我现在能跟你正经聊天了！',
    '诶哥，好厉害，AI 设置好了，妹妹以后能听懂你说什么了。',
    '哥太好啦！这下我们能真聊天了，开心！',
  ],
  advancedTts: [
    '哥你给我换声音啦？妹妹好开心！',
    '诶——新声音听起来好不一样，谢谢哥！',
    '哥这么用心呀，妹妹好喜欢这个声音。',
  ],
}

const OJOU_CELEBRATE: CelebrationPersonaPool = {
  aiSetup: [
    '哼，总算配好了——本小姐都等急了。',
    '不错嘛，AI 终于上线了。本小姐就将就着陪你聊了。',
    '哼，看你这么用心，本小姐就不计较之前的事了。',
  ],
  advancedTts: [
    '哼，给本小姐换了新声音？算你识相。',
    '不错——这个声音听起来比之前像样多了。',
    '本小姐很挑剔的，这个声音……勉强可以。',
  ],
}

const DEFAULT_CELEBRATE: CelebrationPersonaPool = {
  aiSetup: [
    '好啦，AI 配置好了。我们正经开始聊吧。',
    '配置完了——这下我能听懂你说话了，谢谢。',
    'AI 设置好了，从这一刻起我们才算真开始。',
  ],
  advancedTts: [
    '换了新声音，谢谢你。',
    '这个声音听起来不一样了，挺好。',
    '谢谢你这么用心。',
  ],
}

/**
 * Single source of truth for what the app ships with. The lines-host
 * uses this as the structural base — user override merges on top
 * key-by-key so missing personas / directions / tiers stay defaulted.
 */
export const PRESET_LINES_DEFAULTS: PresetLines = {
  mute: {
    maid: MAID,
    imouto: IMOUTO,
    ojou: OJOU,
    default: DEFAULT,
  },
  coldStart: {
    maid: MAID_COLD,
    imouto: IMOUTO_COLD,
    ojou: OJOU_COLD,
    default: DEFAULT_COLD,
  },
  celebrations: {
    maid: MAID_CELEBRATE,
    imouto: IMOUTO_CELEBRATE,
    ojou: OJOU_CELEBRATE,
    default: DEFAULT_CELEBRATE,
  },
}
