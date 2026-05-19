import { app, BrowserWindow, ipcMain, protocol, dialog, shell } from 'electron'
import { join, extname } from 'node:path'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { runChat } from './chat.js'
import { getConfig, setConfig, onConfigChange } from './config.js'
import { initMemory, getMemoryService, getMemoryInitError } from './memory-host.js'
import { initReminders, getReminderService } from './reminder-host.js'
import { initTasks, getTaskService } from './tasks-host.js'
import { testMailConfig } from './mail-host.js'
import { testBackend, runExtraction } from './chat-host.js'
import { readDemos, getDemosPath } from './demos-host.js'
import { captureAllScreensPng } from './screen-host.js'
import { listVoices as ttsListVoices, synthesize as ttsSynthesize } from './tts-host.js'
import {
  initProactive,
  noteAssistantActivity,
  noteUserActivity,
} from './proactive-host.js'
import { initNotifListener } from './notif-host.js'
import {
  initLive2DModels,
  listModels as live2dListModels,
  getSidecar as live2dGetSidecar,
  setSidecar as live2dSetSidecar,
  deleteModel as live2dDeleteModel,
  importZip as live2dImportZip,
  autoBindEmotions as live2dAutoBindEmotions,
  resolveModelFile,
} from './live2d-models-host.js'
import { IPC, type ChatSendPayload } from '../shared/ipc.js'
import { configSchema, ConfigIPC, type Config } from '../shared/config.js'
import type { ModelSidecar } from '../shared/live2d-models.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

// Force hardware-accelerated WebGL. Without these, Electron's renderer may
// fall back to software rendering (SwiftShader), where MAX_TEXTURE_IMAGE_UNITS
// returns 0 and PIXI's BatchRenderer init crashes. Must be set before
// app.whenReady().
app.commandLine.appendSwitch('ignore-gpu-blocklist')
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('enable-zero-copy')

// Last-resort safety net: AI SDK / streamText can sometimes propagate an
// error asynchronously (e.g. MissingToolResultsError thrown inside an
// unawaited Promise) that would otherwise crash the main process. We log
// it loudly but keep the app alive — losing one turn beats a 闪退.
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandled promise rejection:', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[main] uncaught exception:', err)
})

// Register the `meido-live2d://` scheme as standard + supportFetchAPI +
// stream so the renderer can `fetch()` it the same as a regular http URL.
// MUST run before app.whenReady — protocol.handle (registered later) needs
// the scheme to already exist in the privilege table.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'meido-live2d',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
      // Renderer runs on http://localhost:5173 in dev, file:// in prod —
      // either way `meido-live2d://` is cross-origin, so without this flag
      // Chromium drops fetches with "CORS policy" errors.
      corsEnabled: true,
    },
  },
])

// Load .env from project root. Available since Node 20.12 / 21.7,
// which Electron 33 (Node 20.18) ships with. Optional — falls back to
// whatever's already in process.env (e.g. shell-exported keys).
try {
  process.loadEnvFile(join(__dirname, '../../.env'))
} catch {
  // .env missing — OK in shipped builds (GUI config carries the keys).
}

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  const cfg = getConfig()

  const win = new BrowserWindow({
    width: cfg.window.width,
    height: cfg.window.height,
    minWidth: 260,
    minHeight: 400,
    transparent: true,
    frame: false,
    resizable: true,
    alwaysOnTop: cfg.window.alwaysOnTop,
    // Explicit fully-transparent backgroundColor. Electron defaults to
    // '#FFFFFF' which paints opaque white before the renderer's CSS even
    // loads — on Windows that white sometimes "wins" against transparent.
    // The 4-byte hex with leading zero alpha forces transparency.
    backgroundColor: '#00000000',
    // thickFrame defaults to true on Windows and is what makes the otherwise-
    // invisible edges of a frame:false window draggable for resize. Don't
    // disable it unless you ship CSS-based resize handles in the renderer.
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
    },
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Apply the persisted UI zoom on every load (covers HMR refresh in dev
  // and full restart in prod). did-finish-load fires after the renderer's
  // JS is ready, which is what setZoomFactor needs.
  win.webContents.on('did-finish-load', () => {
    const c = getConfig()
    win.webContents.setZoomFactor(c.ui.fontScale)
  })

  // Persist the user's manual resize so next launch opens at the same size.
  // We subtract the sidebar's contribution (when open) so the "natural" width
  // is what gets saved — otherwise opening the sidebar and then quitting
  // would lock in a permanently-wider window on next launch.
  win.on('resize', () => {
    if (win.isDestroyed()) return
    const size = win.getSize()
    const rawW = size[0] ?? cfg.window.width
    const h = size[1] ?? cfg.window.height
    const w = rawW - (sidebarOpenInMain ? SIDEBAR_WIDTH : 0)
    const current = getConfig()
    if (current.window.width !== w || current.window.height !== h) {
      setConfig({ ...current, window: { ...current.window, width: w, height: h } })
    }
  })

  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

}

// Apply live config changes to the running window where possible. width/height
// already persist via the resize listener above, so we don't push them back.
onConfigChange((next) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setAlwaysOnTop(next.window.alwaysOnTop)
    mainWindow.webContents.setZoomFactor(next.ui.fontScale)
  }
})

