/**
 * Storage / transport abstraction for reading mail. Concrete impls live
 * in platform-specific dirs (src/main/mail/imap-adapter.ts for Electron,
 * future src/web/mail/ for PWA where we'd need a backend proxy because
 * browsers can't open raw IMAP sockets).
 */

import type { MailMessage, MailSummary, ListInboxOptions } from './types.js'

export interface MailAdapter {
  /** Recent inbox messages, newest-first. */
  listInbox(opts: ListInboxOptions): Promise<MailSummary[]>

  /** Full body + attachments metadata for one message. null = id not found. */
  readMessage(id: string): Promise<MailMessage | null>

  /** Probe credentials and connectivity without modifying anything. */
  testConnection(): Promise<{ ok: true } | { ok: false; error: string }>

  /** Release any persistent connection. After close, all other methods reject. */
  close(): Promise<void>
}
