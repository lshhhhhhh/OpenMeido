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
    width: 900,
    height: 700,
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
