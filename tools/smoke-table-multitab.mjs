/**
 * Smoke test: multi-tab table-host wiring.
 *
 * Drives openTableWindow through the four cases the presentTable tool
 * description promises and asserts that the window's URL hash carries
 * the right `tabs` array shape after each call. Renderer-side tab
 * switching / closing is intentionally NOT covered here — it's
 * pure-DOM logic exercised in the table.html script, and adding a
 * JSDOM harness for it would be much heavier than the value.
 *
 * Cases:
 *   1. openTableWindow(A)                       → window with 1 tab [A]
 *   2. openTableWindow(B, addAsTab: true)       → same window, 2 tabs [A, B]
 *   3. openTableWindow(C, addAsTab: true)       → same window, 3 tabs [A, B, C]
 *   4. openTableWindow(D) [default replace]     → same window, 1 tab  [D]
 *   5. openTableWindow(E, newWindow: true)      → NEW window, 1 tab   [E]
 *      + the previous window's state is no longer tracked (E's window
 *        becomes the new "latest")
 *
 * Run: electron tools/smoke-table-multitab.mjs
 */

import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// In dev (electron-vite) the renderer is served at ELECTRON_RENDERER_URL,
// and in packaged builds the bundled file lives at out/renderer/table.html.
// Neither holds inside a tsx-driven smoke test, so we point table-host
// at the real source file via the same env var the dev path uses. Without
// this, loadURL hits ERR_FILE_NOT_FOUND on every load.
const __testDir = dirname(fileURLToPath(import.meta.url))
process.env.ELECTRON_RENDERER_URL = 'file:///' + join(__testDir, '../src/renderer/public').replace(/\\/g, '/')

