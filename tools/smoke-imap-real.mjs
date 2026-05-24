#!/usr/bin/env node
/**
 * Real-IMAP smoke test against the .env credentials. Verifies that
 * mail-host's adapter + the actual provider both function — useful
 * after refactors that might break the IMAP path the smoke-fake-mail
 * test doesn't exercise.
 *
 * Run: node --env-file=.env --import tsx tools/smoke-imap-real.mjs
 *
 * Does NOT modify the inbox (read-only). Lists 5 most recent messages
 * + reads the first one fully to verify both endpoints.
 */

const { register } = await import('tsx/esm/api')
register()

const { createImapAdapter } = await import('../src/main/mail/imap-adapter.ts')

const host = process.env.MAIL_HOST
const port = parseInt(process.env.MAIL_PORT ?? '993')
const user = process.env.MAIL_USER
const pass = process.env.MAIL_PASSWORD

if (!host || !user || !pass) {
  console.error('Missing MAIL_HOST / MAIL_USER / MAIL_PASSWORD in .env')
  process.exit(2)
}

console.log(`[imap-smoke] host=${host}:${port} user=${user} pass=*** (${pass.length} chars)`)

const adapter = createImapAdapter({ host, port, secure: true, user, pass })

let pass_ = 0
let fail_ = 0
const note = (ok, label, detail = '') => {
  if (ok) {
    pass_++
    console.log(`  ✓ ${label}`)
  } else {
    fail_++
    console.log(`  ✗ ${label}`)
    if (detail) console.log(`      ${detail}`)
  }
}

try {
  console.log('\n[1] testConnection')
  const tc = await adapter.testConnection()
  note(tc.ok === true, 'testConnection ok', JSON.stringify(tc))

  console.log('\n[2] listFolders')
  const folders = await adapter.listFolders()
  note(Array.isArray(folders) && folders.length > 0, `listFolders returns ≥1 folder (got ${folders?.length ?? 0})`)
  if (folders && folders.length > 0) {
    console.log(`      folders: ${folders.slice(0, 8).map((f) => f.path).join(' | ')}${folders.length > 8 ? ' …' : ''}`)
  }

  console.log('\n[3] listInbox limit:5')
  const list = await adapter.listInbox({ limit: 5, includeParents: false })
  note(Array.isArray(list), 'listInbox returns array')
  note(list.length > 0, `listInbox returned ≥1 message (got ${list.length})`)
  if (list.length > 0) {
    console.log('      most recent:')
    for (const m of list.slice(0, 5)) {
      console.log(`        id=${m.id} from=${m.from?.slice(0, 50)} subject=${(m.subject ?? '').slice(0, 60)} unread=${m.unread}`)
    }
  }

  console.log('\n[4] readMessage on first item')
  if (list.length > 0) {
    const first = await adapter.readMessage(list[0].id)
    note(!!first, `readMessage(${list[0].id}) returns a message`)
    if (first) {
      note(typeof first.body === 'string' && first.body.length > 0, `body populated (${first.body?.length} chars)`)
      note(typeof first.subject === 'string', `subject populated: "${first.subject?.slice(0, 60)}"`)
    }
    // Diagnostic — parse the raw source directly to see what mailparser yields
    const { ImapFlow } = await import('imapflow')
    const { simpleParser } = await import('mailparser')
    const c = new ImapFlow({ host, port, secure: true, auth: { user, pass }, logger: false })
    await c.connect()
    const lock = await c.getMailboxLock('INBOX')
    try {
      const msg = await c.fetchOne(String(list[0].id), { source: true }, { uid: true })
      if (msg?.source) {
        const parsed = await simpleParser(msg.source)
        console.log(`      parsed.text:        ${typeof parsed.text === 'string' ? `${parsed.text.length} chars` : typeof parsed.text}`)
        console.log(`      parsed.html:        ${typeof parsed.html === 'string' ? `${parsed.html.length} chars` : typeof parsed.html}`)
        console.log(`      parsed.textAsHtml:  ${typeof parsed.textAsHtml === 'string' ? `${parsed.textAsHtml.length} chars` : typeof parsed.textAsHtml}`)
        console.log(`      parsed.attachments: ${parsed.attachments?.length ?? 0}`)
      }
    } finally {
      lock.release()
      await c.logout()
    }
  } else {
    console.log('      skipped — inbox empty')
  }

  console.log('\n[5] listInbox includeParents:true (slower path)')
  const withParents = await adapter.listInbox({ limit: 3, includeParents: true })
  note(Array.isArray(withParents), 'listInbox(includeParents:true) returns array')
  const anyReply = withParents.find((m) => m.inReplyTo)
  if (anyReply) {
    console.log(`      found reply: id=${anyReply.id} parent=${anyReply.parent === null ? 'null (not found)' : anyReply.parent?.subject?.slice(0, 50)}`)
  } else {
    console.log('      no replies in top 3 — parent path not exercised this run')
  }
} catch (err) {
  console.error('\n[fatal] adapter threw:', err)
  fail_++
} finally {
  await adapter.close()
}

console.log(`\n${pass_} passed, ${fail_} failed`)
process.exit(fail_ === 0 ? 0 : 1)
