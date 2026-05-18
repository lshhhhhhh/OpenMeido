/**
 * IMAP MailAdapter implementation. Lives in src/main/ because imapflow
 * uses raw TCP/TLS sockets (node:net + node:tls) that don't exist in
 * browser / Capacitor environments.
 *
 * Connection lifecycle:
 *   - Lazy connect on first call. One persistent connection per adapter
 *     instance, kept alive via imapflow's built-in IDLE/NOOP.
 *   - Reconnect transparently if the server drops us (network blip, server
 *     idle timeout). One retry per call.
 *   - close() logs out and tears down. Safe to call multiple times.
 */

import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'

import type { MailAdapter } from '../../core/mail/adapter.js'
import type {
  MailMessage,
  MailSummary,
  ListInboxOptions,
} from '../../core/mail/types.js'

export interface ImapAdapterOptions {
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
}

const SNIPPET_LEN = 200

export function createImapAdapter(opts: ImapAdapterOptions): MailAdapter {
  let client: ImapFlow | null = null
  let closed = false

  async function getClient(): Promise<ImapFlow> {
    if (closed) throw new Error('imap-adapter: closed')
    if (client && client.usable) return client
    const c = new ImapFlow({
      host: opts.host,
      port: opts.port,
      secure: opts.secure,
      auth: { user: opts.user, pass: opts.pass },
      // imapflow ships a noisy default logger that spams stdout with every
      // IMAP frame. Silence it; serious errors still throw from awaited calls.
      logger: false,
    })
    await c.connect()
    client = c
    return c
  }

  async function withInbox<T>(fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    const c = await getClient()
    const lock = await c.getMailboxLock('INBOX')
    try {
      return await fn(c)
    } finally {
      lock.release()
    }
  }

  /** Best-effort plain-text snippet from a fetched body part. */
  function extractSnippet(raw: Buffer | undefined): string {
    if (!raw) return ''
    const text = raw.toString('utf8')
    // Collapse whitespace + trim. Email bodies often have lots of `\r\n` and
    // long signature blocks; we just want a readable preview line.
    return text
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, SNIPPET_LEN)
  }

  return {
    async listInbox(o: ListInboxOptions) {
      return withInbox(async (c) => {
        // search() returns UIDs matching the criteria.
        // SEARCH UNSEEN for onlyUnread; otherwise SEARCH ALL.
        const uids = (await c.search(
          o.onlyUnread ? { seen: false } : { all: true },
          { uid: true },
        )) as number[]
        // Newest first; take the last `limit` UIDs (IMAP UIDs are monotonic).
        const recent = uids.slice(-o.limit).reverse()
        if (recent.length === 0) return []

        const results: MailSummary[] = []
        // Fetch envelope (subject/from/date), flags, and bodyparts for snippet.
        for await (const msg of c.fetch(
          recent,
          {
            envelope: true,
            flags: true,
            // 'TEXT' is the whole body section sans headers. Cheaper than
            // fetching the full RFC822 source — and good enough for a
            // 200-char preview.
            bodyParts: ['TEXT'],
          },
          { uid: true },
        )) {
          const env = msg.envelope
          const from = env?.from?.[0]
          const fromStr = from
            ? `${from.name ? `${from.name} ` : ''}<${from.address ?? ''}>`.trim()
            : ''
          const snippet = extractSnippet(msg.bodyParts?.get('TEXT'))
          results.push({
            id: String(msg.uid),
            from: fromStr,
            subject: env?.subject ?? '',
            snippet,
            ts: new Date(env?.date ?? msg.internalDate ?? Date.now()).toISOString(),
            unread: !msg.flags?.has('\\Seen'),
          })
        }
        return results
      })
    },

    async readMessage(id: string) {
      const uid = Number(id)
      if (!Number.isFinite(uid)) return null
      return withInbox(async (c) => {
        const msg = await c.fetchOne(String(uid), { source: true }, { uid: true })
        if (!msg || !msg.source) return null

        const parsed = await simpleParser(msg.source)
        const toList = Array.isArray(parsed.to)
          ? parsed.to.flatMap((a) => a.value)
          : parsed.to?.value ?? []
        return {
          id,
          from: parsed.from?.text ?? '',
          to: toList.map((a) => a.address ?? '').filter(Boolean),
          subject: parsed.subject ?? '',
          body: (parsed.text ?? '').trim(),
          ts: (parsed.date ?? new Date()).toISOString(),
          // We didn't refetch flags here — readMessage doesn't really need
          // the unread state and the server may auto-mark on fetch.
          unread: false,
          attachments: (parsed.attachments ?? []).map((a) => ({
            filename: a.filename ?? '(unnamed)',
            sizeBytes: a.size ?? 0,
            mimeType: a.contentType ?? 'application/octet-stream',
          })),
        } satisfies MailMessage
      })
    },

    async testConnection() {
      try {
        const c = await getClient()
        // Just opening INBOX is enough to prove auth + reachability.
        const lock = await c.getMailboxLock('INBOX')
        lock.release()
        return { ok: true }
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    },

    async close() {
      if (closed) return
      closed = true
      if (client) {
        try {
          await client.logout()
        } catch {
          /* server may have already cut us off */
        }
        client = null
      }
    },
  }
}