async function main() {
  const { register } = await import('tsx/esm/api')
  register()
  const { openTableWindow, closeAllTableWindows } = await import(
    '../src/main/table-host.ts'
  )

  await app.whenReady()

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

  /** Decode the latest table window's URL hash back into the bundle. */
  function readBundle(win) {
    if (!win || win.isDestroyed()) return null
    const url = win.webContents.getURL()
    const m = url.match(/#data=([^&]+)/)
    if (!m) return null
    try {
      const json = Buffer.from(decodeURIComponent(m[1]), 'base64').toString('utf-8')
      return JSON.parse(json)
    } catch (err) {
      console.error('[smoke] decode failed:', err)
      return null
    }
  }

  /** Wait until the window's URL no longer equals `prevUrl`. Handles
   *  both full reloads (new file load) and same-doc hash navigations
   *  uniformly — neither necessarily fires the same Electron event. */
  async function waitForUrlChange(win, prevUrl, timeoutMs = 4000) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (!win || win.isDestroyed()) return null
      const cur = win.webContents.getURL()
      if (cur && cur !== prevUrl) return cur
      await new Promise((r) => setTimeout(r, 30))
    }
    return win.webContents.getURL()
  }

  /** Wait for ANY URL to appear (initial open case). */
  async function waitForFirstUrl(win, timeoutMs = 4000) {
    return waitForUrlChange(win, '', timeoutMs)
  }

  const A = { title: 'Table A', columns: ['a', 'b'], rows: [['1', '2']] }
  const B = { title: 'Table B', columns: ['x'], rows: [['hi']] }
  const C = { title: 'Table C', columns: ['c1', 'c2'], rows: [[1, 2]] }
  const D = { title: 'Table D (replace)', columns: ['k'], rows: [['only']] }
  const E = { title: 'Table E (new window)', columns: ['e'], rows: [['z']] }

  // ---- Case 1: initial open ----
  console.log('\n[1] openTableWindow(A)')
  openTableWindow(A)
  let win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  check('window opened', !!win)
  await waitForFirstUrl(win)
  let prevUrl = win.webContents.getURL()
  let bundle = readBundle(win)
  check('1 tab', bundle?.tabs?.length === 1)
  check('tab[0].title is "Table A"', bundle?.tabs?.[0]?.title === 'Table A')
  check('activeIndex is 0', bundle?.activeIndex === 0)
  const winId1 = win.id

  // ---- Case 2: addAsTab ----
  console.log('\n[2] openTableWindow(B, { addAsTab: true })')
  openTableWindow(B, { addAsTab: true })
  await waitForUrlChange(win, prevUrl)
  prevUrl = win.webContents.getURL()
  bundle = readBundle(win)
  check('still same window', win.id === winId1)
  check('2 tabs', bundle?.tabs?.length === 2, JSON.stringify(bundle))
  check('tab[0] is still A', bundle?.tabs?.[0]?.title === 'Table A')
  check('tab[1] is B', bundle?.tabs?.[1]?.title === 'Table B')
  check('activeIndex points at the new tab (1)', bundle?.activeIndex === 1)

  // ---- Case 3: another addAsTab ----
  console.log('\n[3] openTableWindow(C, { addAsTab: true })')
  openTableWindow(C, { addAsTab: true })
  await waitForUrlChange(win, prevUrl)
  prevUrl = win.webContents.getURL()
  bundle = readBundle(win)
  check('3 tabs', bundle?.tabs?.length === 3, JSON.stringify(bundle))
  check('tab[2] is C', bundle?.tabs?.[2]?.title === 'Table C')
  check('activeIndex is 2', bundle?.activeIndex === 2)

  // ---- Case 4: default (replace) wipes tabs ----
  console.log('\n[4] openTableWindow(D) — default replaces all tabs')
  openTableWindow(D)
  await waitForUrlChange(win, prevUrl)
  prevUrl = win.webContents.getURL()
  bundle = readBundle(win)
  check('still same window', win.id === winId1)
  check('back down to 1 tab', bundle?.tabs?.length === 1, JSON.stringify(bundle))
  check('tab[0] is D (others discarded)', bundle?.tabs?.[0]?.title === 'Table D (replace)')

  // ---- Case 5: newWindow spawns a fresh BrowserWindow ----
  console.log('\n[5] openTableWindow(E, { newWindow: true })')
  const beforeCount = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length
  openTableWindow(E, { newWindow: true })
  // Find the NEW window — the one with an id != winId1.
  let win2 = null
  const t0 = Date.now()
  while (Date.now() - t0 < 3000) {
    const all = BrowserWindow.getAllWindows().filter(
      (w) => !w.isDestroyed() && w.id !== winId1,
    )
    if (all.length > 0) {
      win2 = all[0]
      break
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  check('a second window was created', !!win2 && win2.id !== winId1)
  let win2Prev = ''
  if (win2) {
    await waitForFirstUrl(win2)
    win2Prev = win2.webContents.getURL()
    const bundle2 = readBundle(win2)
    check('new window has 1 tab', bundle2?.tabs?.length === 1, JSON.stringify(bundle2))
    check('new window tab[0] is E', bundle2?.tabs?.[0]?.title === 'Table E (new window)')
  }
  const afterCount = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length
  check('window count increased by 1', afterCount === beforeCount + 1, `${beforeCount} → ${afterCount}`)

  // ---- Case 6: a SUBSEQUENT addAsTab targets the latest window (win2). ----
  console.log('\n[6] openTableWindow(A, { addAsTab: true }) after newWindow — should append to win2')
  openTableWindow(A, { addAsTab: true })
  await waitForUrlChange(win2, win2Prev)
  const bundle3 = readBundle(win2)
  check('addAsTab went to the most-recent window (win2), not winId1', bundle3?.tabs?.length === 2, JSON.stringify(bundle3))
  check('win2 tab[1] is A', bundle3?.tabs?.[1]?.title === 'Table A')

  // ---- Cleanup ----
  closeAllTableWindows()
  await new Promise((r) => setTimeout(r, 200))

  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('[smoke] crashed:', err)
  process.exit(1)
})
