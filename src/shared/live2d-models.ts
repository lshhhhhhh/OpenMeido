/**
 * Live2D model registry shared types.
 *
 * One model = one directory under `<userData>/live2d-models/<name>/` containing:
 *   - the Cubism 4 model files (model3.json, moc3, textures, expressions, motions)
 *   - an `openmeido.json` sidecar (auto-generated on first scan; user-editable)
 *
 * The sidecar carries everything OpenMeido needs that the Cubism files don't —
 * the emotion → expression / motion mapping, lip-sync param, fit mode. This
 * mirrors imouto-oss's `imouto.yaml` sidecar so a model folder shaped for that
 * project can be hand-converted or auto-migrated to this format.
 */

/**
 * Canonical emotion vocabulary the LLM picks from. Matches imouto-oss exactly
 * so prompts and personas remain portable. Each model's sidecar maps these to
 * the actual expression / motion names defined by the model.
 *
 * Order is the same as imouto-oss to keep UI rows / persona prompt examples
 * lined up visually if you compare side-by-side.
 */
export const EMOTIONS = [
  '开心',
  '害羞',
  '无语',
  '难过',
  '慌张',
  '震惊',
  '尴尬',
  '得意',
] as const

export type Emotion = (typeof EMOTIONS)[number]

/** A reference to a Cubism motion file by group + index inside the model3.json. */
export interface MotionRef {
  group: string
  index: number
}

/**
 * Per-model sidecar. Each field is optional — sane defaults apply when omitted.
 * The host writes this file as JSON next to the model3.json (filename
 * `openmeido.json`).
 *
 * `emotionMapping` and `motionMapping` are alternatives: when an emotion key
 * exists in `emotionMapping`, OpenMeido triggers `setExpression(<name>)`.
 * When it only exists in `motionMapping`, it triggers `startMotion(group, index)`.
 * Models that have neither expressions nor matching motions stay neutral.
 */
export interface ModelSidecar {
  /** Basename of the Cubism model3.json (e.g. "海兔1.model3.json"). */
  modelFile: string
  /** UI fit. Defaults to 'portrait' which matches the OpenMeido window. */
  fitMode?: 'portrait' | 'cover' | 'contain'
  /**
   * Cubism parameter name driven by the TTS RMS amplitude for lip-sync.
   * Default 'ParamMouthOpenY' covers >90% of community-made Cubism 4 models.
   */
  lipSyncParam?: string
  /** Emotion → expression name (as defined by *.exp3.json files in the model). */
  emotionMapping?: Partial<Record<Emotion, string>>
  /** Emotion → motion group + index (alternative for models with no expressions). */
  motionMapping?: Partial<Record<Emotion, MotionRef>>
}

/** What `live2d:listModels` returns: enough for the picker UI to render. */
export interface ModelListEntry {
  /** Directory name under live2d-models/. Stable id used as `live2d.activeModel`. */
  name: string
  /** The sidecar contents (defaults filled in by the host when absent on disk). */
  sidecar: ModelSidecar
  /** Counts so the picker can show "12 expressions, 4 motions". */
  expressionCount: number
  /** Sum across all motion groups. */
  motionCount: number
  /** Names from *.exp3.json files — feeds the emotion mapping dropdown. */
  expressionNames: string[]
  /** Motion groups parsed from the model3.json. */
  motionGroups: { group: string; count: number }[]
}
