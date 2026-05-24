/**
 * Resolve an emotion label to a Live2D command + activity event.
 *
 * Lives in its own file (separate from emotion-classifier.ts) so that
 * unit tests can `import { applyEmotion }` without pulling in any
 * electron-touching modules transitively (config.ts → BrowserWindow,
 * live2d-host.ts → BrowserWindow). All deps are required and explicit;
 * the caller (production code in emotion-classifier.ts) wires the real
 * implementations, tests wire spies.
 *
 * The logic itself is the same as the old setLive2DExpression tool:
 *   - emotionMapping[emotion]       → setExpression(name)
 *   - else motionMapping[emotion]   → playMotion(group, index)
 *   - else (and for null emotion)   → setExpression(null)  (no event)
 *
 * Only triggered actions get logged. Clearing the face / unmapped /
 * missing-sidecar cases are silent in the activity feed — nothing
 * visible happened, so there's nothing to surface.
 */

import type { Emotion, ModelSidecar } from '../shared/live2d-models.js'
// Type-only imports — erased at runtime, no electron transitive load.
import type { Live2DCommand } from './live2d-host.js'
import type { EmotionEvent } from './emotion-events.js'

export interface ApplyEmotionDeps {
  send: (cmd: Live2DCommand) => void
  pushEvent: (e: EmotionEvent) => void
  sidecarFor: (modelName: string) => Promise<ModelSidecar | null>
  modelName: string
  /** Length of the assistant text this expression accompanies, in
   *  characters. Used to size the auto-decay so a short reply doesn't
   *  hold the face for 8s and a long monologue doesn't snap clear
   *  mid-sentence. Omit to fall back to the stage's default decay. */
  textLength?: number
}

/**
 * Pace heuristic: Chinese TTS at maid/imouto persona warmth runs about
 * 4.5 chars/sec → ~220ms per char. Add a 1.5s tail buffer so the face
 * doesn't snap to neutral the instant the last syllable ends. Clamped
 * to a sensible range so a single-emoji reply still registers and a
 * 500-char essay doesn't lock the face for 2 minutes.
 */
const MS_PER_CHAR = 220
const TAIL_BUFFER_MS = 1500
const MIN_DECAY_MS = 3000
const MAX_DECAY_MS = 25_000

export function decayMsForTextLength(len: number): number {
  const raw = len * MS_PER_CHAR + TAIL_BUFFER_MS
  return Math.max(MIN_DECAY_MS, Math.min(MAX_DECAY_MS, raw))
}

export async function applyEmotion(
  emotion: Emotion | null,
  deps: ApplyEmotionDeps,
): Promise<void> {
  if (!emotion) {
    deps.send({ type: 'setExpression', name: null })
    return
  }
  const sidecar = await deps.sidecarFor(deps.modelName)
  if (!sidecar) {
    deps.send({ type: 'setExpression', name: null })
    return
  }
  const decayMs =
    deps.textLength !== undefined ? decayMsForTextLength(deps.textLength) : undefined
  const expr = sidecar.emotionMapping?.[emotion]
  if (expr) {
    deps.send({ type: 'setExpression', name: expr, decayMs })
    deps.pushEvent({
      ts: new Date().toISOString(),
      emotion,
      kind: 'expression',
      target: expr,
    })
    return
  }
  const motion = sidecar.motionMapping?.[emotion]
  if (motion) {
    deps.send({ type: 'playMotion', group: motion.group, index: motion.index })
    deps.pushEvent({
      ts: new Date().toISOString(),
      emotion,
      kind: 'motion',
      target: `${motion.group}[${motion.index ?? 0}]`,
    })
    return
  }
  // Mapped vocabulary but this specific model has no entry — clear so
  // we don't lie with stale state. Not logged.
  deps.send({ type: 'setExpression', name: null })
}
