/**
 * End-to-end harness for the "总结邮件 → 表格" flow.
 *
 * Bootstraps the full chat pipeline (memory + fake mail + real LLM)
 * inside Electron, runs runChat() with a productivity prompt, and
 * verifies:
 *
 *   1. The model called presentTable at least once
 *   2. The captured payload has rows.length > 0
 *   3. Columns include core fields (主题 / 发件人 / 最新进展 or
 *      reasonable equivalents)
 *   4. Multi-turn iteration: "再加一列时间" updates the table with
 *      one more column and rows still non-empty
 *
 * Uses fake mail adapter so results are deterministic and we don't
 * pound a real IMAP server. Uses DeepSeek for the chat model
 * (testing-discipline memory: cheap + fast).
 *
 * Run: npm run test:table-e2e
 */

import { app, BrowserWindow } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'

// Load .env manually (electron doesn't honor --env-file).
function loadEnv() {
  try {
    const raw = readFileSync(join(process.cwd(), '.env'), 'utf-8')
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i.exec(line)
      if (!m) continue
      const key = m[1]
      let val = m[2]
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1)
      }
      if (!(key in process.env)) process.env[key] = val
    }
  } catch (err) {
    console.warn('[e2e] .env not loaded:', err.message ?? err)
  }
}
loadEnv()

// Critical: must be set BEFORE mail-host is imported (it captures the
// env var at module load).
process.env.OPENMEIDO_FAKE_MAIL = '1'

// Isolated userData dir so we don't touch the user's real config /
// memory / sqlite. Deleted at exit.
const tempUserData = mkdtempSync(join(tmpdir(), 'openmeido-e2e-'))
app.setPath('userData', tempUserData)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(ok ? `  ✅ ${name}` : `  ❌ ${name}  ::  ${detail}`)
}

