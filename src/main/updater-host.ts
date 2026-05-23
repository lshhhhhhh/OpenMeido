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

const FIRST_CHECK_DELAY_MS = 30_000
const PERIODIC_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

let initialized = false

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

  // Dev mode: don't touch the updater. autoUpdater throws if invoked
  // without a real installed binary (no app-update.yml on disk).
  if (!app.isPackaged) {
    console.log('[updater] dev mode — skipping')
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

  // IPC: renderer banner's "立即更新" button. User saw the available
  // notification and consented to download — start the actual file
  // transfer. Progress flows back via the on('download-progress')
  // listener above into updater:progress events. Completion fires
  // updater:downloaded.
  ipcMain.handle('updater:download', async () => {
    console.log('[updater] user consented — starting download')
    try {
      await autoUpdater.downloadUpdate()
    } catch (err) {
      console.warn('[updater] download failed:', err)
    }
  })

  // IPC: renderer pill's "立即重启更新" button. quitAndInstall ends
  // the current Electron process and lets NSIS swap the binary, then
  // launches the new one. We pass `isSilent=false, isForceRunAfter=true`
  // so user sees the standard installer flash (gives them a visible
  // signal something is happening) and the app reopens automatically
  // when done.
  ipcMain.handle('updater:install', () => {
    console.log('[updater] user requested install — quit + apply')
    autoUpdater.quitAndInstall(false, true)
  })

  // IPC: Settings → 关于 has a "检查更新" button that fires this on
  // demand instead of waiting for the 30 s post-boot or 6 h periodic
  // check. The result still flows through the same updater:available /
  // updater:not-available events (we already broadcast both), so the
  // UI doesn't need a synchronous return value — fire-and-forget plus
  // event subscription is the pattern.
  ipcMain.handle('updater:checkNow', () => {
    console.log('[updater] manual check requested')
    return autoUpdater.checkForUpdates().catch((err) => {
      console.warn('[updater] manual check failed:', err)
      return null
    })
  })

  // IPC: renderer queries this on mount to recover whatever state the
  // updater is in. Closes the race where update events fire before the
  // UpdaterPill component subscribes — replay on demand instead of
  // hoping the subscription beats the event.
  ipcMain.handle('updater:queryState', () => lastState)
}
