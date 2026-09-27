/**
 * IMAP MailAdapter implementation. Lives in src/main/ because imapflow
 * uses raw TCP/TLS sockets (node:net + node:tls) that don't exist in
 * browser / Capacitor environments.
 *
 * Connection lifecycle:
 *   - Lazy connect on first call. One persistent connection per adapter
 *     instance, kept alive via imapflow's built-in IDLE/NOOP. Concurrent
 *     callers on a cold adapter share ONE in-flight connect.
 *   - If the server drops us (network blip, server idle timeout, socket
 *     error), the 'error' / 'close' listeners discard the client and the
 *     NEXT call dials a fresh one. The call that hit the drop fails — no
 *     automatic retry.
 *   - Every public operation runs under a wall-clock timeout. A wedged
 *     server fails the tool call (and the connection is torn down) instead
 *     of hanging the chat turn until imapflow's socket timeout.
 *   - close() logs out and tears down. Safe to call multiple times.
 *
 * Message ids: INBOX messages are the bare UID ("12345"); messages in the
 * Sent mailbox are "sent:<uid>". readMessage accepts both, which is what
 * lets callers walk a reply chain that alternates INBOX ↔ Sent.
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

/**
 * Extract readable plain text from an HTML email body. Used as a fallback
 * when mailparser's `parsed.text` is undefined — common for modern
 * marketing / transactional emails that ship HTML-only with no
 * text/plain MIME part (AliExpress, Uber, banking notifications, etc).
 *
 * Doesn't need to be a perfect HTML→text converter — the LLM is
 * surprisingly tolerant of slightly messy input. We strip the
 * obviously non-content tags (script/style), turn block-level
 * boundaries into newlines, drop the rest of the tag soup, and
 * decode the common entities. Quoted-printable / base64 transfer
 * encoding has already been undone by simpleParser before we see it.
 *
 * Without this, our readMessage returns `body: ''` for HTML-only
 * emails and the LLM has nothing to summarize / reply to — the
 * "她突然看不懂邮件了" symptom that triggered this fix.
 */
function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|td|th|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Body extraction with the HTML-fallback chain. Order:
 *   1. parsed.text       — if the email has a text/plain part, use it
 *   2. parsed.textAsHtml — mailparser sometimes populates this when it
 *      decides to auto-convert, but for HTML-only emails it's often
 *      undefined; check anyway as a free win
 *   3. htmlToPlainText(parsed.html) — last resort, strip the HTML
 *      ourselves. Common path for HTML-only marketing emails.
 *   4. ''                — truly empty body (rare)
 */
function extractBody(parsed: {
  text?: string
  textAsHtml?: string
  html?: string | false
}): string {
  if (parsed.text && parsed.text.trim()) return parsed.text.trim()
  if (parsed.textAsHtml && parsed.textAsHtml.trim()) return parsed.textAsHtml.trim()
  if (typeof parsed.html === 'string' && parsed.html.trim()) {
    return htmlToPlainText(parsed.html)
  }
  return ''
}

export interface ImapAdapterOptions {
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
}

const SNIPPET_LEN = 200

/** TCP connect + greeting + LOGIN budget. imapflow's own connectionTimeout
 *  only covers the TCP handshake and defaults to 90s; this caps the whole
 *  connect() including auth. */
const CONNECT_TIMEOUT_MS = 20_000
/** Wall-clock budget for one public adapter call (listInbox, readMessage,
 *  ...). Generous for a single IMAP round-trip set; if we blow it the
 *  server is wedged, not slow. */
const OP_TIMEOUT_MS = 45_000
/** LOGOUT is a courtesy — don't let a dead server stall close(). */
const LOGOUT_TIMEOUT_MS = 5_000

/** Reject with a timeout error if `p` doesn't settle within `ms`. The
 *  underlying promise keeps running (JS has no cancellation) — pass
 *  `onTimeout` to tear the connection down so it actually stops. */
