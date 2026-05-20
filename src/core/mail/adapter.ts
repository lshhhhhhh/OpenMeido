/**
 * Storage / transport abstraction for reading mail. Concrete impls live
 * in platform-specific dirs (src/main/mail/imap-adapter.ts for Electron,
 * future src/web/mail/ for PWA where we'd need a backend proxy because
 * browsers can't open raw IMAP sockets).
 */

import type { MailMessage, MailSummary, ListInboxOptions, MailFolder } from './types.js'

export interface MailAdapter {
  /** Recent inbox messages, newest-first. */
  listInbox(opts: ListInboxOptions): Promise<MailSummary[]>

  /** Full body + attachments metadata for one message. null = id not found. */
  readMessage(id: string): Promise<MailMessage | null>

  /**
   * Enumerate the user's IMAP folders. Used by the model to resolve
   * user-facing folder references ("工作文件夹") to the real IMAP path
   * that listInbox needs. Returned newest-first by activity isn't
   * meaningful for folder listings; we just return them in the order
   * the server reports.
   */
  listFolders(): Promise<MailFolder[]>

  /** Probe credentials and connectivity without modifying anything. */
  testConnection(): Promise<{ ok: true } | { ok: false; error: string }>

  /** Release any persistent connection. After close, all other methods reject. */
  close(): Promise<void>
}
