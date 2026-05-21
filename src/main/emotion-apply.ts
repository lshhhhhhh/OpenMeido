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
  const expr = sidecar.emotionMapping?.[emotion]
  if (expr) {
    deps.send({ type: 'setExpression', name: expr })
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
