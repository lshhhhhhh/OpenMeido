/**
 * Cross-platform memory types — no Node / Electron / native imports.
 * Safe to consume from renderer, Node, browser, Capacitor, etc.
 */

/**
 * Three speaker types matching the LLM provider's message roles:
 *   user      — input from the human user.
 *   assistant — LLM-generated reply. May contain BOTH text AND tool calls
 *               in the same turn (the LLM emits them together).
 *   tool      — tool execution result. Always pairs with a preceding
 *               assistant message that contained matching tool_call(s).
 *
 * Persisting all three lets us replay a complete agent loop's context
 * across user turns. Previously we only persisted user/assistant text,
 * so the ids returned by `listRecentEmails` died after that turn ended
 * and `readEmail` calls in later turns had no real id to use.
 */
export type Speaker = 'user' | 'assistant' | 'tool'

/**
 * Tool call emitted by the LLM in an assistant turn. Pairs with a
 * ToolResultPart on the matching tool message via toolCallId.
 */
export interface ToolCallPart {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  /** Whatever Zod-validated args the model produced. */
  input: unknown
}

/**
 * Tool execution result emitted on the tool message. toolCallId links it
 * back to its triggering ToolCallPart.
 */
export interface ToolResultPart {
  type: 'tool-result'
  toolCallId: string
  toolName: string
  output: unknown
}

export interface Episode {
  id: number
  ts: string
  speaker: Speaker
  text: string
  sessionId: string | null
  /**
   * Speaker-dependent extras:
   *   assistant rows may have ToolCallPart[] (the calls this turn emitted).
   *   tool rows always have ToolResultPart[] (the results being returned).
   *   user rows never have this.
   * Stored as JSON in sqlite; null on disk when absent.
   */
  toolParts?: (ToolCallPart | ToolResultPart)[]
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
