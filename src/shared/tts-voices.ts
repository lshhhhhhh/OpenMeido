/**
 * Preset voice catalogs for the cloud TTS providers. These don't have a
 * queryable catalog API (or we'd need a separate auth round-trip), so we
 * ship the well-known voices as a static list and offer the Settings UI
 * a "custom voice id" text field as the escape hatch.
 *
 * Lists trimmed to the most useful subset — both providers offer 30+
 * voices but most users only want the "main 5-8 character voices".
 */

export interface PresetVoice {
  /** ID passed to the provider API (voice_id / voice_type). */
  id: string
  /** Display label in the dropdown — Chinese for the typical user. */
  label: string
  /** Optional one-line description (timbre, age, vibe). */
  hint?: string
}

/**
 * MiniMax preset voice catalog. Mainland (api.minimaxi.com) names.
 * International endpoint (api.minimax.io) often uses different IDs — for
 * those users, the Settings UI's "custom voice_id" input is the path.
 */
export const MINIMAX_PRESET_VOICES: PresetVoice[] = [
  { id: 'female-shaonv', label: '少女', hint: '清亮少女音 · 默认推荐' },
  { id: 'female-tianmei', label: '甜美女声', hint: '甜系少女 · 偏可爱' },
  { id: 'female-yujie', label: '御姐', hint: '成熟稳重' },
  { id: 'female-chengshu', label: '成熟女声', hint: '职场 / 主播向' },
  { id: 'male-qn-qingse', label: '青涩青年', hint: '少年男声' },
  { id: 'male-qn-jingying', label: '精英青年', hint: '冷静男声' },
  { id: 'male-qn-badao', label: '霸道青年', hint: '低沉男声' },
  { id: 'male-qn-daxuesheng', label: '大学生', hint: '邻家男声' },
  { id: 'presenter_female', label: '女主持人', hint: '新闻播报' },
  { id: 'presenter_male', label: '男主持人', hint: '新闻播报' },
  { id: 'audiobook_female_1', label: '有声书·女1' },
  { id: 'audiobook_female_2', label: '有声书·女2' },
  { id: 'audiobook_male_1', label: '有声书·男1' },
  { id: 'audiobook_male_2', label: '有声书·男2' },
]

export const MINIMAX_MODELS: { id: string; label: string; hint?: string }[] = [
  { id: 'speech-02-hd', label: 'speech-02-hd', hint: '最高品质 · 推荐' },
  { id: 'speech-02-turbo', label: 'speech-02-turbo', hint: '快 · 便宜' },
  { id: 'speech-01-hd', label: 'speech-01-hd', hint: '上一代旗舰' },
  { id: 'speech-01-turbo', label: 'speech-01-turbo', hint: '上一代快版' },
]

/**
 * 火山引擎 大模型 voice catalog. The BV-prefixed ids are the public
 * preset voices for cluster=`volcano_tts`; if the user has activated
 * 声音复刻 they paste a custom voice_type instead.
 */
export const VOLCENGINE_PRESET_VOICES: PresetVoice[] = [
  { id: 'BV700_streaming', label: '灿灿（女）', hint: '大模型 · 默认推荐' },
  { id: 'BV701_streaming', label: '擎苍（男）', hint: '大模型 · 沉稳' },
  { id: 'BV705_streaming', label: '炀炀（女）', hint: '大模型 · 偏温柔' },
  { id: 'BV001_streaming', label: '通用女声', hint: '标准音色' },
  { id: 'BV002_streaming', label: '通用男声', hint: '标准音色' },
  { id: 'BV406_streaming', label: '解说小帅（男）', hint: '解说 / 视频' },
  { id: 'BV407_streaming', label: '解说小美（女）', hint: '解说 / 视频' },
  { id: 'BV503_streaming', label: '阳光男声' },
  { id: 'BV504_streaming', label: '温柔女声' },
]

export const VOLCENGINE_CLUSTERS: { id: string; label: string; hint?: string }[] = [
  { id: 'volcano_tts', label: 'volcano_tts', hint: '通用 · 大模型音色都走这个' },
  { id: 'volcano_icl', label: 'volcano_icl', hint: '声音复刻（实时克隆）' },
]
