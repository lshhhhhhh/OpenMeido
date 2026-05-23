#!/usr/bin/env node
/**
 * Shape test for the in-memory fake mail adapter. Verifies the synthetic
 * data wires up correctly: parents are attached for replies whose
 * In-Reply-To resolves, set to null for replies whose parent isn't on
 * the server, and absent for standalone messages.
 *
 * Pure-data test — doesn't touch IMAP, Electron, or any tool. Runs in
 * Node + tsx in ~100ms.
 *
 * Run: node --import tsx tools/smoke-fake-mail.mjs
 */
import { createFakeMailAdapter } from '../src/main/mail/fake-adapter.ts'

let pass = 0
let fail = 0
const note = (ok, label, detail = '') => {
  if (ok) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label}`)
    if (detail) console.log(`      ${detail}`)
  }
}

const adapter = createFakeMailAdapter()

console.log('\n[listInbox shape]')
// Pass includeParents:true explicitly — the adapter's contract is
// "parents are opt-in" (matches the IMAP adapter, where attaching parents
// costs one extra search per reply). The "skip parent lookup" path
// below tests the false case.
const list = await adapter.listInbox({ limit: 20, includeParents: true })
note(list.length >= 7, `returns ≥7 inbox items (got ${list.length})`)

const byId = new Map(list.map((m) => [m.id, m]))

// Threads 1-4 + 6 are replies WITH parent in Sent.
for (const id of ['101', '102', '103', '104', '108', '109']) {
  const item = byId.get(id)
  note(!!item, `item ${id} present in list`)
  if (item) {
    note(
      item.inReplyTo !== undefined,
      `item ${id} has inReplyTo set`,
      `got ${item.inReplyTo}`,
    )
    note(
      item.parent !== undefined && item.parent !== null,
      `item ${id} parent attached`,
      `parent=${JSON.stringify(item.parent?.subject ?? null)}`,
    )
  }
}

// Thread 5: reply whose parent is NOT on the server.
{
  const item = byId.get('105')
  note(!!item, 'item 105 (phone-call followup) present')
  if (item) {
    note(item.inReplyTo !== undefined, 'item 105 has inReplyTo set')
    note(
      item.parent === null,
      'item 105 parent === null (looked, not found)',
      `parent=${JSON.stringify(item.parent)}`,
    )
  }
}

// Standalones: no inReplyTo, no parent.
for (const id of ['106', '107']) {
  const item = byId.get(id)
  note(!!item, `item ${id} (standalone) present`)
  if (item) {
    note(item.inReplyTo === undefined, `item ${id} no inReplyTo`)
    note(item.parent === undefined, `item ${id} no parent field`)
  }
}

console.log('\n[parent content sanity]')
{
  // Item 101 is Alice's reply about LunarLink. Its parent should be
  // sent:1 ("LunarLink 1.2 预发布时间确认") from ME.
  const item = byId.get('101')
  note(
    item?.parent?.subject?.includes('LunarLink'),
    'item 101 parent subject mentions LunarLink',
    `got ${JSON.stringify(item?.parent?.subject)}`,
  )
  note(
    item?.parent?.from?.startsWith('me@'),
    'item 101 parent is from ME (was sent BY user)',
    `got ${item?.parent?.from}`,
  )
}

console.log('\n[chain depth: long thread (#6, items 108/109)]')
{
  // 109 → its parent is sent:6b (Re: Re:); sent:6b → 108 (Frank's first reply);
  // 108 → sent:6a (root). listInbox only attaches one level — verify.
  const item109 = byId.get('109')
  note(
    item109?.parent?.id === 'sent:6b',
    "109's parent is sent:6b",
    `got ${item109?.parent?.id}`,
  )
  note(
    // parent is Omit<MailSummary,'parent'>, so .parent shouldn't exist on it
    item109?.parent && !('parent' in item109.parent),
    "109's parent has no nested grandparent (list output is shallow)",
  )
}

console.log('\n[readMessage shape]')
{
  const msg = await adapter.readMessage('101')
  note(!!msg, 'readMessage(101) returns a message')
  if (msg) {
    note(msg.body.length > 50, `body fully populated (${msg.body.length} chars)`)
    note(msg.messageId !== undefined, 'messageId surfaced')
    note(msg.inReplyTo !== undefined, 'inReplyTo surfaced')
    note(
      msg.parent !== undefined && msg.parent !== null,
      'parent attached on readMessage',
    )
    note(
      msg.parent?.body && msg.parent.body.length > 50,
      "parent's full body is included (not just snippet)",
      `parent.body length: ${msg.parent?.body?.length}`,
    )
  }
}

console.log('\n[readMessage on standalone — no parent]')
{
  const msg = await adapter.readMessage('106')
  note(!!msg, 'readMessage(106) returns the newsletter')
  if (msg) {
    note(msg.inReplyTo === undefined, 'no inReplyTo on standalone')
    note(msg.parent === undefined, 'no parent field on standalone')
  }
}

console.log('\n[readMessage on missing id]')
{
  const msg = await adapter.readMessage('99999')
  note(msg === null, 'unknown id → null')
}

console.log('\n[listInbox onlyUnread filter]')
{
  const unread = await adapter.listInbox({ limit: 20, onlyUnread: true })
  const allUnread = unread.every((m) => m.unread)
  note(allUnread, `all ${unread.length} returned items are unread`)
}

console.log('\n[listInbox limit slicing]')
{
  const small = await adapter.listInbox({ limit: 3 })
  note(small.length === 3, `limit:3 → ${small.length} items`)
  // Should be newest 3 (sorted desc by ts).
  const tsDesc = small.every((m, i) => i === 0 || m.ts <= small[i - 1].ts)
  note(tsDesc, 'items sorted by ts desc')
}

console.log('\n[includeParents:false skips parent lookup]')
{
  const noParents = await adapter.listInbox({ limit: 20, includeParents: false })
  const anyParent = noParents.some((m) => m.parent !== undefined)
  note(!anyParent, 'no item has a parent field when includeParents:false')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
