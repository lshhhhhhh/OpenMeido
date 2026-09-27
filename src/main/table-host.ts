/**
 * Table-window host. Creates a separate BrowserWindow that loads the
 * dependency-free `table.html` page, with table data passed in via
 * URL hash.
 *
 * Lifecycle: ephemeral. Each call spawns a new window; user closes
 * when done. No persistence — past tables live in chat history as
 * tool results and can be regenerated on demand. Avoiding a "saved
 * reports" feature keeps the design simple and matches the productivity
 * mental model: tables are *current snapshots*, not durable assets.
 *
 * Multi-tab (v0.0.34+): one BrowserWindow can host multiple tables as
 * tabs so the user can compare side-by-side reports without juggling
 * windows. The main process owns the tab list per window; on
 * `addAsTab`, the new payload is pushed and the renderer re-renders.
 * The renderer is still self-contained vanilla JS — tabs travel in
 * the URL hash like the single-table payload always has.
 */

import { app, BrowserWindow, shell } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirnameLocal = dirname(__filename)

export interface TablePayload {
  title?: string
  columns: string[]
  /**
   * Each row is an ARRAY of cell values in the same order as `columns`.
   * Position-based (like CSV / spreadsheet) — not keyed by column name.
   * Sidesteps the "model must use the right key name" failure mode.
   */
  rows: (string | number | null | undefined)[][]
}

/** Wire format for the renderer. Single-tab payloads are still
 *  accepted (the renderer treats them as `{tabs: [payload]}`). */
interface TabsBundle {
  tabs: TablePayload[]
  /** Which tab the renderer should show on load. Defaults to last. */
  activeIndex?: number
}

export interface OpenTableOptions {
  /** Spawn a fresh BrowserWindow even when one exists. Use for "另存一份"
   *  intents where the user wants a totally separate window stream. */
  newWindow?: boolean
  /** Append this payload as a new tab to the existing window (if any).
   *  When no window exists, behaves like a normal open (single tab).
   *  Mutually exclusive with `newWindow` — `newWindow` wins. */
  addAsTab?: boolean
}

/** Most recent table window + the tab list it currently shows. The
 *  tab list lives in the main process so we can append on `addAsTab`
 *  without round-tripping through the renderer. Cleared on window
 *  `closed`. */
let latestTableWindow: BrowserWindow | null = null
let latestTabs: TablePayload[] = []

function buildUrl(bundle: TabsBundle): string {
  const json = JSON.stringify(bundle)
  const b64 = Buffer.from(json, 'utf-8').toString('base64')
  const hash = `#data=${encodeURIComponent(b64)}`
  // Dev server only when unpackaged — a stray ELECTRON_RENDERER_URL in a
  // packaged app's environment must not point this window (which renders
  // email subjects etc.) at some other origin.
  const devUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL
  const base = devUrl
    ? `${devUrl}/table.html`
    : `file://${join(__dirnameLocal, '../renderer/table.html')}`
  const url = `${base}${hash}`
  console.log(
    `[table-host] buildUrl tabs=${bundle.tabs.length} payloadBytes=${json.length} hashBytes=${hash.length}`,
  )
  return url
}

function isHttpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** Generic title used when no single tab's title can be promoted to
 *  the window chrome (e.g. multi-tab case where each tab has its own). */
function windowTitleFor(bundle: TabsBundle): string {
  if (bundle.tabs.length === 1) {
    const t = bundle.tabs[0]?.title
    return t ? `报表: ${t}` : '报表'
  }
  return `报表 (${bundle.tabs.length} 个)`
}

/**
 * Open / update / append a table window.
 *
 * Decision matrix:
 *   newWindow=true               → always spawn a fresh window (1 tab)
 *   addAsTab=true, window alive  → append payload to existing tabs
 *   addAsTab=true, no window     → open new window with this single tab
 *   default, window alive        → replace existing tabs with [payload]
 *   default, no window           → open new window with this single tab
 */
