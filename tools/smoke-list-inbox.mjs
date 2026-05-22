/**
 * Direct timing smoke for IMAP listInbox. Bypasses the LLM and the
 * chat tool wrapper — calls the adapter directly to isolate whether
 * the "卡在 listRecentEmails" symptom is IMAP-side latency, our
 * byte-range fetch breaking, or upstream model behavior.
 *
 * Reports wall time for three scenarios:
 *   1. includeParents: false (the new default — should be fast)
 *   2. includeParents: true  (the old default — slow per-reply Sent search)
 *   3. fast path repeated  (warm connection, no Sent lookup)
 *
 * Run: npm run test:list-inbox
 */

import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// `electron tools/...` doesn't honor Node's `--env-file`. Load .env by
// hand so the smoke is callable as a plain `electron <script>`.
function loadEnv() {
  try {
    const raw = readFileSync(join(process.cwd(), '.env'), 'utf-8')
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i.exec(line)
      if (!m) continue
      const key = m[1]
      let val = m[2]
      // Strip surrounding quotes if present.
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1)
      }
      if (!(key in process.env)) process.env[key] = val
    }
  } catch (err) {
    console.warn('[smoke] .env not loaded:', err.message ?? err)
  }
}
loadEnv()

async function main() {
  const { register } = await import('tsx/esm/api')
  register()
  const { createImapAdapter } = await import('../src/main/mail/imap-adapter.ts')

  await app.whenReady()

  const host = process.env.MAIL_HOST
  const port = Number(process.env.MAIL_PORT || 993)
  const user = process.env.MAIL_USER
  const pass = process.env.MAIL_PASSWORD
  if (!host || !user || !pass) {
    console.error(
      '[smoke] MAIL_HOST / MAIL_USER / MAIL_PASSWORD not set in .env',
    )
    app.exit(1)
    return
  }
  console.log(`[smoke] connecting to imaps://${user}@${host}:${port}`)

  const adapter = createImapAdapter({
    host,
    port,
    user,
    pass,
    secure: true,
  })

  const run = async (label, includeParents) => {
    console.log(`\n[smoke] ─── ${label} (includeParents=${includeParents}) ───`)
    const t0 = Date.now()
    try {
      const items = await adapter.listInbox({
        limit: 10,
        onlyUnread: false,
        includeParents,
      })
      const ms = Date.now() - t0
      console.log(`[smoke]   ✓ ${items.length} emails in ${ms}ms`)
      for (const m of items.slice(0, 3)) {
        const parent = m.parent
          ? ` [↳ parent: ${m.parent.from.slice(0, 30)}]`
          : m.parent === null
            ? ' [↳ parent: not found]'
            : ''
        console.log(
          `[smoke]     · ${m.from.slice(0, 30).padEnd(30)} | ${m.subject.slice(0, 40).padEnd(40)} | snippet ${m.snippet.length}字${parent}`,
        )
      }
    } catch (err) {
      const ms = Date.now() - t0
      console.error(`[smoke]   ✗ failed after ${ms}ms:`, err.message ?? err)
    }
  }

  await run('A. fast path (parents OFF, current default)', false)
  await run('B. slow path (parents ON, old default)', true)
  await run('C. fast path repeated (warm connection)', false)

  try {
    if (adapter.close) await adapter.close()
  } catch {}
  app.exit(0)
}

main().catch((err) => {
  console.error('[smoke] crashed:', err)
  app.exit(1)
})
