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
 */

import { app, BrowserWindow, shell } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ESM-safe __dirname. electron-vite injects this for the bundled
// main, but the unit smoke test loads this file via tsx-as-ESM where
// the injection doesn't happen — so we derive it from import.meta.url
// to work in both contexts.
const __filename = fileURLToPath(import.meta.url)
const __dirnameLocal = dirname(__filename)

export interface TablePayload {
  title?: string
  columns: string[]
  /**
   * Each row is an ARRAY of cell values in the same order as `columns`.
   * Position-based (like CSV / spreadsheet) — not keyed by column
   * name. This sidesteps the entire "model must use the right key
   * name" failure mode: there are no keys to get wrong.
   */
  rows: (string | number | null | undefined)[][]
}

export interface OpenTableOptions {
  /** Force a fresh window even when a previous table window is still
   *  open. Default false → updates the most recent live table window
   *  in place (single-table editing UX). Pass true when the model
   *  detects "新开一个" / "另存一份" intent. */
  newWindow?: boolean
}

/** Most recent table window. Used to update-in-place when the user
 *  iterates on the same table ("再加一列时间", "隐藏 X"). Cleared on
 *  the window's `closed` event. */
let latestTableWindow: BrowserWindow | null = null

/** Hand-off: encode the payload into URL hash. Hash (not query) so
 *  Electron's protocol handlers don't mangle it and so it doesn't end
 *  up in any access log. */
function buildUrl(payload: TablePayload): string {
  const json = JSON.stringify(payload)
  const b64 = Buffer.from(json, 'utf-8').toString('base64')
  const hash = `#data=${encodeURIComponent(b64)}`
  const base = process.env.ELECTRON_RENDERER_URL
    ? `${process.env.ELECTRON_RENDERER_URL}/table.html`
    : `file://${join(__dirnameLocal, '../renderer/table.html')}`
  const url = `${base}${hash}`
  console.log(
    `[table-host] buildUrl base="${base}" payloadBytes=${json.length} hashBytes=${hash.length}`,
  )
  return url
}

/**
 * Open OR update a table window showing the given payload.
 *
 * Default behavior — if a table window opened in this session is
 * still alive, reload it with the new payload. This implements the
 * "single edited table" UX: user says "再加一列时间", the same window
 * just refreshes. Pass `newWindow: true` to bypass this and force a
 * fresh window (for "另存一份" / "新开对比" intents).
 */
export function openTableWindow(payload: TablePayload, opts: OpenTableOptions = {}): void {
  console.log(
    `[table-host] openTableWindow rows=${payload.rows.length} cols=${payload.columns.length} ` +
      `newWindow=${Boolean(opts.newWindow)} latestAlive=${
        latestTableWindow && !latestTableWindow.isDestroyed() ? 'yes' : 'no'
      }`,
  )

  // Empty-rows guard. Models sometimes call presentTable twice — once with
  // data, then a second time with rows=[] as a "confirmation" or before
  // the model has actually assembled the rows. Without this guard the
  // replace-in-place logic would overwrite the good first table with the
  // empty second call. Bail early; the existing window keeps its content.
  if (payload.rows.length === 0) {
    console.warn('[table-host] refusing to open / replace with empty rows')
    return
  }
  // Update-in-place path.
  if (
    !opts.newWindow &&
    latestTableWindow &&
    !latestTableWindow.isDestroyed()
  ) {
    console.log('[table-host] reusing existing window — loadURL with new hash')
    latestTableWindow.setTitle(payload.title ? `报表: ${payload.title}` : '报表')
    void latestTableWindow.loadURL(buildUrl(payload))
    latestTableWindow.focus()
    return
  }
  console.log('[table-host] creating new BrowserWindow')

  const focused = BrowserWindow.getFocusedWindow()
  const parentBounds = focused?.getBounds()
  const offset = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length * 24
  const win = new BrowserWindow({
    width: 920,
    height: 600,
    minWidth: 480,
    minHeight: 300,
    x: parentBounds ? parentBounds.x + 40 + offset : undefined,
    y: parentBounds ? parentBounds.y + 60 + offset : undefined,
    title: payload.title ? `报表: ${payload.title}` : '报表',
    backgroundColor: '#1e1f29',
    // Tables are read-mostly; auto-hide menu is friendlier than the
    // companion window's frameless transparent shell.
    autoHideMenuBar: true,
    webPreferences: {
      // No preload for the table window — it's self-contained vanilla
      // JS that needs no IPC. Smaller attack surface and faster load.
      sandbox: true,
      contextIsolation: true,
    },
  })

  // External links (e.g. if a row value happens to be a URL the user
  // clicks) open in the real browser, not inside this window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Diagnostic — surface load failures (404, file-not-found) loudly so
  // "window didn't open" can be triaged from the log without DevTools.
  win.webContents.on('did-fail-load', (_e, code, desc, validatedURL) => {
    console.warn(
      `[table-host] did-fail-load code=${code} desc="${desc}" url="${validatedURL}"`,
    )
  })
  win.webContents.on('did-finish-load', () => {
    console.log('[table-host] window did-finish-load')
  })

  // Track for update-in-place. Clear when the user closes it so the
  // next `presentTable` call opens fresh instead of trying to write to
  // a destroyed BrowserWindow handle.
  latestTableWindow = win
  win.on('closed', () => {
    if (latestTableWindow === win) latestTableWindow = null
  })

  void win.loadURL(buildUrl(payload))
}

/** Test seam. Closes every open table window (matched by title prefix
 *  since we don't track them in a registry). Called nowhere yet — kept
 *  for the eventual "close all reports" UI / test cleanup. */
export function closeAllTableWindows(): void {
  if (!app) return
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && w.getTitle().startsWith('报表')) w.close()
  }
}