async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      console.warn(`[imap] ${label} timed out after ${ms}ms`)
      onTimeout?.()
      reject(new Error(`IMAP ${label} 超时（${Math.round(ms / 1000)} 秒无响应）`))
    }, ms)
  })
  try {
    // Promise.race subscribes to `p`, so a late rejection after we time
    // out is observed (no unhandledRejection).
    return await Promise.race([p, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** Which mailbox a message id points into. See the id note at the top. */
type MailBox = 'INBOX' | 'SENT'
interface MessageRef {
  box: MailBox
  uid: number
}

/** "12345" → INBOX uid; "sent:12345" → Sent uid; anything else → null. */
function parseMessageRef(id: string): MessageRef | null {
  const s = id.trim()
  if (/^\d+$/.test(s)) return { box: 'INBOX', uid: Number(s) }
  const m = /^sent:(\d+)$/i.exec(s)
  if (m && m[1]) return { box: 'SENT', uid: Number(m[1]) }
  return null
}

function formatMessageRef(ref: MessageRef): string {
  return ref.box === 'SENT' ? `sent:${ref.uid}` : String(ref.uid)
}

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
  /** In-flight connect shared by concurrent callers. Without it, N tool
   *  calls on a cold adapter each dialed their own ImapFlow and only the
   *  last one assigned to `client` survived — the rest leaked. */
  let connecting: Promise<ImapFlow> | null = null
  let closed = false
  /** Resolved Sent mailbox path. Folder layout doesn't change under a
   *  live session, and thread walking resolves it once per hop. */
  let sentPathCache: string | null = null

  /** Forget `c` (if it's still the current client) and kill its socket.
   *  close() is idempotent and rejects any pending commands / mailbox
   *  locks, so whoever was awaiting on `c` unblocks with an error. */
  function discardClient(c: ImapFlow): void {
    if (client === c) client = null
    try {
      c.close()
    } catch {
      /* already closed */
    }
  }

  async function openClient(): Promise<ImapFlow> {
    const c = new ImapFlow({
      host: opts.host,
      port: opts.port,
      secure: opts.secure,
      auth: { user: opts.user, pass: opts.pass },
      // imapflow ships a noisy default logger that spams stdout with every
      // IMAP frame. Silence it; serious errors still throw from awaited calls.
      logger: false,
      // Defaults are 90s / 16s / 5min — far longer than a chat turn should
      // wait. socketTimeout is inactivity-based: while IDLE-ing imapflow
      // answers it with a NOOP, otherwise it errors and we reconnect.
      connectionTimeout: CONNECT_TIMEOUT_MS,
      greetingTimeout: 15_000,
      socketTimeout: 2 * 60_000,
    })
    // ImapFlow is an EventEmitter: an 'error' with no listener is thrown
    // as an uncaught exception and takes the main process down with it.
    // imapflow already schedules close() after emitting, we just make
    // sure the next call doesn't pick this client up again.
    c.on('error', (err: Error) => {
      console.warn('[imap] connection error:', err?.message ?? err)
      discardClient(c)
    })
    c.on('close', () => {
      if (client === c) {
        console.log('[imap] connection closed; next call will reconnect')
        client = null
      }
    })
    try {
      await withTimeout(c.connect(), CONNECT_TIMEOUT_MS, 'connect')
    } catch (err) {
      discardClient(c)
      throw err
    }
    if (closed) {
      // Adapter was closed while we were dialing — don't leak the socket.
      discardClient(c)
      throw new Error('imap-adapter: closed')
    }
    client = c
    return c
  }

  async function getClient(): Promise<ImapFlow> {
    if (closed) throw new Error('imap-adapter: closed')
    if (client && client.usable) return client
    // Stale client (errored / server hung up): make sure its socket is
    // gone before dialing a replacement.
    if (client) discardClient(client)
    if (!connecting) {
      // Cleared on success AND failure — a failed dial must not poison
      // every later call with the same rejected promise.
      connecting = openClient().finally(() => {
        connecting = null
      })
    }
    return connecting
  }

  /**
   * Run one public operation under OP_TIMEOUT_MS. On timeout the current
   * connection is torn down: it's wedged (or at least queued behind a
   * wedged command — imapflow serializes per connection), and closing it
   * also rejects the abandoned operation's pending commands so it
   * releases its mailbox lock instead of lingering.
   */
  function withOpTimeout<T>(label: string, fn: () => Promise<T>): Promise<T> {
    return withTimeout(fn(), OP_TIMEOUT_MS, label, () => {
      if (client) discardClient(client)
    })
  }

  /** Lock `folderPath` + run + release. Throws cleanly if the folder
   *  doesn't exist on the server. */
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
      // Prefer the plaintext part; fall back to HTML-derived text (same
      // chain readMessage uses). The HTML fallback handles modern HTML-
      // only emails (AliExpress, transactional notices) where parsed.text
      // is undefined — without it the snippet shows blank.
      const text = extractBody(parsed)
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
   * unusual but possible on minimal IMAP servers. A found path is cached
   * for the adapter's lifetime (a miss is not, so it's re-checked).
   */
  async function findSentMailbox(c: ImapFlow): Promise<string | null> {
    if (sentPathCache) return sentPathCache
    type Box = { path: string; name?: string; specialUse?: string }
    const list = (await c.list()) as Box[]
    const bySpecial = list.find((b) => b.specialUse === '\\Sent')
    const byName = bySpecial
      ? undefined
      : list.find((b) => /^sent/i.test(b.name ?? '') || /sent[\s_-]?(items|mail)/i.test(b.path))
    sentPathCache = bySpecial?.path ?? byName?.path ?? null
    return sentPathCache
  }

  /** Map a MailBox tag to the server's real mailbox path (null = this
   *  server has no Sent box). */
  async function mailboxPath(c: ImapFlow, box: MailBox): Promise<string | null> {
    return box === 'INBOX' ? 'INBOX' : findSentMailbox(c)
  }

  /**
   * Search one mailbox for a message with the given RFC 5322 Message-Id
   * (including the angle brackets) and return its UID, or null if not
   * found. We acquire and release our own mailbox lock here, so the caller
   * must NOT already hold one (imapflow locks are per connection — that
   * would deadlock).
   */
  async function findUidByMessageId(
    c: ImapFlow,
    path: string,
    messageId: string,
  ): Promise<number | null> {
    const lock = await c.getMailboxLock(path)
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
   * Locate the parent of a reply by Message-Id, searching `order` in turn.
   * Returns the first hit as a MessageRef, or null if no searched mailbox
   * has it.
   */
  async function findParentRef(
    messageId: string,
    order: MailBox[],
  ): Promise<MessageRef | null> {
    const c = await getClient()
    for (const box of order) {
      const path = await mailboxPath(c, box)
      if (!path) continue
      const uid = await findUidByMessageId(c, path, messageId)
      if (uid !== null) return { box, uid }
    }
    return null
  }

  /**
   * Recursive readMessage that mirrors the public adapter signature but
   * decrements a depth budget as it walks up the reply chain. depth=1
   * fetches the message + its immediate parent; depth=0 fetches just the
   * message (used to prevent the parent's parent's... recursion).
   *
   * Accepts both id forms ("<uid>" = INBOX, "sent:<uid>" = Sent). This
   * used to be `Number(id)` — every "sent:<uid>" parent id came back NaN →
   * null, so chat/tools/mail.ts buildEmailThreadContext never got past
   * the first parent, and readEmail(parent.id) (which types.ts documents
   * as the way to walk further) always failed.
   */
  async function readMessageWithDepth(
    id: string,
    depth: number,
  ): Promise<MailMessage | null> {
    const ref = parseMessageRef(id)
    if (!ref) return null
    const path = await mailboxPath(await getClient(), ref.box)
    if (!path) return null // "sent:<uid>" but this server has no Sent box

    // First leg: fetch + parse the requested message. We release the lock
    // BEFORE looking up the parent because imapflow serializes mailbox
    // access per connection — holding this mailbox while we ask for
    // another would deadlock.
    const main = await withFolder(path, async (c) => {
      const msg = await c.fetchOne(String(ref.uid), { source: true }, { uid: true })
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
      id: formatMessageRef(ref),
      from: parsed.from?.text ?? '',
      to: toList.map((a) => a.address ?? '').filter(Boolean),
      subject: parsed.subject ?? '',
      body: extractBody(parsed),
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
    // allows. Where the parent lives depends on direction: an inbound reply
    // usually answers something the user sent (→ Sent first), while the
    // user's own sent reply answers something they received (→ INBOX
    // first). The other box is the fallback — CC'd multi-party threads,
    // or the user bumping their own mail. Failing silently is fine:
    // parent stays null and the model sees that the chain ends here.
    if (depth > 0 && inReplyTo) {
      try {
        const order: MailBox[] = ref.box === 'SENT' ? ['INBOX', 'SENT'] : ['SENT', 'INBOX']
        const parentRef = await findParentRef(inReplyTo, order)
        const isSelf = parentRef && parentRef.box === ref.box && parentRef.uid === ref.uid
        // depth - 1 → the parent comes back without ITS parent; callers
        // walk further by reading parent.id (it's a valid readMessage id).
        // We tried and didn't find it → null so the model knows the chain
        // is broken (vs missing inReplyTo entirely).
        result.parent =
          parentRef && !isSelf
            ? await readMessageWithDepth(formatMessageRef(parentRef), depth - 1)
            : null
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
      const results = await withOpTimeout('listInbox', () => withFolder(folderPath, async (c) => {
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
      }))

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
      // Own timeout budget, separate from Phase 1: N serial searches can
      // legitimately take a while, and a timeout here isn't fatal — items
      // are filled in place, so we return whatever parents we got.
      try {
        await withOpTimeout('listInbox parents', async () => {
          const c = await getClient()
          const sentPath = await findSentMailbox(c)
          if (!sentPath) return
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
                  id: formatMessageRef({ box: 'SENT', uid: parentUid }),
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
        })
      } catch {
        // Sent folder unreachable / lock failed / timed out. List works
        // without parents, just not as informative.
      }
      return results
    },

    async readMessage(id: string) {
      return withOpTimeout('readMessage', () => readMessageWithDepth(id, 1))
    },

    listFolders() {
      return withOpTimeout('listFolders', async () => {
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
      })
    },

    async testConnection() {
      try {
        await withOpTimeout('testConnection', async () => {
          const c = await getClient()
          // Just opening INBOX is enough to prove auth + reachability.
          const lock = await c.getMailboxLock('INBOX')
          lock.release()
        })
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
      // Set first: an in-flight openClient() checks it after connect and
      // discards its fresh socket instead of installing it.
      closed = true
      const c = client
      client = null
      if (c) {
        try {
          await withTimeout(c.logout(), LOGOUT_TIMEOUT_MS, 'logout')
        } catch {
          /* server may have already cut us off */
        }
        // LOGOUT normally closes the socket; make sure even if it hung.
        discardClient(c)
      }
    },
  }
}
