import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runChat } from './chat.js'
import { IPC, type ChatSendPayload } from '../shared/ipc.js'

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
  // .env missing — OK if the env is provided some other way.
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 360,
    height: 620,
    minWidth: 260,
    minHeight: 400,
    transparent: true,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    // Explicit fully-transparent backgroundColor. Electron defaults to
    // '#FFFFFF' which paints opaque white before the renderer's CSS even
    // loads — on Windows that white sometimes "wins" against transparent.
    // The 4-byte hex with leading zero alpha forces transparency.
    backgroundColor: '#00000000',
    // thickFrame defaults to true on Windows and is what makes the otherwise-
    // invisible edges of a frame:false window draggable for resize. Don't
    // disable it unless you ship CSS-based resize handles in the renderer.
    // Skipping the taskbar is optional — comment out if you want OpenMeido
    // to appear in the Windows taskbar for easier alt-tabbing during dev.
    // skipTaskbar: true,
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
}

ipcMain.on(IPC.ChatSend, (event, payload: ChatSendPayload) => {
  void runChat(payload.messageId, payload.text, (chatEvent) => {
    // Renderer may have been closed mid-stream; guard against destroyed sender.
    if (!event.sender.isDestroyed()) {
      event.sender.send(IPC.ChatEvent, chatEvent)
    }
  })
})

void app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
