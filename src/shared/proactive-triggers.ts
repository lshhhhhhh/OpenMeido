/**
 * Pure trigger evaluation for the proactive engine.
 *
 * The host (src/main/proactive-host.ts) reads Electron's powerMonitor for
 * idle time and tracks `lastAssistantAt` / `idleArmed` in module state,
 * then hands those values here. Keeping the math pure lets us unit-test
 * the cadence-vs-state interaction without an Electron runtime.
 */

import type { ProactiveCadence } from './proactive-cadence.js'
import type { Trigger } from '../core/perception/types.js'

export interface TriggerEvalInput {
  /** Cadence resolved by cadenceFor(mode, tier). */
  cadence: ProactiveCadence
  /** Seconds since last user input (powerMonitor.getSystemIdleTime). */
  idleSec: number
  /** Latch: false after one idle trigger fires, until any user activity rearms. */
  idleArmed: boolean
  /** Seconds since the assistant's last remark (proactive or user-driven). */
  sinceAssistantSec: number
  /** Optional ISO timestamp to stamp triggers with. Defaults to current time. */
  nowISO?: string
}

/**
 * Pure: produce the trigger list that the engine should react to this
 * tick. Empty list ⇔ no trigger fires; the host bails before any LLM
 * call. Two trigger kinds are recognized:
 *
 *   - idle:  system idle ≥ cadence.idleThresholdSec AND idle latch armed.
 *   - timer: ≥ cadence.timerSec elapsed since last assistant remark.
 *
 * Both can fire in the same tick (idle wins precedence when both match,
 * but the consumer treats the list as unordered).
 */
export function evaluateTriggers(input: TriggerEvalInput): Trigger[] {
  const triggers: Trigger[] = []
  const at = input.nowISO ?? new Date().toISOString()

  if (input.idleArmed && input.idleSec >= input.cadence.idleThresholdSec) {
    triggers.push({
      kind: 'idle',
      at,
      note: `用户已经 ${Math.floor(input.idleSec / 60)} 分钟没有任何输入`,
    })
  }

  if (input.sinceAssistantSec >= input.cadence.timerSec) {
    triggers.push({
      kind: 'timer',
      at,
      note: `距离你上一句已经 ${Math.floor(input.sinceAssistantSec / 60)} 分钟`,
    })
  }

  return triggers
}