// ---- Chat IPC ----

ipcMain.on(IPC.ChatSend, (event, payload: ChatSendPayload) => {
  // Refresh the proactive observer's cooldown clocks so it doesn't speak
  // up while the user is actively chatting.
  noteUserActivity()
  void runChat(payload.messageId, payload.text, payload.images, (chatEvent) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send(IPC.ChatEvent, chatEvent)
    }
    if (chatEvent.type === 'done') noteAssistantActivity()
  })
})

// Window click-through (setIgnoreMouseEvents) was removed in a hotfix —
// it kept getting stuck in the ON state after modals closed, eating user
// clicks and silently breaking input focus. The window stays opaque to
// clicks now; visual transparency comes from `transparent: true` on the
// BrowserWindow alone.

// ---- TTS ----
ipcMain.handle('tts:listVoices', async () => {
  try {
    return await ttsListVoices()
  } catch (err) {
    console.warn('[tts] listVoices failed:', err)
    return []
  }
})
ipcMain.handle(
  'tts:synthesize',
  async (_event, payload: { text: string; override?: Config['tts'] }) => {
    try {
      return await ttsSynthesize(payload.text, payload.override)
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  },
)

ipcMain.handle('screen:capture', async () => {
  const all = await captureAllScreensPng()
  // Each entry is a base64 PNG — JSON-serialisable + small enough for IPC.
  return all.map((bytes) => ({
    mimeType: 'image/png',
    base64: Buffer.from(bytes).toString('base64'),
  }))
})

// ---- Config IPC ----

ipcMain.handle(ConfigIPC.Get, () => getConfig())
ipcMain.handle(ConfigIPC.Set, (_event, next: Config) => {
  // Re-validate at the boundary — never trust raw renderer payloads.
  const validated = configSchema.parse(next)
  return setConfig(validated)
})

// ---- Mail IPC ----

ipcMain.handle(
  'mail:test',
  (_event, payload: { cfg: Config['mail']; passwordPlaintext?: string }) =>
    testMailConfig(payload.cfg, payload.passwordPlaintext),
)

ipcMain.handle(
  'chat:test',
  (_event, payload: { cfg: Config['backend']; apiKeyOverride?: string }) =>
    testBackend(payload.cfg, payload.apiKeyOverride),
)

// ---- Memory IPC ----

ipcMain.handle('memory:status', async () => {
  const svc = getMemoryService()
  if (!svc) {
    return { ready: false as const, initError: getMemoryInitError() ?? undefined }
  }
  return {
    ready: true as const,
    count: await svc.count(),
    sessionId: svc.currentSession(),
  }
})
ipcMain.handle(
  'memory:listRecent',
  async (_event, limit: number = 50, sessionId?: string) => {
    const svc = getMemoryService()
    if (!svc) return []
    return svc.listRecent(limit, sessionId)
  },
)
ipcMain.handle('memory:listSessions', async () => {
  const svc = getMemoryService()
  if (!svc) return []
  return svc.listSessions()
})
ipcMain.handle('memory:clear', async () => {
  const svc = getMemoryService()
  if (!svc) return 0
  return svc.clearAll()
})
ipcMain.handle('memory:deleteSession', async (_event, sessionId: string) => {
  const svc = getMemoryService()
  if (!svc) return 0
  const wasActive = svc.currentSession() === sessionId
  const removed = await svc.deleteSession(sessionId)
  // If we just deleted the session we were writing into, the in-memory
  // sessionId would still point at it — next chat turn would resurrect the
  // session as a zero-episode bucket and the Settings dropdown would
  // re-add it as a "current session placeholder". Rotate to the next
  // most-recent real session, or mint a fresh one if none remain.
  if (wasActive) {
    const remaining = await svc.listSessions()
    const next = remaining.find((s) => s.id !== 'legacy')?.id
    if (next) svc.setSession(next)
    else svc.newSession()
  }
  return removed
})

ipcMain.handle('memory:listFacts', async (_event, limit?: number) => {
  const svc = getMemoryService()
  if (!svc) return []
  return svc.listFacts(limit)
})
ipcMain.handle('memory:clearFacts', async () => {
  const svc = getMemoryService()
  if (!svc) return 0
  return svc.clearFacts()
})
ipcMain.handle('memory:reflectNow', async () => {
  const svc = getMemoryService()
  if (!svc) return 0
  return svc.reflectOnce()
})

// ---- Reminder IPC ----

ipcMain.handle('reminders:list', async (_event, limit: number = 50) => {
  const svc = getReminderService()
  if (!svc) return []
  return svc.listAll(limit)
})
ipcMain.handle('reminders:cancel', async (_event, id: number) => {
  const svc = getReminderService()
  if (!svc) return false
  await svc.cancel(id)
  return true
})

// ---- Task IPC (unified reminders + TODOs) ----

ipcMain.handle('tasks:listAll', async (_event, recentDoneLimit: number = 5) => {
  const svc = getTaskService()
  if (!svc) return []
  return svc.listAll(recentDoneLimit)
})
ipcMain.handle(
  'tasks:add',
  async (
    _event,
    text: string,
    fireAt: string | null = null,
    dueAt: string | null = null,
  ) => {
    const svc = getTaskService()
    if (!svc) return null
    return svc.add({ text, fireAt, dueAt })
  },
)
ipcMain.handle('tasks:markDone', async (_event, id: number) => {
  const svc = getTaskService()
  if (!svc) return false
  return svc.markDone(id)
})
ipcMain.handle('tasks:markActive', async (_event, id: number) => {
  const svc = getTaskService()
  if (!svc) return false
  return svc.markActive(id)
})
ipcMain.handle('tasks:remove', async (_event, id: number) => {
  const svc = getTaskService()
  if (!svc) return false
  return svc.remove(id)
})

// ---- Sidebar window-resize ----

const SIDEBAR_WIDTH = 260
let sidebarOpenInMain = false

ipcMain.handle('sidebar:setOpen', async (_event, open: boolean) => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (open === sidebarOpenInMain) return // idempotent
  const size = mainWindow.getSize()
  const w = size[0] ?? 800
  const h = size[1] ?? 600
  sidebarOpenInMain = open
  mainWindow.setSize(w + (open ? SIDEBAR_WIDTH : -SIDEBAR_WIDTH), h)
})
ipcMain.handle('memory:newSession', () => {
  const svc = getMemoryService()
  if (!svc) return null
  return svc.newSession()
})
ipcMain.handle('memory:setSession', (_event, id: string) => {
  const svc = getMemoryService()
  if (!svc) return null
  svc.setSession(id)
  return id
})

