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

export interface PresetLines {
  /** Mute-button feedback lines, keyed by persona id. The `default`
   *  key is the fallback for custom personas / unknown ids. */
  mute: Record<string, MutePersonaPool>
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
}