async function decodeTablePayload(url) {
  const m = url.match(/#data=([^&]+)/)
  if (!m) return null
  try {
    const b64 = decodeURIComponent(m[1])
    const json = Buffer.from(b64, 'base64').toString('utf-8')
    return JSON.parse(json)
  } catch {
    return null
  }
}

async function main() {
  const { register } = await import('tsx/esm/api')
  register()

  // Seed a minimal config with DeepSeek as the chat backend BEFORE memory
  // / chat-host modules run their getConfig() calls.
  const { setConfig } = await import('../src/main/config.ts')
  // Gemini Flash: fast, native @ai-sdk/google adapter (handles
  // thinking-mode reasoning_content roundtrip cleanly, unlike DeepSeek V4
  // Pro on the OpenAI-compat path). Matches the user's actual production
  // backend (googleapis.com), so this E2E exercises the same agentic
  // loop they hit in dev.
  const apiKey = process.env.GEMINI_API_KEY ?? ''
  if (!apiKey) {
    console.error('[e2e] GEMINI_API_KEY not set')
    process.exit(1)
  }
  const baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai'
  setConfig({
    backend: {
      baseUrl,
      apiKey,
      model: 'gemini-3.5-flash',
      apiKeys: { [baseUrl]: apiKey },
      searchEnabled: false,
    },
    persona: { preset: 'maid', customs: [] },
    live2d: { activeModel: 'hiyori_pro_en', portraitZoom: 1.0 },
    window: {
      alwaysOnTop: false,
      width: 480,
      height: 720,
      startAtLogin: false,
      clickThroughTransparent: false,
      summonHotkey: '',
      transparentBackground: false,
      backgroundZoom: 1,
      customBackgrounds: {},
    },
    mail: {
      enabled: true,
      host: '',
      port: 993,
      secure: true,
      username: '',
      password: '',
      passwordEncrypted: true,
    },
    memory: { topK: 5, recentN: 12, imageRecallTurns: 3 },
    voice: { tts: { enabled: false, voice: 'zh-CN-XiaoxiaoNeural', mouthGain: 3.5 } },
    proactive: { enabled: false, intervalMin: 30, idleMin: 10 },
    notif: { enabled: false, ringChannels: [] },
    ui: { fontScale: 1, demosShown: 0 },
  })

  await app.whenReady()

  const { initMemory } = await import('../src/main/memory-host.ts')
  await initMemory()

  // Capture every BrowserWindow created during the test. The table-host
  // calls `new BrowserWindow(...)` directly; we read its URL after load
  // to extract the table payload. Hide them to keep the test invisible.
  const capturedTableWindows = []
  app.on('browser-window-created', (_e, win) => {
    win.setOpacity(0)
    win.webContents.on('did-finish-load', async () => {
      const url = win.webContents.getURL()
      const payload = await decodeTablePayload(url)
      if (payload) {
        capturedTableWindows.push({ url, payload })
        console.log(
          `  [captured] table title="${payload.title}" cols=${payload.columns.length} rows=${payload.rows.length}`,
        )
      }
    })
  })

  const { runChat } = await import('../src/main/chat.ts')

  async function runTurn(label, userText) {
    console.log(`\n████ ${label}: "${userText}" ████`)
    const events = []
    const tStart = Date.now()
    await new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolve()
      }
      void runChat(
        `e2e-${Date.now()}`,
        userText,
        undefined,
        (e) => {
          events.push(e)
          if (e.type === 'done' || e.type === 'error') {
            // small delay to let pendingly-opened windows finish loading
            setTimeout(finish, 1500)
          }
        },
      )
      // Safety timeout — 90s for a full chat turn (slow LLM + tools).
      setTimeout(finish, 90_000)
    })
    const tools = events.filter((e) => e.type === 'tool-call').map((e) => e.toolName)
    const text = events
      .filter((e) => e.type === 'text')
      .map((e) => e.delta)
      .join('')
    console.log(`  finished in ${((Date.now() - tStart) / 1000).toFixed(1)}s`)
    console.log(`  tools called: [${tools.join(', ')}]`)
    console.log(`  text out: "${text.slice(0, 120)}${text.length > 120 ? '…' : ''}"`)
    return { events, tools, text }
  }

  // ─── Turn 1: initial summary ───
  capturedTableWindows.length = 0
  const r1 = await runTurn('Turn 1', '总结最近 10 封邮件')
  check('T1 model called listRecentEmails', r1.tools.includes('listRecentEmails'))
  check('T1 model called presentTable', r1.tools.includes('presentTable'))
  const tbl1 = capturedTableWindows[capturedTableWindows.length - 1]
  check('T1 table window captured', !!tbl1)
  if (tbl1) {
    check('T1 rows > 0', tbl1.payload.rows.length > 0, `got ${tbl1.payload.rows.length}`)
    check(
      'T1 has subject/from-ish columns',
      tbl1.payload.columns.some((c) => /主题|subject/i.test(c)) &&
        tbl1.payload.columns.some((c) => /发件人|from/i.test(c)),
      `cols=${tbl1.payload.columns.join(',')}`,
    )
    // Structural assertion for the new array-of-arrays schema: every row
    // is an array with length matching columns, and cells aren't all
    // empty (catches the "model output empty rows" failure mode that
    // earlier object-keyed runs surfaced as "mismatched keys").
    const firstRow = tbl1.payload.rows[0]
    check(
      'T1 row is an array (array-of-arrays schema)',
      Array.isArray(firstRow),
      `first row type=${typeof firstRow}`,
    )
    if (Array.isArray(firstRow)) {
      check(
        'T1 row length matches columns length',
        firstRow.length === tbl1.payload.columns.length,
        `row len=${firstRow.length} cols len=${tbl1.payload.columns.length}`,
      )
      const filledCells = tbl1.payload.rows
        .flat()
        .filter((v) => v !== null && v !== undefined && v !== '').length
      const totalCells = tbl1.payload.rows.length * tbl1.payload.columns.length
      check(
        'T1 cells are mostly filled (>50%)',
        filledCells / totalCells > 0.5,
        `${filledCells}/${totalCells} filled`,
      )
    }
  }
  check(
    'T1 model did NOT batch readEmail (≤ 2 calls)',
    r1.tools.filter((t) => t === 'readEmail').length <= 2,
    `readEmail x ${r1.tools.filter((t) => t === 'readEmail').length}`,
  )
  check(
    'T1 model did NOT hallucinate "已开" without presentTable',
    !/已开|打开|展示了表格/.test(r1.text) || r1.tools.includes('presentTable'),
  )

  // ─── Turn 2: iterative refinement ───
  const beforeT2Count = capturedTableWindows.length
  const r2 = await runTurn('Turn 2', '再加一列时间')
  check('T2 model called presentTable again', r2.tools.includes('presentTable'))
  const tbl2 = capturedTableWindows[capturedTableWindows.length - 1]
  if (tbl2 && capturedTableWindows.length > beforeT2Count) {
    check('T2 still has rows', tbl2.payload.rows.length > 0, `got ${tbl2.payload.rows.length}`)
    check(
      'T2 added 时间 column',
      tbl2.payload.columns.some((c) => /时间|time|日期|date/i.test(c)),
      `cols=${tbl2.payload.columns.join(',')}`,
    )
  } else {
    check('T2 produced a new table view', false, 'no new captured window')
  }

  // Summary
  const failed = results.filter((r) => !r.ok)
  const passed = results.length - failed.length
  console.log(
    `\n${failed.length === 0 ? '✅' : '❌'} ${passed}/${results.length} assertions passed`,
  )
  if (failed.length > 0) {
    console.log('\nFailed:')
    for (const f of failed) console.log(`  · ${f.name}${f.detail ? ` :: ${f.detail}` : ''}`)
  }

  try {
    rmSync(tempUserData, { recursive: true, force: true })
  } catch {}
  app.exit(failed.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('[e2e] crashed:', err)
  try {
    rmSync(tempUserData, { recursive: true, force: true })
  } catch {}
  app.exit(1)
})
