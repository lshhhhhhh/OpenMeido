/**
 * Auto-update host — wires electron-updater to GitHub Releases.
 *
 * Flow:
 *   1. App finishes booting (creates main window). After 30s grace we
 *      query GitHub Releases for the latest published version.
 *   2. If newer than current, autoUpdater downloads it in the background
 *      (~20-30 MB delta thanks to .blockmap). User keeps using the app.
 *   3. When download completes, we broadcast `updater:downloaded` with
 *      the new version string. Renderer renders a pill in the corner:
 *      "v0.X.Y 已就绪，立即重启更新".
 *   4. User clicks pill → renderer invokes `updater:install` → main
 *      calls autoUpdater.quitAndInstall() → NSIS installer takes over,
 *      app relaunches on the new version.
 *
 * Skipped entirely in dev (app.isPackaged === false) because electron-
 * updater requires a real installed binary to manage.
 *
 * Periodic re-check every 6 h handles users who leave the app running
 * for days at a time (the long-running-companion use case).
 *
 * Existing users on versions WITHOUT this code (≤ v0.1.5) won't auto-
 * update — they have to install v0.1.6 manually one time. From v0.1.6
 * onward, every release flows automatically.
 */

import { app, BrowserWindow, ipcMain } from 'electron'
import pkg from 'electron-updater'
const { autoUpdater } = pkg

import { getConfig, onConfigChange } from './config.js'

const FIRST_CHECK_DELAY_MS = 30_000
const PERIODIC_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

let initialized = false

/**
 * Apply the configured mirror choice to electron-updater. Called at
 * init and on config change so users can flip the toggle without
 * relaunching. The 'github' branch resets back to the publish config
 * shipped in electron-builder.yml (owner/repo); the 'ghproxy' branch
 * uses a generic provider pointed at the ghproxy CDN, which fronts
 * GitHub from inside CN at 1-5 MB/s (vs sub-100KB/s direct).
 */
function applyMirrorConfig(): void {
  if (!app.isPackaged) return
  const mirror = getConfig().updater.mirror
  try {
    if (mirror === 'ghproxy') {
      // ghproxy.com transparently proxies GitHub. The /releases/latest/
      // download/ URL resolves to the most recent release's assets,
      // including latest.yml — electron-updater's generic provider
      // fetches latest.yml from <url>/latest.yml then the installer
      // from <url>/<filename>. Same bytes as github direct; same
      // signature; just a different transport.
      autoUpdater.setFeedURL({
        provider: 'generic',
        url: 'https://ghproxy.com/https://github.com/lshhhhhhh/OpenMeido/releases/latest/download',
      })
      console.log('[updater] using ghproxy mirror')
    } else {
      autoUpdater.setFeedURL({
        provider: 'github',
        owner: 'lshhhhhhh',
        repo: 'OpenMeido',
      })
      console.log('[updater] using github direct')
    }
  } catch (err) {
    console.warn('[updater] setFeedURL failed:', err)
  }
}

/**
 * Last broadcast state from the updater, kept here so a renderer that
 * mounts AFTER an event was already broadcast can catch up via the
 * `updater:queryState` IPC. v0.1.6's UpdaterPill missed the
 * update-downloaded event because download completed before the React
 * tree was ready — by the time onDownloaded subscribed, the event had
 * already fired into the void. Replay-via-query fixes that whole class
 * of race regardless of how fast or slow the update check resolves.
 */
type UpdaterReplayState =
  | { kind: 'idle' }
  | { kind: 'available'; version: string }
  | { kind: 'progress'; version: string; percent: number; bytesPerSecond: number }
  | { kind: 'downloaded'; version: string }
let lastState: UpdaterReplayState = { kind: 'idle' }

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

