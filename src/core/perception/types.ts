/**
 * Cross-platform types for the proactive observer. Triggers and config
 * shapes — no Node / Electron imports.
 */

export type TriggerKind = 'timer' | 'idle' | 'startup'

export interface Trigger {
  kind: TriggerKind
  /** ISO 8601 of when the trigger fired (NOT when the eval finishes). */
  at: string
  /** Free-form context the LLM should see — e.g. "idle 12m" or "30 min since last reply". */
  note: string
}

export interface ProactiveDecision {
  /** Whether the LLM thinks it's appropriate to interrupt. */
  shouldSpeak: boolean
  /** Internal reasoning (for logs, not shown to user). */
  reason: string
  /** What the model wants to say. Empty when shouldSpeak=false. */
  comment: string
}