export function openTableWindow(payload: TablePayload, opts: OpenTableOptions = {}): void {
  console.log(
    `[table-host] openTableWindow rows=${payload.rows.length} cols=${payload.columns.length} ` +
      `newWindow=${Boolean(opts.newWindow)} addAsTab=${Boolean(opts.addAsTab)} ` +
      `latestAlive=${latestTableWindow && !latestTableWindow.isDestroyed() ? 'yes' : 'no'}`,
  )

  // Empty-rows guard. Models sometimes call presentTable twice — once with
  // data, then a second time with rows=[] as a "confirmation". Without this
  // guard the replace-in-place logic would overwrite the good first table.
  if (payload.rows.length === 0) {
    console.warn('[table-host] refusing to open / replace with empty rows')
    return
  }

  const alive = latestTableWindow && !latestTableWindow.isDestroyed()

  // Update-in-place path (default or addAsTab) — reuse the window.
  if (!opts.newWindow && alive && latestTableWindow) {
    const nextTabs = opts.addAsTab ? [...latestTabs, payload] : [payload]
    latestTabs = nextTabs
    const bundle: TabsBundle = { tabs: nextTabs, activeIndex: nextTabs.length - 1 }
    console.log(
      `[table-host] reusing window — ${opts.addAsTab ? 'append tab' : 'replace tabs'} ` +
        `(now ${nextTabs.length} tabs)`,
    )
    latestTableWindow.setTitle(windowTitleFor(bundle))
    void latestTableWindow.loadURL(buildUrl(bundle))
    latestTableWindow.focus()
    return
  }

  console.log('[table-host] creating new BrowserWindow')
  const focused = BrowserWindow.getFocusedWindow()
  const parentBounds = focused?.getBounds()
  const offset = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length * 24
  const initialTabs: TablePayload[] = [payload]
  const bundle: TabsBundle = { tabs: initialTabs, activeIndex: 0 }
  const win = new BrowserWindow({
    width: 920,
    height: 600,
    minWidth: 480,
    minHeight: 300,
    x: parentBounds ? parentBounds.x + 40 + offset : undefined,
    y: parentBounds ? parentBounds.y + 60 + offset : undefined,
    title: windowTitleFor(bundle),
    backgroundColor: '#1e1f29',
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
    },
  })

  // Same policy as the main window (index.ts): only http(s) goes to the OS
  // browser. Table cells carry LLM / email-derived text, so a `file:`,
  // `ms-settings:` or custom-protocol URL must never reach openExternal.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // Our own loads come from loadURL (which doesn't emit will-navigate), so
  // anything that fires here is the page trying to leave — a clicked link,
  // a dropped file, a script. Keep the window on the table page; hash-only
  // changes and blob: downloads (CSV export) are left alone.
  win.webContents.on('will-navigate', (e, url) => {
    const current = win.webContents.getURL().split('#')[0]
    if (url.split('#')[0] === current || url.startsWith('blob:')) return
    e.preventDefault()
    if (isHttpUrl(url)) void shell.openExternal(url)
  })
  win.webContents.on('did-fail-load', (_e, code, desc, validatedURL) => {
    console.warn(
      `[table-host] did-fail-load code=${code} desc="${desc}" url="${validatedURL}"`,
    )
  })
  win.webContents.on('did-finish-load', () => {
    console.log('[table-host] window did-finish-load')
  })

  // Track for update-in-place + tab append. `opts.newWindow` spawns a
  // fresh window but we still promote it to `latestTableWindow` so the
  // NEXT presentTable call (without newWindow) updates this one.
  latestTableWindow = win
  latestTabs = initialTabs
  win.on('closed', () => {
    if (latestTableWindow === win) {
      latestTableWindow = null
      latestTabs = []
    }
  })

  void win.loadURL(buildUrl(bundle))
}

/** Test seam. */
export function closeAllTableWindows(): void {
  if (!app) return
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && w.getTitle().startsWith('报表')) w.close()
  }
}
