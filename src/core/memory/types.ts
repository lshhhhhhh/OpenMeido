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

/**
 * L3 fact — LLM-distilled stable knowledge about the user. Lives in its
 * own table so we can inject the full set into every system prompt cheaply,
 * without vector retrieval. Mutable: when a new fact contradicts an old
 * one (same key), the new row supersedes the old via `supersededBy`.
 */
export interface Fact {
  id: number
  key: string
  value: string
  confidence: number
  createdAt: string
  updatedAt: string
  /** JSON array of episode ids this fact was distilled from. */
  sourceEpisodeIds: number[]
  /** If set, this fact has been superseded by fact with this id (i.e. inactive). */
  supersededBy: number | null
}

export interface NewFact {
  key: string
  value: string
  confidence?: number
  sourceEpisodeIds?: number[]
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
