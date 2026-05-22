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
  MailFolder,
} from '../../core/mail/types.js'

export interface ImapAdapterOptions {
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
}

const SNIPPET_LEN = 200

/**
 * Pull the first parent Message-Id out of an `In-Reply-To` header value.
 * mailparser returns it as:
 *   - a string `"<abc@x.com>"` for the common single-parent case
 *   - a space-joined string for multi-parent threads (RFC 5322 allows it)
 *   - an array in some rare paths
 * We always return the first id so reply-chain walking is single-track.
 * Tested by tools/smoke-mail-parent.mjs.
 */
function normalizeInReplyTo(raw: unknown): string | undefined {
  if (Array.isArray(raw)) return typeof raw[0] === 'string' ? raw[0] : undefined
  if (typeof raw !== 'string') return undefined
  const ids = raw.match(/<[^>]+>/g)
  if (ids && ids.length > 0) return ids[0]
  return raw
}

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
    return withFolder('INBOX', fn)
  }

  /** Same as withInbox but for any folder path the user has. Lock + run
   *  + release. Throws cleanly if the folder doesn't exist on the server. */
  async function withFolder<T>(
    folderPath: string,
    fn: (c: ImapFlow) => Promise<T>,
  ): Promise<T> {
    const c = await getClient()
    const lock = await c.getMailboxLock(folderPath)
    try {
      return await fn(c)
    } finally {
      lock.release()
    }
  }

  /**
   * Extract a clean plain-text snippet from a fetched RFC822 source
   * (full or partial). Defers all MIME work — multipart boundaries,
   * Content-Transfer-Encoding, charset, HTML entities — to
   * `mailparser.simpleParser`, which is already a project dep and
   * already used by the full-message read path. Returns at most
   * `SNIPPET_LEN` characters of whitespace-collapsed plaintext.
   *
   * Partial source: imapflow's `source: { maxLength: N }` returns the
   * first N bytes of RFC822 source. simpleParser is forgiving of
   * truncation — it parses the headers + whatever body it has and
   * exposes `text` for the plain-text part it found. Truncation in
   * the middle of base64 / qp typically yields a slightly clipped
   * `text`, which is fine for a 200-char snippet.
   *
   * If simpleParser fails (extremely malformed source, or the chunk
   * is too small to contain any usable body), returns `''` — caller's
   * UI just shows the subject + date and an empty snippet, which is
   * far better than leaking raw MIME bytes to the LLM.
   */
  async function extractSnippet(source: Buffer | undefined): Promise<string> {
    if (!source || source.length === 0) return ''
    try {
      const parsed = await simpleParser(source, {
        // Don't waste cycles materializing attachment buffers — we only
        // want the body text for the snippet.
        skipImageLinks: true,
        skipHtmlToText: false,
      })
      // Prefer the plaintext part; fall back to HTML-derived text (mailparser
      // auto-converts unless skipHtmlToText is set) and finally to the raw
      // text/plain field (sometimes set on edge cases).
      const text = (parsed.text ?? '').trim()
      if (text) return text.replace(/\s+/g, ' ').slice(0, SNIPPET_LEN)
      return ''
    } catch (err) {
      // Truncated source mid-MIME-structure can throw on rare inputs.
      // Empty snippet is the safest fallback — the LLM will work off
      // the subject line instead of choking on raw bytes.
      console.warn('[imap] extractSnippet failed:', err)
      return ''
    }
  }

  /**
   * Locate the user's Sent mailbox. Different servers name it differently
   * ("Sent", "Sent Items", "[Gmail]/Sent Mail", "已发送邮件", ...) so we
   * prefer the IMAP SPECIAL-USE attribute `\Sent` and fall back to a
   * case-insensitive name match. Returns null when no Sent box is found —
   * unusual but possible on minimal IMAP servers.
   */
  async function findSentMailbox(c: ImapFlow): Promise<string | null> {
    type Box = { path: string; name?: string; specialUse?: string }
    const list = (await c.list()) as Box[]
    const bySpecial = list.find((b) => b.specialUse === '\\Sent')
    if (bySpecial) return bySpecial.path
    const byName = list.find((b) => /^sent/i.test(b.name ?? '') || /sent[\s_-]?(items|mail)/i.test(b.path))
    return byName?.path ?? null
  }

  /**
   * Search the Sent mailbox for a message with the given RFC 5322
   * Message-Id (including the angle brackets) and return its UID, or null
   * if not found. Caller is responsible for the surrounding mailbox lock
   * lifecycle — we acquire and release our own here, so the caller must
   * NOT already hold a different mailbox lock.
   */
  async function findSentUidByMessageId(
    c: ImapFlow,
    messageId: string,
  ): Promise<number | null> {
    const sentPath = await findSentMailbox(c)
    if (!sentPath) return null
    const lock = await c.getMailboxLock(sentPath)
    try {
      const uids = (await c.search(
        // `header` search clauses are { name: value } in imapflow's typing.
        { header: { 'message-id': messageId } },
        { uid: true },
      )) as number[] | false
      if (!uids || uids.length === 0) return null
      // If a Message-Id appears multiple times (Bcc trick, copy-to-self,
      // reassigned id), prefer the most recent UID.
      return uids[uids.length - 1] ?? null
    } finally {
      lock.release()
    }
  }

  /**
   * Recursive readMessage that mirrors the public adapter signature but
   * decrements a depth budget as it walks up the reply chain. depth=1
   * fetches the message + its immediate parent; depth=0 fetches just the
   * message (used to prevent the parent's parent's... recursion).
   */
  async function readMessageWithDepth(
    id: string,
    depth: number,
  ): Promise<MailMessage | null> {
    const uid = Number(id)
    if (!Number.isFinite(uid)) return null

    // First leg: fetch + parse the requested message from INBOX. We release
    // the INBOX lock BEFORE looking at Sent because imapflow serializes
    // mailbox access per connection — holding INBOX while we ask for Sent
    // would deadlock.
    const main = await withInbox(async (c) => {
      const msg = await c.fetchOne(String(uid), { source: true }, { uid: true })
      if (!msg || !msg.source) return null
      const parsed = await simpleParser(msg.source)
      return parsed
    })
    if (!main) return null

    const parsed = main
    const toList = Array.isArray(parsed.to)
      ? parsed.to.flatMap((a) => a.value)
      : parsed.to?.value ?? []
    // mailparser variants for In-Reply-To:
    //   - single parent → string like "<abc@x.com>"
    //   - multi-parent (rare, RFC 5322 allows it) → space-joined string
    //     "<a@x.com> <b@x.com>" OR an array. Take the first id.
    const inReplyTo = normalizeInReplyTo(parsed.inReplyTo)

    const result: MailMessage = {
      id,
      from: parsed.from?.text ?? '',
      to: toList.map((a) => a.address ?? '').filter(Boolean),
      subject: parsed.subject ?? '',
      body: (parsed.text ?? '').trim(),
      ts: (parsed.date ?? new Date()).toISOString(),
      unread: false,
      attachments: (parsed.attachments ?? []).map((a) => ({
        filename: a.filename ?? '(unnamed)',
        sizeBytes: a.size ?? 0,
        mimeType: a.contentType ?? 'application/octet-stream',
      })),
      messageId: parsed.messageId,
      inReplyTo,
    }

    // Second leg: walk up one parent if this message is a reply and depth
    // allows. We restrict the parent search to the Sent folder because the
    // user's documented use case is "I got a reply, what did I say earlier?"
    // For inbound chains (someone else's reply to someone else) the parent
    // wouldn't be in Sent anyway. Failing silently is fine: parent stays
    // null and the model sees that the chain ends here.
    if (depth > 0 && inReplyTo) {
      try {
        const c = await getClient()
        const parentUid = await findSentUidByMessageId(c, inReplyTo)
        if (parentUid !== null) {
          // Fetch from Sent directly (NOT via withInbox).
          const sentPath = await findSentMailbox(c)
          if (sentPath) {
            const lock = await c.getMailboxLock(sentPath)
            try {
              const pmsg = await c.fetchOne(
                String(parentUid),
                { source: true },
                { uid: true },
              )
              if (pmsg && pmsg.source) {
                const pparsed = await simpleParser(pmsg.source)
                const pTo = Array.isArray(pparsed.to)
                  ? pparsed.to.flatMap((a) => a.value)
                  : pparsed.to?.value ?? []
                result.parent = {
                  id: `sent:${parentUid}`,
                  from: pparsed.from?.text ?? '',
                  to: pTo.map((a) => a.address ?? '').filter(Boolean),
                  subject: pparsed.subject ?? '',
                  body: (pparsed.text ?? '').trim(),
                  ts: (pparsed.date ?? new Date()).toISOString(),
                  unread: false,
                  attachments: (pparsed.attachments ?? []).map((a) => ({
                    filename: a.filename ?? '(unnamed)',
                    sizeBytes: a.size ?? 0,
                    mimeType: a.contentType ?? 'application/octet-stream',
                  })),
                  messageId: pparsed.messageId,
                  inReplyTo: normalizeInReplyTo(pparsed.inReplyTo),
                  // We deliberately don't recurse further — depth=1 fetches
                  // exactly one parent. The model can ask for grandparents
                  // by reading the parent.id explicitly.
                }
              }
            } finally {
              lock.release()
            }
          }
        } else {
          // We tried and didn't find it — surface null so the model knows
          // the chain is broken (vs missing inReplyTo entirely).
          result.parent = null
        }
      } catch {
        // Parent lookup is best-effort. Network blip / permission error
        // shouldn't fail the main read.
        result.parent = null
      }
    }

    return result
  }

  /**
   * Detect Gmail's IMAP server via the X-GM-EXT-1 capability. Other hosts
   * with the same domain (e.g., aliases) get caught too, which is what we
   * want — capability check is more reliable than host string matching.
   */
  function isGmail(c: ImapFlow): boolean {
    const caps = c.serverInfo?.capabilities
    if (!caps) return false
    // capabilities is a Set<string> in imapflow.
    return caps instanceof Set
      ? caps.has('X-GM-EXT-1')
      : Array.isArray(caps)
        ? (caps as string[]).includes('X-GM-EXT-1')
        : false
  }

  return {
    async listInbox(o: ListInboxOptions) {
      // Phase 1: read messages from the requested folder (default INBOX),
      // collect summaries + the In-Reply-To header on each so we know
      // which ones are replies.
      const folderPath = o.folder && o.folder.trim() ? o.folder : 'INBOX'
      const results = await withFolder(folderPath, async (c) => {
        // Gmail's category:primary filter only makes sense on the INBOX
        // virtual folder, not on user-labeled folders. Skip the filter
        // when reading anything other than INBOX.
        const gmail = isGmail(c) && folderPath === 'INBOX'
        const searchCriteria = gmail
          ? o.onlyUnread
            ? { seen: false, gmailRaw: 'category:primary' }
            : { gmailRaw: 'category:primary' }
          : o.onlyUnread
            ? { seen: false }
            : { all: true }
        const uids = (await c.search(
          searchCriteria as Parameters<typeof c.search>[0],
          { uid: true },
        )) as number[]
        const recent = uids.slice(-o.limit).reverse()
        if (recent.length === 0) return [] as MailSummary[]

        const out: MailSummary[] = []
        // **C. Partial source fetch.** Pre-2026-05 this fetched the full
        // body via `bodyParts: ['TEXT']` — 5KB+ per email × 10 emails
        // for a 200-char snippet. Then we tried `bodyParts: TEXT<0.8192>`
        // (BODY[TEXT] only, partial), but BODY[TEXT] strips the outer
        // Content-Type / boundary headers — without them simpleParser
        // can't reconstruct the multipart structure and we got back
        // raw MIME bytes in the snippet (the bug users hit).
        //
        // Current: partial `source` fetch — first 8KB of RFC822 source,
        // which IS the top-level headers + start of body. simpleParser
        // gets the multipart boundary + Content-Type from the outer
        // envelope and correctly extracts plaintext. ~6-8KB per email
        // × 10 = ~80KB total, still cheap vs the LLM round-trip cost.
        for await (const msg of c.fetch(
          recent,
          {
            envelope: true,
            flags: true,
            source: { start: 0, maxLength: 8192 },
            // Pull these two headers so we can correlate replies → parents
            // without re-fetching. Cheap (one extra RFC822 line each).
            headers: ['in-reply-to'],
          },
          { uid: true },
        )) {
          const env = msg.envelope
          const from = env?.from?.[0]
          const fromStr = from
            ? `${from.name ? `${from.name} ` : ''}<${from.address ?? ''}>`.trim()
            : ''
          const snippet = await extractSnippet(msg.source)
          // headers in imapflow comes back as a Buffer of the raw RFC822
          // lines. We parse out In-Reply-To with a regex; full-fledged
          // header parsing is overkill for a single line.
          let inReplyTo: string | undefined
          const headersBuf = msg.headers as Buffer | undefined
          if (headersBuf) {
            const headerText = headersBuf.toString('utf8')
            const m = /^in-reply-to:\s*(.+)$/im.exec(headerText)
            if (m && m[1]) inReplyTo = normalizeInReplyTo(m[1].trim())
          }
          out.push({
            id: String(msg.uid),
            from: fromStr,
            subject: env?.subject ?? '',
            snippet,
            ts: new Date(env?.date ?? msg.internalDate ?? Date.now()).toISOString(),
            unread: !msg.flags?.has('\\Seen'),
            inReplyTo,
          })
        }
        return out
      })

      // Phase 2 (email-with-context): look up each reply's parent in Sent.
      // Default OFF (changed 2026-05): per-reply Sent search was the
      // dominant cost on "总结 10 封邮件" — 500ms-2s per reply, run
      // serially. Most table / summary use cases don't need paired
      // "they said / I had said" context — the snippet alone is enough.
      // Callers explicitly opt in (`includeParents: true`) when paired
      // context actually matters (e.g. drafting a reply).
      if (results.length === 0 || o.includeParents !== true) return results
      const needsParent = results.filter((r) => r.inReplyTo)
      if (needsParent.length === 0) return results
      try {
        const c = await getClient()
        const sentPath = await findSentMailbox(c)
        if (!sentPath) return results
        const lock = await c.getMailboxLock(sentPath)
        try {
          for (const item of needsParent) {
            try {
              const messageId = item.inReplyTo
              if (!messageId) continue
              const uids = (await c.search(
                { header: { 'message-id': messageId } },
                { uid: true },
              )) as number[] | false
              if (!uids || uids.length === 0) {
                item.parent = null
                continue
              }
              const parentUid = uids[uids.length - 1]
              if (parentUid === undefined) continue
              // Fetch envelope + partial body for the parent summary —
              // matches the byte-range optimization on Phase 1.
              const pmsg = await c.fetchOne(
                String(parentUid),
                {
                  envelope: true,
                  source: { start: 0, maxLength: 8192 },
                },
                { uid: true },
              )
              if (!pmsg) {
                item.parent = null
                continue
              }
              const env = pmsg.envelope
              const from = env?.from?.[0]
              const fromStr = from
                ? `${from.name ? `${from.name} ` : ''}<${from.address ?? ''}>`.trim()
                : ''
              const psnippet = await extractSnippet(pmsg.source)
              item.parent = {
                id: `sent:${parentUid}`,
                from: fromStr,
                subject: env?.subject ?? '',
                snippet: psnippet,
                ts: new Date(
                  env?.date ?? pmsg.internalDate ?? Date.now(),
                ).toISOString(),
                unread: false,
              }
            } catch {
              // Per-item failure shouldn't kill the whole list. Leave parent
              // as undefined and move on.
            }
          }
        } finally {
          lock.release()
        }
      } catch {
        // Sent folder unreachable / lock failed. List works without parents,
        // just not as informative.
      }
      return results
    },

    async readMessage(id: string) {
      return readMessageWithDepth(id, 1)
    },

    async listFolders() {
      const c = await getClient()
      // imapflow's c.list() walks LIST/LSUB and returns an array of
      // { path, name, delimiter, flags, specialUse } per mailbox. The
      // `name` field is the leaf segment (decoded from modified-UTF7 by
      // imapflow); `path` is the full hierarchy path we need for
      // getMailboxLock. specialUse is one of '\\Inbox' / '\\Sent' /
      // '\\Drafts' / '\\Junk' / '\\Trash' / '\\Archive' / '\\All' when
      // the server tags it (RFC 6154); undefined otherwise.
      const raw = await c.list()
      const out: MailFolder[] = []
      for (const f of raw) {
        const path = f.path
        const su = (f as { specialUse?: string }).specialUse
        out.push({
          path,
          name: f.name || path,
          isInbox: path === 'INBOX' || su === '\\Inbox',
          isSpecialUse: typeof su === 'string' && su.length > 0,
        })
      }
      return out
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
