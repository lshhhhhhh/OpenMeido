/**
 * Cross-platform mail types — no Node / Electron / native imports.
 * Same boundary discipline as core/memory/types.ts.
 */

/** Cheap header-only summary, what listInbox returns. */
export interface MailSummary {
  /** Stable server-side id (IMAP UID, Gmail message id, etc.). */
  id: string
  from: string
  subject: string
  /** First ~200 chars of plain-text body, for the model to triage. */
  snippet: string
  /** ISO 8601 timestamp the server reports the message arrived. */
  ts: string
  unread: boolean
}

/** Full message body. readMessage returns this. */
export interface MailMessage {
  id: string
  from: string
  to: string[]
  subject: string
  /** Plain-text body. HTML is stripped by the adapter, not by the LLM. */
  body: string
  ts: string
  unread: boolean
  /**
   * Attachments are listed by name only in v1 — we don't read their contents.
   * Avoids the LLM seeing 50MB PDFs in its context.
   */
  attachments: { filename: string; sizeBytes: number; mimeType: string }[]
}

export interface ListInboxOptions {
  /** Hard cap on rows returned. Adapter will refuse > 50 to keep tool latency sane. */
  limit: number
  /** If true, only messages with the \Seen flag missing. */
  onlyUnread?: boolean
}
