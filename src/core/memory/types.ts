/**
 * Cross-platform memory types — no Node / Electron / native imports.
 * Safe to consume from renderer, Node, browser, Capacitor, etc.
 */

export type Speaker = 'user' | 'assistant'

export interface Episode {
  id: number
  ts: string
  speaker: Speaker
  text: string
  sessionId: string | null
}

/** Per-session summary for the Memory tab session picker. */
export interface SessionSummary {
  /** Session id, opaque to the user. */
  id: string
  /** First user message in the session, truncated. Empty if none. */
  preview: string
  /** ISO 8601 of the first episode in the session. */
  startTs: string
  /** ISO 8601 of the last episode. */
  lastTs: string
  /** How many episodes belong to this session. */
  count: number
}
