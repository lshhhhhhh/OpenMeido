/**
 * Emotion classifier — picks a Live2D expression for every assistant reply
 * via a separate lightweight LLM call (NOT a tool in the main chat loop).
 *
 * Why a separate call rather than a tool:
 *   - The main chat prompt stays focused on tools/replies. Emotion logic
 *     doesn't bloat it.
 *   - The tool was optional, so most replies ended with whatever face was
 *     held from a previous turn. With this classifier, every reply gets
 *     a fresh face — no stale state.
 *   - Routes through the configured backend's LIGHTWEIGHT tier (see
 *     shared/lightweight-models.ts), so per-reply cost is minimal.
 *   - Easy to swap models, throttle, or upgrade to mid-stream
 *     classification later without touching chat.ts.
 *
 * Failure modes:
 *   - Empty / very short text → skip (no point classifying "嗯").
 *   - LLM call errors / times out → log and bail (face stays as it was).
 *   - Output isn't in the label set → treated as 中性 (no expression).
 */

import { runExtraction } from './chat-host.js'
import { broadcastLive2D } from './live2d-host.js'
import { getConfig } from './config.js'
import { resolvePersona } from '../shared/config.js'
import { getSidecar as live2dGetSidecar } from './live2d-models-host.js'
import { EMOTIONS, type Emotion } from '../shared/live2d-models.js'
import { buildEmotionPrompt } from '../shared/daily-prompts.js'

/** Below this length we assume the reply is too short to carry useful
 *  emotion signal (e.g., "嗯", "好的"). Skip the round-trip. */
const MIN_TEXT_LEN_FOR_CLASSIFICATION = 6

/**
 * Public entry — call after the chat stream finishes with the final reply
 * text. Fire-and-forget; errors are swallowed (logged only).
 */
export async function classifyAndApplyEmotion(text: string): Promise<void> {
  const trimmed = text.trim()
  if (trimmed.length < MIN_TEXT_LEN_FOR_CLASSIFICATION) return

  const cfg = getConfig()
  const persona = resolvePersona(cfg.persona)
  let raw: string
  try {
    raw = await runExtraction(
      buildEmotionPrompt({ text: trimmed, persona, validLabels: EMOTIONS }),
    )
  } catch (err) {
    console.warn('[emotion] classifier LLM call failed:', err)
    return
  }
  const label = parseEmotionLabel(raw)
  await applyEmotion(label)
}

/**
 * Pull a clean label out of the model's response. Tolerates extra
 * whitespace, surrounding quotes, trailing punctuation. Unknown
 * outputs → null (= 中性, clear any held expression).
 */
function parseEmotionLabel(raw: string): Emotion | null {
  const stripped = raw
    .trim()
    .replace(/^["'「『]+|["'」』]+$/g, '')
    .replace(/[.。!！?？:：,，]+$/g, '')
    .trim()
  if (!stripped) return null
  if ((EMOTIONS as readonly string[]).includes(stripped)) {
    return stripped as Emotion
  }
  // Model sometimes returns the label inside a sentence ("情绪：开心").
  // Last-ditch substring scan.
  for (const e of EMOTIONS) {
    if (stripped.includes(e)) return e
  }
  return null
}

/**
 * Resolve `emotion` against the active Live2D model's sidecar mapping and
 * broadcast the corresponding expression / motion. `null` means neutral —
 * clear any held expression.
 *
 * Same lookup logic the old setLive2DExpression tool used; lifted here so
 * the chat loop no longer needs the tool at all.
 */
async function applyEmotion(emotion: Emotion | null): Promise<void> {
  if (!emotion) {
    broadcastLive2D({ type: 'setExpression', name: null })
    return
  }
  const cfg = getConfig()
  const sidecar = await live2dGetSidecar(cfg.live2d.activeModel)
  if (!sidecar) {
    broadcastLive2D({ type: 'setExpression', name: null })
    return
  }
  const expr = sidecar.emotionMapping?.[emotion]
  if (expr) {
    broadcastLive2D({ type: 'setExpression', name: expr })
    return
  }
  const motion = sidecar.motionMapping?.[emotion]
  if (motion) {
    broadcastLive2D({ type: 'playMotion', group: motion.group, index: motion.index })
    return
  }
  // Emotion known but model doesn't have a mapping for it — clear so we
  // don't lie with stale state.
  broadcastLive2D({ type: 'setExpression', name: null })
}

/** Exported for tests. */
export const __testing = { parseEmotionLabel }
