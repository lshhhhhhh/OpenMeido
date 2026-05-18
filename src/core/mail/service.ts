/**
 * MailService — thin façade over a MailAdapter that the chat tools consume.
 *
 * Keeping the surface narrow (list + read) for v1. Search, compose, reply,
 * star, labels all live in v2 behind their own service methods.
 *
 * Pure core code; the Electron host wires up the IMAP adapter in
 * src/main/mail-host.ts.
 */

import type { MailAdapter } from './adapter.js'
import type { MailMessage, MailSummary, ListInboxOptions } from './types.js'

export interface MailService {
  listInbox(opts: ListInboxOptions): Promise<MailSummary[]>
  readMessage(id: string): Promise<MailMessage | null>
  testConnection(): Promise<{ ok: true } | { ok: false; error: string }>
}

export function createMailService(adapter: MailAdapter): MailService {
  return {
    listInbox(opts) {
      // Hard cap so a runaway "give me ALL emails" tool call doesn't grind
      // the IMAP server or blow the model's context window.
      const limit = Math.max(1, Math.min(50, opts.limit))
      return adapter.listInbox({ ...opts, limit })
    },

    readMessage(id) {
      return adapter.readMessage(id)
    },

    testConnection() {
      return adapter.testConnection()
    },
  }
}
