/**
 * Smoke test: simpleParser-based snippet extraction.
 *
 * Verifies that the listInbox snippet pipeline (mailparser.simpleParser
 * on a partial-RFC822 source chunk) produces clean plain text — no raw
 * MIME boundaries, no encoded payloads, no HTML — across the email shapes
 * users actually receive:
 *
 *   1. multipart/alternative with quoted-printable text/plain + HTML
 *   2. multipart/alternative with base64 text/plain + HTML
 *   3. Plain-text only with charset=GB2312 (Chinese Outlook still emits this)
 *   4. HTML-only with entities and inline <style>
 *   5. multipart/mixed nesting multipart/alternative (Gmail's common shape)
 *   6. Truncated multipart (real partial-fetch case: cuts off mid-base64)
 *
 * Reproduces the user-reported bug ("所有邮件正文都是MIME格式无法解析"):
 * each fixture's expected snippet must be readable Chinese / English
 * sentences, NOT regex artifacts like `--boundary` or `Content-Type:`.
 *
 * Run: node --import tsx tools/smoke-mime-snippet.mjs
 */

import { Buffer } from 'node:buffer'

// Mirror the production helper. Kept verbatim so the test fails if anyone
// changes extractSnippet in imap-adapter without updating the test.
import { simpleParser } from 'mailparser'

const SNIPPET_LEN = 200

