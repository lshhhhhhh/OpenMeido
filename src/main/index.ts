import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runChat } from './chat.js'
import { getConfig, setConfig, onConfigChange } from './config.js'
import { initMemory } from './memory-host.js'
import { testMailConfig } from './mail-host.js'
import { IPC, type ChatSendPayload } from '../shared/ipc.js'
import { configSchema, ConfigIPC, type Config } from '../shared/config.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

// Force hardware-accelerated WebGL. Without these, Electron's renderer may
// fall back to software rendering (SwiftShader), where MAX_TEXTURE_IMAGE_UNITS
// returns 0 and PIXI's BatchRenderer init crashes. Must be set before
// app.whenReady().
app.commandLine.appendSwitch('ignore-gpu-blocklist')
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('enable-zero-copy')

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

  // Persist the user's manual resize so next launch opens at the same size.
  win.on('resize', () => {
    if (win.isDestroyed()) return
    const size = win.getSize()
    const w = size[0] ?? cfg.window.width
    const h = size[1] ?? cfg.window.height
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
  }
})

// ---- Chat IPC ----

ipcMain.on(IPC.ChatSend, (event, payload: ChatSendPayload) => {
  void runChat(payload.messageId, payload.text, (chatEvent) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send(IPC.ChatEvent, chatEvent)
    }
  })
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

void app.whenReady().then(() => {
  initMemory()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
