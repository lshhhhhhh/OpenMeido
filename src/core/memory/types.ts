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

export interface EpisodeImage {
  /** MIME type, e.g. "image/png" / "image/jpeg". */
  mimeType: string
  /** Raw base64 (no `data:` prefix). */
  base64: string
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
  /**
   * Images attached to a user turn (screenshots, pasted images). Stored
   * as JSON in sqlite. Persisted so the AI can keep "seeing" them in
   * follow-up turns about the same image — without this, conversations
   * about a screenshot devolve into the model hallucinating from its
   * own turn-1 description.
   *
   * Replay is bounded by `cfg.memory.imageRecallTurns` (default 3) so
   * long sessions don't pay token cost on images from days ago.
   */
  images?: EpisodeImage[]
}

/**
 * Fact category — two parallel memory tracks that share a table but
 * never mix in extraction or UI surfacing.
 *
 *   'personal' — relationship-line memory: name, pets, hobbies, family,
 *                anything about the user's life that persists for months
 *                or years. Reflected from conversational episodes.
 *                Surfaced in Settings → 人物 → 记忆.
 *
 *   'work'     — productivity-line memory: project codes, ticket status,
 *                recent email topics. Reflected from tool-using episodes.
 *                Stale within days/weeks. Injected into chat context for
 *                continuity (so the user can ask "any update on Project-A1?"
 *                next day) but NOT shown in the memory UI to avoid the
 *                stale-data trap.
 */
export type FactCategory = 'personal' | 'work'

/**
 * L3 fact — LLM-distilled stable knowledge about the user. Lives in its
 * own table so we can inject the full set into every system prompt cheaply,
 * without vector retrieval. Mutable: when a new fact contradicts an old
 * one (same key + category), the new row supersedes the old via `supersededBy`.
 */
export interface Fact {
  id: number
  key: string
  value: string
  confidence: number
  createdAt: string
  updatedAt: string
  category: FactCategory
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