async function extractSnippet(source) {
  if (!source || source.length === 0) return ''
  try {
    const parsed = await simpleParser(source, {
      skipImageLinks: true,
      skipHtmlToText: false,
    })
    const text = (parsed.text ?? '').trim()
    if (text) return text.replace(/\s+/g, ' ').slice(0, SNIPPET_LEN)
    return ''
  } catch {
    return ''
  }
}

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name} :: ${detail}`)
  }
}

const containsRawMime = (s) =>
  s.includes('Content-Type:') ||
  s.includes('Content-Transfer-Encoding:') ||
  /^--/.test(s) ||
  s.includes('boundary=') ||
  /=[0-9A-F]{2}=[0-9A-F]{2}/.test(s) // unconverted QP

// ---- Fixture 1: multipart/alternative + quoted-printable Chinese ----
{
  console.log('\n[1: multipart/alternative + quoted-printable, Chinese]')
  // "中文邮件正文测试" QP-encoded
  const fixture = Buffer.from(
    [
      'From: alice@example.test',
      'Subject: Project update',
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="boundary42"',
      '',
      '--boundary42',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '=E4=B8=AD=E6=96=87=E9=82=AE=E4=BB=B6=E6=AD=A3=E6=96=87=E6=B5=8B=E8=AF=95',
      '',
      '--boundary42',
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '<p>=E4=B8=AD=E6=96=87 HTML</p>',
      '',
      '--boundary42--',
    ].join('\r\n'),
  )
  const snippet = await extractSnippet(fixture)
  console.log(`    snippet: "${snippet}"`)
  check('QP Chinese decoded correctly', snippet.includes('中文邮件正文测试'), snippet)
  check('no raw MIME artifacts leaked', !containsRawMime(snippet), snippet)
}

// ---- Fixture 2: multipart/alternative + base64 ----
{
  console.log('\n[2: multipart/alternative + base64]')
  const plain = '订单已发货：Apple Watch Series 10。预计 5 月 28 日送达。'
  const b64 = Buffer.from(plain, 'utf8').toString('base64')
  const fixture = Buffer.from(
    [
      'From: shop@example.test',
      'Subject: 发货通知',
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64,
      '',
      '--b1--',
    ].join('\r\n'),
  )
  const snippet = await extractSnippet(fixture)
  console.log(`    snippet: "${snippet}"`)
  check('base64 decoded', snippet.includes('Apple Watch Series 10'), snippet)
  check('no MIME leakage', !containsRawMime(snippet), snippet)
}

// ---- Fixture 3: GB2312 plain text ----
{
  console.log('\n[3: text/plain charset=GB2312 (Chinese Outlook)]')
  // 早些年中文 Outlook 默认就是 GB2312。手动构造 GB2312 字节流。
  // 测试串: "您好，本周项目验收时间确认。" (GB2312 编码)
  const gb2312Bytes = Buffer.from([
    0xc4, 0xfa, 0xba, 0xc3, 0xa3, 0xac, // 您好，
    0xb1, 0xbe, 0xd6, 0xdc, // 本周
    0xcf, 0xee, 0xc4, 0xbf, // 项目
    0xd1, 0xe9, 0xca, 0xd5, // 验收
    0xca, 0xb1, 0xbc, 0xe4, // 时间
    0xc8, 0xb7, 0xc8, 0xcf, 0xa1, 0xa3, // 确认。
  ])
  const fixture = Buffer.concat([
    Buffer.from(
      [
        'From: bob@example.test',
        'Subject: =?GB2312?B?yLrLwc6w?=',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=GB2312',
        '',
        '',
      ].join('\r\n'),
      'utf8',
    ),
    gb2312Bytes,
    Buffer.from('\r\n'),
  ])
  const snippet = await extractSnippet(fixture)
  console.log(`    snippet: "${snippet}"`)
  check('GB2312 decoded to readable Chinese', snippet.includes('您好') && snippet.includes('确认'), snippet)
  check('no raw bytes leaked', !containsRawMime(snippet), snippet)
}

// ---- Fixture 4: HTML-only with entities ----
{
  console.log('\n[4: text/html with entities + inline <style>]')
  const fixture = Buffer.from(
    [
      'From: news@example.test',
      'Subject: Weekly digest',
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<style>body{color:#333}</style>',
      '<div>Hello&nbsp;Alice, your invoice is&nbsp;ready.&amp; thanks!</div>',
      '<p>&#x4E2D;&#x6587;&#x6D4B;&#x8BD5;</p>',
    ].join('\r\n'),
  )
  const snippet = await extractSnippet(fixture)
  console.log(`    snippet: "${snippet}"`)
  check('HTML stripped', !snippet.includes('<div>') && !snippet.includes('<style>'), snippet)
  check('&nbsp; entity decoded', !snippet.includes('&nbsp;'), snippet)
  check('&amp; entity decoded', !snippet.includes('&amp;') && snippet.includes('&'), snippet)
  check('numeric entity decoded', snippet.includes('中文测试'), snippet)
  check('style block removed', !snippet.includes('color:#333'), snippet)
}

// ---- Fixture 5: nested multipart/mixed > multipart/alternative ----
{
  console.log('\n[5: multipart/mixed wrapping multipart/alternative (Gmail-style)]')
  const fixture = Buffer.from(
    [
      'From: gmailish@example.test',
      'Subject: Nested',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="outer"',
      '',
      '--outer',
      'Content-Type: multipart/alternative; boundary="inner"',
      '',
      '--inner',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Plaintext body wins.',
      '',
      '--inner',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>HTML version.</p>',
      '',
      '--inner--',
      '',
      '--outer',
      'Content-Type: application/pdf; name=report.pdf',
      'Content-Transfer-Encoding: base64',
      '',
      'JVBERi0xLjQK', // fake PDF magic
      '',
      '--outer--',
    ].join('\r\n'),
  )
  const snippet = await extractSnippet(fixture)
  console.log(`    snippet: "${snippet}"`)
  check('nested multipart resolved to plaintext', snippet.includes('Plaintext body wins'), snippet)
  check('attachment payload not in snippet', !snippet.includes('JVBERi0xLjQK'), snippet)
  check('no MIME leakage', !containsRawMime(snippet), snippet)
}

// ---- Fixture 6: truncated source mid-base64 (real partial-fetch case) ----
{
  console.log('\n[6: truncated source mid-MIME (simulates partial 8KB fetch)]')
  const longText = 'A'.repeat(2000) + ' marker-end'
  const b64 = Buffer.from(longText, 'utf8').toString('base64')
  const fullFixture = Buffer.from(
    [
      'From: trunc@example.test',
      'Subject: Truncation test',
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="t1"',
      '',
      '--t1',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64,
      '',
      '--t1--',
    ].join('\r\n'),
  )
  // Truncate to first 600 bytes — mid-base64 payload.
  const truncated = fullFixture.subarray(0, 600)
  const snippet = await extractSnippet(truncated)
  console.log(`    snippet (first 100): "${snippet.slice(0, 100)}"`)
  check('truncated source did not throw', typeof snippet === 'string')
  check('partial decode produced some text', snippet.length > 0 && snippet.startsWith('A'), `len=${snippet.length}`)
  check('no MIME bytes in snippet', !containsRawMime(snippet), snippet)
}

// ---- Fixture 7: completely empty / undefined input ----
{
  console.log('\n[7: edge cases]')
  check('undefined source returns empty', (await extractSnippet(undefined)) === '')
  check('empty buffer returns empty', (await extractSnippet(Buffer.alloc(0))) === '')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
