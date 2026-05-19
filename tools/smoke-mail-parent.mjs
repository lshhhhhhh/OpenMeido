#!/usr/bin/env node
/**
 * Synthetic test for the email-with-context (reply-chain) parsing logic.
 *
 * Tests the parts of `imap-adapter.readMessage` that DON'T need a live
 * IMAP server: header extraction (Message-Id, In-Reply-To) and the
 * array-vs-string normalization for `inReplyTo` that mailparser
 * occasionally returns inconsistently.
 *
 * IMAP wire behavior (mailbox listing, SPECIAL-USE \Sent detection,
 * UID search by header) cannot be tested here — that needs a live
 * server or a deeply-mocked imapflow. See tools/probe-mail-parent.mjs
 * (next) for a live-against-real-mailbox probe.
 *
 * Run: npm run test:mail-parent
 */
import { simpleParser } from 'mailparser'

let pass = 0
let fail = 0

function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label}`)
    console.log(`      got:  ${JSON.stringify(got)}`)
    console.log(`      want: ${JSON.stringify(want)}`)
  }
}

/**
 * Mirrors the normalization in src/main/mail/imap-adapter.ts:
 * mailparser sometimes returns inReplyTo as a string, sometimes as an
 * array (multi-parent threads). We always take the first id.
 */
function normalizeInReplyTo(raw) {
  if (Array.isArray(raw)) return raw[0]
  if (typeof raw !== 'string') return undefined
  // RFC 5322 allows multiple parent msg-ids whitespace-separated.
  // mailparser sometimes returns the whole list as a single string;
  // pull the first <id> we find.
  const ids = raw.match(/<[^>]+>/g)
  if (ids && ids.length > 0) return ids[0]
  return raw
}

/** Build a minimal RFC822 message with the given headers. */
function buildEmail({ messageId, inReplyTo, from = 'alice@example.com', subject = 'subj', body = 'hello' }) {
  const lines = [
    `From: ${from}`,
    `To: bob@example.com`,
    `Subject: ${subject}`,
    `Date: Mon, 19 May 2026 10:00:00 +0800`,
  ]
  if (messageId) lines.push(`Message-ID: ${messageId}`)
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`)
  lines.push('Content-Type: text/plain; charset=utf-8')
  lines.push('')
  lines.push(body)
  return lines.join('\r\n')
}

async function main() {
  console.log('\n[Message-Id extraction]')
  {
    const parsed = await simpleParser(buildEmail({ messageId: '<root-1@example.com>' }))
    eq('plain Message-Id', parsed.messageId, '<root-1@example.com>')
  }
  {
    const parsed = await simpleParser(buildEmail({ messageId: '<has spaces@odd.com>' }))
    // mailparser preserves angle brackets and the id verbatim.
    eq('Message-Id with spaces', parsed.messageId, '<has spaces@odd.com>')
  }

  console.log('\n[In-Reply-To normalization]')
  {
    const parsed = await simpleParser(
      buildEmail({ messageId: '<r1@x.com>', inReplyTo: '<root-1@example.com>' }),
    )
    eq('single In-Reply-To → string', normalizeInReplyTo(parsed.inReplyTo), '<root-1@example.com>')
  }
  {
    // RFC 5322 allows multiple parent Message-Ids in In-Reply-To.
    // mailparser parses this as an array.
    const raw = buildEmail({
      messageId: '<merge1@x.com>',
      inReplyTo: '<parent-a@x.com> <parent-b@x.com>',
    })
    const parsed = await simpleParser(raw)
    eq(
      'multi-parent In-Reply-To → first id',
      normalizeInReplyTo(parsed.inReplyTo),
      '<parent-a@x.com>',
    )
  }
  {
    const parsed = await simpleParser(buildEmail({ messageId: '<root2@x.com>' }))
    eq('no In-Reply-To → undefined', normalizeInReplyTo(parsed.inReplyTo), undefined)
  }

  console.log('\n[Reply-chain round-trip — parent links to child via Message-Id]')
  {
    // The classic chain: user A sends, user B replies.
    const parentRaw = buildEmail({
      messageId: '<original-q@you.com>',
      from: 'you@you.com',
      subject: 'Status of project X',
      body: 'How is project X going?',
    })
    const childRaw = buildEmail({
      messageId: '<reply-1@them.com>',
      inReplyTo: '<original-q@you.com>',
      from: 'them@them.com',
      subject: 'Re: Status of project X',
      body: 'On track for Friday.',
    })
    const parent = await simpleParser(parentRaw)
    const child = await simpleParser(childRaw)

    eq('child.inReplyTo matches parent.messageId', normalizeInReplyTo(child.inReplyTo), parent.messageId)
    eq('parent has no inReplyTo (thread root)', normalizeInReplyTo(parent.inReplyTo), undefined)
    eq('subjects differ by Re: prefix', [parent.subject, child.subject], [
      'Status of project X',
      'Re: Status of project X',
    ])
  }

  console.log('\n[Edge — malformed Message-Id]')
  {
    // Some clients emit Message-Id without angle brackets. mailparser
    // wraps them when needed; verify we still get a usable id.
    const lines = [
      'From: a@a.com',
      'To: b@b.com',
      'Subject: weird',
      'Date: Mon, 19 May 2026 10:00:00 +0800',
      'Message-ID: bare-no-brackets@server.com',
      'In-Reply-To: <real-parent@server.com>',
      'Content-Type: text/plain',
      '',
      'body',
    ].join('\r\n')
    const parsed = await simpleParser(lines)
    // Don't enforce a specific format — mailparser may or may not add
    // brackets. Just ensure we got SOMETHING non-empty.
    eq(
      'malformed Message-Id parsed to non-empty',
      typeof parsed.messageId === 'string' && parsed.messageId.length > 0,
      true,
    )
    eq(
      'In-Reply-To still resolves correctly',
      normalizeInReplyTo(parsed.inReplyTo),
      '<real-parent@server.com>',
    )
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('crashed:', err)
  process.exit(1)
})
