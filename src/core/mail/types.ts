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
  /**
   * RFC 5322 In-Reply-To: the parent message's Message-Id, or undefined
   * for thread roots. Surfaces so the model can correlate items even when
   * the parent body isn't included (e.g. parent was not in Sent).
   */
  inReplyTo?: string
  /**
   * email-with-context: when THIS message is a reply AND we found the
   * parent in the user's Sent folder, this carries the parent's summary
   * (same shape, but never recursive — only one level up). Lets the model
   * produce paired "they said / you had said" summaries from a single
   * listRecentEmails call. `null` means "we looked and didn't find";
   * `undefined` means "this isn't a reply / didn't look".
   */
  parent?: Omit<MailSummary, 'parent'> | null
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
  /**
   * RFC 5322 Message-Id of this email. Stable across mailboxes (unlike UID),
   * so it's what we use to walk reply chains. May be missing for poorly-
   * formed messages.
   */
  messageId?: string
  /**
   * Message-Id of the immediate parent in the reply chain — the message
   * THIS email is replying to. From the `In-Reply-To` header. Missing for
   * thread roots (the first message in a conversation).
   */
  inReplyTo?: string
  /**
   * When THIS message is a reply (has inReplyTo) AND we successfully located
   * its parent on the server (typically in the user's Sent folder), this is
   * the parent's full content. Walked one level only — for deeper history,
   * the model can call readEmail(parent.id) to recurse.
   * `null` (vs undefined) means "we tried and didn't find it" — the parent
   * may have been deleted, archived elsewhere, or never stored locally.
   */
  parent?: MailMessage | null
}

export interface ListInboxOptions {
  /** Hard cap on rows returned. Adapter will refuse > 50 to keep tool latency sane. */
  limit: number
  /** If true, only messages with the \Seen flag missing. */
  onlyUnread?: boolean
  /**
   * email-with-context: when true, reply items get their parent attached
   * from the Sent folder. Adds ~500-2000ms per reply since each lookup
   * is an extra IMAP search + envelope fetch on the Sent mailbox, run
   * SEQUENTIALLY. **Default false** (was true historically — measured to
   * be the dominant cost on summary requests). Callers that genuinely
   * need paired "they said / you had said" context (e.g. "回复这封信，
   * 我之前怎么说的来着") set this true explicitly.
   */
  includeParents?: boolean
  /**
   * IMAP folder to read from. Empty / undefined → INBOX. Must be a real
   * path returned by listFolders() — adapters validate and reject
   * unknown names rather than silently falling back, because user-facing
   * folder names (e.g. "工作") need an explicit lookup step.
   */
  folder?: string
}

/** Result of listFolders() — minimal info the model needs to pick one. */
export interface MailFolder {
  /** IMAP path the server uses, exactly as it must be passed to listInbox. */
  path: string
  /** Human-readable display name (last path segment, decoded from
   *  modified-UTF7 when relevant). For Gmail this matches `path` minus
   *  the `[Gmail]/` prefix; for 163 / Outlook / etc. it's the leaf. */
  name: string
  /** True for INBOX. Helps the model decide when it's looking at the
   *  default vs a user-created folder. */
  isInbox: boolean
  /** True when the IMAP server flags this as a special-use folder
   *  (\Sent, \Drafts, \Junk, \Trash, \Archive, \All). Most user-created
   *  folders are false. */
  isSpecialUse: boolean
}