void app.whenReady().then(async () => {
  // Seed bundled live2d models into userData on first run + register the
  // protocol that serves model files to the renderer. Must happen before
  // createWindow so the renderer's first fetch succeeds.
  await initLive2DModels()
  registerLive2DProtocol()
  // Eager-seed demos.json — readDemos creates it on first read, but doing
  // so up-front means the user can find the file immediately after install
  // instead of having to press the hotkey once to "materialize" it.
  await readDemos()

  // Sequence matters: memory must finish resuming its session before any
  // chat IPC handler fires, otherwise the first turn lands in a fresh
  // session and breaks continuity. createWindow is last so the renderer
  // never sees a half-initialized backend.
  await initMemory()
  await initReminders()
  // Tasks (unified reminders + TODOs, v0.0.14) — depends on memory for
  // session-id injection in add(). Migrates legacy reminders.sqlite on
  // first run if found.
  await initTasks()
  initProactive(onConfigChange)
  initNotifListener()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

/**
 * Wire `meido-live2d://<name>/<file...>` URLs to disk reads under
 * `<userData>/live2d-models/<name>/`. Streams via Node fs since the built-in
 * undici fetch in Node 22 doesn't support `file://` URLs (returns "fetch
 * failed"). Sets a small content-type allow-list — pixi-live2d-display
 * needs JSON / images / model3.* recognized correctly.
 */
function registerLive2DProtocol(): void {
  protocol.handle('meido-live2d', async (req) => {
    const url = new URL(req.url)
    // Chromium treats the part after `meido-live2d://` as <host>/<path>:
    //   - host  = model name (encoded segment)
    //   - path  = file path within the model dir
    const name = decodeURIComponent(url.hostname || '')
    const filePath = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    const resolved = resolveModelFile(name, filePath)
    if (!resolved) {
      return new Response('Not Found', {
        status: 404,
        headers: { 'access-control-allow-origin': '*' },
      })
    }
    try {
      const info = await stat(resolved)
      if (!info.isFile()) {
        return new Response('Not a file', {
          status: 404,
          headers: { 'access-control-allow-origin': '*' },
        })
      }
      // Web ReadableStream from a Node fs stream — handles big textures
      // without buffering the whole file into memory.
      const nodeStream = createReadStream(resolved)
      const webStream = Readable.toWeb(nodeStream) as ReadableStream
      return new Response(webStream, {
        status: 200,
        headers: {
          'content-type': contentTypeFor(resolved),
          'content-length': String(info.size),
          'access-control-allow-origin': '*',
          // Caching: Live2D files are static once a model is installed;
          // immutable cache lets the browser skip re-fetching textures on
          // every reload. Versioned by model dir name so importing a new
          // model under the same name still busts cache via the URL change.
          'cache-control': 'public, max-age=86400',
        },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[live2d] protocol read failed: ${resolved} — ${msg}`)
      return new Response(`read failed: ${msg}`, {
        status: 500,
        headers: { 'access-control-allow-origin': '*' },
      })
    }
  })
}

/**
 * Best-guess content-type for files inside a Live2D model dir. PIXI's loader
 * is pretty tolerant but Chromium uses content-type to decide between text/
 * binary handling for XHR-style fetches, so getting JSON right matters.
 */
function contentTypeFor(filePath: string): string {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.json' || filePath.endsWith('.model3.json')) return 'application/json; charset=utf-8'
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.moc3') return 'application/octet-stream'
  if (ext === '.mtn') return 'application/octet-stream'
  return 'application/octet-stream'
}

// ---- Demos ----
// Renderer fetches fresh on every hotkey press, so user edits to demos.json
// land without restart. `demos:reveal` opens the file in the system's default
// editor (notepad / vscode / whatever) for one-click access.
ipcMain.handle('demos:list', () => readDemos())
ipcMain.handle('demos:reveal', async () => {
  const path = getDemosPath()
  // Ensure file exists so the open succeeds — readDemos creates if missing.
  await readDemos()
  await shell.openPath(path)
  return path
})

// ---- Live2D model IPC ----
ipcMain.handle('live2d:listModels', async () => live2dListModels())
ipcMain.handle('live2d:getSidecar', async (_event, name: string) => live2dGetSidecar(name))
ipcMain.handle(
  'live2d:setSidecar',
  async (_event, name: string, sidecar: ModelSidecar) => {
    await live2dSetSidecar(name, sidecar)
    return { ok: true as const }
  },
)
ipcMain.handle('live2d:deleteModel', async (_event, name: string) => {
  await live2dDeleteModel(name)
  return { ok: true as const }
})
/**
 * AI-bind a model's emotion → expression / motion mapping. Uses the
 * currently-configured chat backend via runExtraction (so the user's chosen
 * GLM / DeepSeek / etc. does the inference). Writes the result back to the
 * model's sidecar; returns it so the renderer can refresh its list.
 */
ipcMain.handle(
  'live2d:autoBindEmotions',
  async (
    _event,
    name: string,
  ): Promise<{ ok: true; sidecar: ModelSidecar } | { ok: false; error: string }> => {
    return live2dAutoBindEmotions(name, (prompt) => runExtraction(prompt))
  },
)

/**
 * Open a native file picker for a Live2D zip, unpack it, and return the
 * derived model name. Renderer can't do this end-to-end because file:// URLs
 * aren't real disk paths it could feed to adm-zip.
 */
ipcMain.handle(
  'live2d:importZip',
  async (event, opts: { overwrite?: boolean } = {}): Promise<
    { ok: true; name: string } | { ok: false; error: string; canceled?: boolean }
  > => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const pick = await dialog.showOpenDialog(win!, {
      title: '选 Live2D 模型 zip',
      filters: [{ name: 'Zip', extensions: ['zip'] }],
      properties: ['openFile'],
    })
    if (pick.canceled || !pick.filePaths[0]) {
      return { ok: false, error: 'canceled', canceled: true }
    }
    try {
      const name = await live2dImportZip(pick.filePaths[0], opts)
      return { ok: true, name }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