export function initUpdater(): void {
  if (initialized) return
  initialized = true

  // Register no-op IPC handlers FIRST, regardless of packaged state.
  // Without these, dev-mode renderers calling `updater.queryState()` on
  // mount would throw "No handler registered for 'updater:queryState'"
  // and pollute the console. In dev we just return safe stubs so the
  // UpdaterPill renders as if there were no update.
  ipcMain.handle('updater:queryState', () => lastState)
  ipcMain.handle('updater:checkNow', () => {
    if (!app.isPackaged) {
      console.log('[updater] dev mode — checkNow no-op')
      return null
    }
    console.log('[updater] manual check requested')
    return autoUpdater.checkForUpdates().catch((err) => {
      console.warn('[updater] manual check failed:', err)
      return null
    })
  })
  ipcMain.handle('updater:download', async () => {
    if (!app.isPackaged) {
      console.log('[updater] dev mode — download no-op')
      return
    }
    console.log('[updater] user consented — starting download')
    try {
      await autoUpdater.downloadUpdate()
    } catch (err) {
      console.warn('[updater] download failed:', err)
    }
  })
  ipcMain.handle('updater:install', () => {
    if (!app.isPackaged) {
      console.log('[updater] dev mode — install no-op')
      return
    }
    console.log('[updater] user requested install — quit + apply')
    autoUpdater.quitAndInstall(false, true)
  })

  // Dev mode: stop here. Don't subscribe to autoUpdater events or
  // start the periodic check — those need a real installed binary
  // (no app-update.yml on disk in dev, autoUpdater would throw).
  if (!app.isPackaged) {
    console.log('[updater] dev mode — skipping periodic check + event subscriptions')
    return
  }

  // Opt-in everything. We DON'T auto-download — silently pulling
  // ~395 MB after detecting a new version feels invasive (especially
  // on metered connections / mobile hotspots). Flow:
  //   1. We detect update available, broadcast updater:available
  //   2. Renderer shows a banner "发现新版本 v0.X.Y — 立即更新"
  //   3. User clicks the banner button → renderer invokes
  //      updater:download → main calls autoUpdater.downloadUpdate()
  //   4. Download starts, progress flows via updater:progress events
  //   5. On complete, updater:downloaded broadcasts; user clicks
  //      "立即重启" → updater:install → quitAndInstall
  autoUpdater.autoDownload = false
  // If user consents + download finishes + they don't click "立即
  // 重启" but instead quit normally via X — apply on next launch.
  autoUpdater.autoInstallOnAppQuit = true

  // Apply the user's mirror choice (default github, optional ghproxy
  // for CN users). Must happen BEFORE the first checkForUpdates fires
  // so the initial poll respects the setting.
  applyMirrorConfig()
  // Re-apply on config change so toggling in Settings takes effect
  // without a relaunch. The next checkForUpdates (manual or periodic)
  // will use the new feed URL.
  let lastMirror = getConfig().updater.mirror
  onConfigChange((next) => {
    if (next.updater.mirror !== lastMirror) {
      lastMirror = next.updater.mirror
      applyMirrorConfig()
    }
  })

  autoUpdater.on('checking-for-update', () => {
    console.log('[updater] checking for updates...')
  })
  autoUpdater.on('update-available', (info) => {
    console.log(`[updater] update available: ${info.version}`)
    lastState = { kind: 'available', version: info.version }
    broadcast('updater:available', { version: info.version })
  })
  autoUpdater.on('update-not-available', (info) => {
    console.log(`[updater] up-to-date (current=${info.version})`)
    // Don't update lastState — `not-available` is transient; we don't
    // want a renderer that mounts later to think "no update" forever
    // until the next 6h periodic check. queryState defaults to 'idle'
    // which is exactly that: no banner, normal state.
    broadcast('updater:not-available', { version: info.version })
  })
  autoUpdater.on('download-progress', (p) => {
    // Quiet log — periodic updates flooding the console isn't useful.
    // The progress events fire many times per second; we update
    // lastState with the latest so a renderer mounting mid-download
    // can jump straight to the progress bar.
    lastState = {
      kind: 'progress',
      version:
        lastState.kind === 'available' ||
        lastState.kind === 'progress' ||
        lastState.kind === 'downloaded'
          ? lastState.version
          : '?',
      percent: p.percent,
      bytesPerSecond: p.bytesPerSecond,
    }
    broadcast('updater:progress', {
      percent: p.percent,
      bytesPerSecond: p.bytesPerSecond,
      transferred: p.transferred,
      total: p.total,
    })
  })
  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[updater] download complete: ${info.version}`)
    lastState = { kind: 'downloaded', version: info.version }
    broadcast('updater:downloaded', { version: info.version })
  })
  autoUpdater.on('error', (err) => {
    // Common failures: offline, github API rate-limit, signature
    // mismatch. None should crash the app — log and move on. Renderer
    // doesn't need to know about silent background errors.
    console.warn('[updater] error:', err instanceof Error ? err.message : err)
  })

  // First check is delayed so it doesn't compete with app boot
  // (memory init, model warmup, greeting LLM call). 30 s is short
  // enough to catch users who launch + leave the app running.
  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch((err) => {
      console.warn('[updater] initial check failed:', err)
    })
  }, FIRST_CHECK_DELAY_MS)

  // Periodic re-check — desktop-companion users leave the app running
  // for days, so without this they'd never see updates without an app
  // restart.
  setInterval(() => {
    void autoUpdater.checkForUpdates().catch((err) => {
      console.warn('[updater] periodic check failed:', err)
    })
  }, PERIODIC_CHECK_INTERVAL_MS)

  // (All four updater IPC handlers are registered up top before the
  // dev-mode short-circuit — see the block right after `initialized`
  // is set. Putting them there keeps them reachable in dev too,
  // returning safe stubs instead of throwing "no handler" at the
  // renderer's queryState-on-mount.)
}
