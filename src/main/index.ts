// CRITICAL FIRST IMPORT — `--demo` flag re-points userData to a sandbox
// dir before anything else touches storage. Same ES-module-hoisting
// reasoning as reset-handler below: config.ts / sqlite / electron-
// store all read userData at import time, so the setPath has to land
// FIRST.
import './demo-mode.js'

// SECOND IMPORT — runs the reset wipe (if argv / sentinel says to).
// Must come before any module that reads userData files at import time
// (config.ts, lines-host.ts, memory adapters, etc.) — otherwise those
// modules load stale data into in-memory state and a later setConfig()
// would persist that stale data right back, defeating the reset.
import './reset-handler.js'

import { app, BrowserWindow, ipcMain, protocol, dialog, shell, screen } from 'electron'
import { join, extname } from 'node:path'
import { createReadStream, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { runChat } from './chat.js'
import { getConfig, setConfig, onConfigChange } from './config.js'
import {
  initMemory,
  getMemoryService,
  getMemoryAdapter,
  getMemoryInitError,
  isNaiveMemoryMode,
} from './memory-host.js'
import { getReminderService } from './reminder-host.js'
import { initTasks, getTaskService, getTasksBootAt } from './tasks-host.js'
import { greetOnLaunch } from './greeting-host.js'
import { initGoodbye } from './goodbye-host.js'
import { getDownloadState, startEmbedDownload } from './embed-download-host.js'
import { testMailConfig } from './mail-host.js'
import { testBackend, runExtraction } from './chat-host.js'
import { readDemos, getDemosPath } from './demos-host.js'
import { captureAllScreensPng } from './screen-host.js'
import { listVoices as ttsListVoices, synthesize as ttsSynthesize } from './tts-host.js'
import {
  initLines,
  getLines,
  ensureLinesFile,
  getLinesFilePath,
} from './lines-host.js'
import {
  OPTIONAL_FONTS,
  downloadFont,
  isFontInstalled,
  listOptionalFonts,
  readFontFile,
  uninstallFont,
} from './font-download-host.js'
import {
  transcribeSamples as sttTranscribe,
  getSttStatus,
  startSttDownload,
} from './stt-host.js'
import {
  initProactive,
  noteAssistantActivity,
  noteUserActivity,
} from './proactive-host.js'
import { initNotifListener } from './notif-host.js'
import { initHotkey, applyHotkey, getHotkeyStatus } from './hotkey-host.js'
import { recentEmotionEvents } from './emotion-events.js'
import {
  initAffinity,
  refreshCachedScore,
  setAffinityForTest,
} from './affinity-host.js'
import { initWeeklyReview } from './weekly-review-host.js'
import { initPresence, tickNow as presenceTickNow } from './presence-host.js'
import {
  importCustomBackground,
  registerBackgroundScheme,
  registerBackgroundProtocol,
  deleteCustomBackground,
} from './background-host.js'
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
import { initUpdater } from './updater-host.js'
import { initUsage } from './usage-host.js'
import { isDemoMode } from './demo-mode.js'
import { seedDemoData } from './demo-seed.js'
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
// Let TTS audio play immediately at launch without waiting for a user
// click. Chromium's default autoplay policy holds back AudioContext
// playback until the first user gesture — that means the boot greeting
// audio starts mid-stream when the user finally clicks something later,
// and the first second of speech is lost. Electron defaults to the
// Chromium policy unless we override it here.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

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
  {
    // Same shape as meido-live2d://, but serves user-downloaded fonts
    // from <userData>/fonts/ (see src/main/font-download-host.ts).
    // CSS @font-face references this protocol so the browser can load
    // the font file just like a regular URL.
    scheme: 'meido-font',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
      corsEnabled: true,
    },
  },
])
registerBackgroundScheme()

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

  // Fit-to-screen guard. Default config is 618×1184 — comfortable on
  // 1080p+ displays but tall enough to clip on common 1366×768 laptops.
  // Cap to 90% of the primary display's work area so first-launch users
  // on smaller screens get a usable window instead of one with its
  // bottom half hidden under the taskbar.
  const work = screen.getPrimaryDisplay().workAreaSize
  const fittedWidth = Math.min(cfg.window.width, Math.floor(work.width * 0.9))
  const fittedHeight = Math.min(cfg.window.height, Math.floor(work.height * 0.9))

  // Resolve the icon path for both dev and prod. In dev __dirname is
  // out/main/, in prod it's <asar>/out/main/ — but the icon ships
  // OUTSIDE the asar via electron-builder buildResources, so we have
  // to walk up to <resources>/. In dev there's no asar; the file is
  // at project root build/icon.png.
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'build', 'icon.png')
    : join(__dirname, '../../build/icon.png')

  const win = new BrowserWindow({
    width: fittedWidth,
    height: fittedHeight,
    minWidth: 260,
    minHeight: 400,
    transparent: true,
    frame: false,
    resizable: true,
    // Deliberately NOT setting alwaysOnTop here — the constructor's
    // alwaysOnTop flag combined with transparent:true + frame:false
    // intermittently fails on Windows 11 (window opens NOT on top
    // despite the flag). We re-apply it post-create with the explicit
    // 'screen-saver' z-level below; that path is reliable.
    icon: iconPath,
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

  // External-link handler. Without this, every <a target="_blank"> or
  // window.open('https://...') call from the renderer pops a new
  // BrowserWindow INSIDE OpenMeido — clunky, no address bar, no
  // bookmarks, no extensions. Route http(s) URLs through shell.open
  // External so they open in the user's OS default browser instead.
  //
  // Returning { action: 'deny' } prevents the in-app window. Returning
  // { action: 'allow' } would let it through (we don't want that for
  // external URLs). For our own meido-* protocol URLs we deny too
  // because they're meant to be loaded inline, not as separate windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  // Apply the persisted UI zoom on every load (covers HMR refresh in dev
  // and full restart in prod). did-finish-load fires after the renderer's
  // JS is ready, which is what setZoomFactor needs.
  win.webContents.on('did-finish-load', () => {
    const c = getConfig()
    win.webContents.setZoomFactor(c.ui.fontScale)
  })

  // Re-apply alwaysOnTop AFTER the window is shown. Setting it in the
  // BrowserWindow constructor on transparent+frameless windows is flaky
  // on Windows 11 — the window can open beneath other windows even
  // though the flag is set. Re-issuing setAlwaysOnTop with an explicit
  // z-level ('screen-saver' is one above 'normal' that survives the
  // transparent-window quirk) after ready-to-show fixes the first-launch
  // case reliably.
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return
    const c = getConfig()
    if (c.window.alwaysOnTop) {
      win.setAlwaysOnTop(true, 'screen-saver')
    }
  })

  // Persist the user's manual resize so next launch opens at the same size.
  // Two guards prevent drift:
  //   1. **Boot-event suppression**: Windows DWM nudges transparent +
  //      frameless windows by a few px on creation (border / shadow
  //      math). Listening to that initial event would save the nudged
  //      value back, and each launch would drift further. We ignore
  //      every resize within the first 2s of window creation — by then
  //      Windows has settled.
  //   2. **Debounce**: rapid resize fires ~60/s while dragging. Only
  //      save 500ms after the user stops, so the disk write doesn't
  //      thrash and a fast drag doesn't capture intermediate sizes.
  //
  // We subtract the sidebar's contribution (when open) so the "natural"
  // width is what gets saved.
  const bootAt = Date.now()
  const BOOT_QUIET_MS = 2000
  const DEBOUNCE_MS = 500
  let saveTimer: NodeJS.Timeout | null = null
  win.on('resize', () => {
    if (win.isDestroyed()) return
    if (Date.now() - bootAt < BOOT_QUIET_MS) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      if (win.isDestroyed()) return
      const size = win.getSize()
      const rawW = size[0] ?? cfg.window.width
      const h = size[1] ?? cfg.window.height
      // Clamp w to the minimum the Zod schema allows.
      const w = Math.max(260, rawW - (sidebarOpenInMain ? SIDEBAR_WIDTH : 0))
      const current = getConfig()
      if (current.window.width !== w || current.window.height !== h) {
        setConfig({ ...current, window: { ...current.window, width: w, height: h } })
      }
    }, DEBOUNCE_MS)
  })

  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

}

/**
 * Sync the OS auto-start registration to match `window.startAtLogin`.
 * Idempotent — calling with the same value repeatedly is harmless. On
 * Windows this writes (or removes) the Run-key entry; on macOS it
 * toggles the Login Item; on Linux it manages a .desktop file.
 *
 * Production builds (packaged exe) get registered with the exe path.
 * Dev (`npm run dev`) gets registered with the electron binary + main
 * script args — useful for testing but you almost never want that
 * persisted, so we also skip writing in dev unless app.isPackaged is
 * true.
 */
function applyStartAtLogin(startAtLogin: boolean): void {
  if (!app.isPackaged) {
    // Skip in dev — registering the dev binary as a startup entry would
    // cause Electron + node to auto-launch on every login, which is
    // almost never what the developer wants.
    return
  }
  app.setLoginItemSettings({
    openAtLogin: startAtLogin,
    // Don't pop the window to the front on auto-launch; we want her to
    // come up quietly. The greeting + proactive remarks still fire.
    openAsHidden: false,
  })
}

// Apply live config changes to the running window where possible. width/height
// already persist via the resize listener above, so we don't push them back.
let lastPersona: string = getConfig().persona.preset

onConfigChange((next) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    // Pass 'screen-saver' z-level explicitly — same defensive workaround
    // as ready-to-show. Without it, toggling alwaysOnTop in Settings
    // while the window is transparent+frameless can produce the same
    // "flag set but window not on top" bug as cold-start.
    mainWindow.setAlwaysOnTop(next.window.alwaysOnTop, 'screen-saver')
    mainWindow.webContents.setZoomFactor(next.ui.fontScale)
  }
  applyStartAtLogin(next.window.startAtLogin)
  applyHotkey(next.window.summonHotkey)

  // Persona switch handling: when the user picks a different 人物 in
  // Settings, treat it as meeting a different character. Mint a fresh
  // session id (so the new persona doesn't continue the previous
  // persona's chat thread on its first turn), refresh the affinity
  // cache for prompt assembly, and broadcast to the renderer so the
  // sidebar score updates.
  if (next.persona.preset !== lastPersona) {
    lastPersona = next.persona.preset
    const memory = getMemoryService()
    if (memory) {
      memory.newSession()
    }
    void refreshCachedScore(next.persona.preset)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('persona:switched', { personaId: next.persona.preset })
    }
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

// Window click-through (setIgnoreMouseEvents). Earlier version was always-on
// + got stuck eating clicks; this revival is gated by an opt-in config flag
// and uses `forward: true` so mousemove events keep firing while ignored —
// the previous "stuck" failure came from losing mousemove and never being
// able to detect when to turn click-through back off. Renderer drives the
// toggle from the Live2D coverage probe (over-pixel vs over-transparent).
ipcMain.handle('window:setIgnoreMouseEvents', (_event, ignore: boolean) => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  // forward: true is critical — without it, the OS stops dispatching
  // mousemove to the renderer once click-through is on, and we can never
  // re-evaluate whether the cursor moved back onto a UI region.
  mainWindow.setIgnoreMouseEvents(ignore, { forward: true })
})

ipcMain.handle('window:getHotkeyStatus', () => getHotkeyStatus())

// App version — Settings → 关于 reads this to show "当前版本 v0.X.Y"
// next to the manual update-check button. Single source of truth is
// package.json (Electron reads it from the bundled main process).
ipcMain.handle('app:version', () => app.getVersion())

// Demo-mode status — renderer hangs a 🎬 DEMO badge in the corner
// when this returns true so the user / audience knows the data on
// screen is synthetic. See src/main/demo-mode.ts for the --demo flag.
ipcMain.handle('app:isDemoMode', () => isDemoMode())

// ---- Affinity / persona-scoped helpers ----
ipcMain.handle('affinity:get', async (_event, personaId?: string) => {
  const adapter = getMemoryAdapter()
  if (!adapter) return null
  const pid = personaId || getConfig().persona.preset
  return adapter.getAffinity(pid)
})
// Dev-only: force the active persona's affinity to a specific score
// without going through judges / curves / daily caps. Lets you preview
// Lv.1 / Lv.3 / Lv.5 prompt behavior without chat-grinding. Only
// registered in dev builds — production users have no path to it.
//
// Usage from DevTools:
//   window.api.affinity.setForTest(90)         // active persona → 90
//   window.api.affinity.setForTest(0, 'maid')  // specific persona → 0
if (!app.isPackaged) {
  ipcMain.handle(
    'affinity:setForTest',
    async (_event, score: number, personaId?: string) => {
      const pid = personaId || getConfig().persona.preset
      try {
        await setAffinityForTest(pid, score, 'manual dev override')
        return { ok: true, personaId: pid, score }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )
}

ipcMain.handle('affinity:listAll', async () => {
  const adapter = getMemoryAdapter()
  if (!adapter) return []
  const cfg = getConfig()
  const ids = ['maid', 'imouto', 'ojou', ...cfg.persona.customs.map((c) => c.id)]
  const out = []
  for (const pid of ids) {
    const rec = await adapter.getAffinity(pid)
    const count = await adapter.count(pid)
    out.push({ ...rec, episodeCount: count })
  }
  return out
})
ipcMain.handle('persona:delete', async (_event, personaId: string) => {
  const adapter = getMemoryAdapter()
  if (!adapter) return 0
  return adapter.deletePersona(personaId)
})

ipcMain.handle('background:import', async (_event, personaId: string) => {
  return importCustomBackground(personaId)
})
ipcMain.handle('background:delete', async (_event, basenameToRemove: string) => {
  await deleteCustomBackground(basenameToRemove)
  return { ok: true as const }
})

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

// Speech-to-text. Renderer sends a Float32Array of 16-kHz mono samples
// (it captures via MediaRecorder + decodes via AudioContext, resamples
// to 16 kHz). Main returns the Whisper transcript. Lazy-loads + caches
// the model on first call.
//
// When cfg.stt.cleanup is on (default), the raw Whisper output is
// piped through the lightweight LLM tier to fix homophone errors,
// missing punctuation, and traditional/simplified mixups. Adds
// 300-800ms; users who want faster STT can disable in Settings.
ipcMain.handle('stt:transcribe', async (_event, payload: { samples: unknown }) => {
  try {
    const cfg = getConfig()
    // IPC may deliver typed arrays as Buffer / plain object depending on
    // contextBridge serialization. Normalize so transformers.js gets a
    // real Float32Array.
    let samples: Float32Array
    const raw = payload.samples
    if (raw instanceof Float32Array) {
      samples = raw
    } else if (ArrayBuffer.isView(raw)) {
      const v = raw as ArrayBufferView
      samples = new Float32Array(v.buffer, v.byteOffset, v.byteLength / 4)
    } else if (raw instanceof ArrayBuffer) {
      samples = new Float32Array(raw)
    } else {
      // Last-ditch: maybe it came across as a plain object with numeric
      // keys (rare under structured clone, but possible with older
      // electron / contextBridge configs).
      samples = Float32Array.from(raw as ArrayLike<number>)
    }
    const rawTranscript = await sttTranscribe(samples, undefined, cfg.stt.language)
    if (!cfg.stt.cleanup || rawTranscript.length < 3) {
      return { ok: true as const, text: rawTranscript, rawText: rawTranscript }
    }
    // Cleanup prompt — strict: don't paraphrase, just fix obvious STT
    // mistakes. Falls back to raw on any LLM failure.
    const prompt =
      `[STT 修正模式] 用户语音被识别成了下面这句话：\n\n` +
      `「${rawTranscript}」\n\n` +
      `请修正其中可能的同音字、错字、缺失或多余的标点。` +
      `**保持原意，不要增改任何信息**——如果原文已经是对的，原样输出。` +
      `**只输出修正后的文本本身**，不要加引号、解释、前缀。`
    let cleaned = rawTranscript
    try {
      // Low temperature for fidelity. 0.0–0.2 range; 0.1 to allow a
      // little freedom on ambiguous spans (homophone choices).
      cleaned = (await runExtraction(prompt, { temperature: 0.1 })).trim()
      // Sanity guards: if the cleanup mangled length wildly, distrust
      // it. STT cleanup should never balloon or shrink the text by
      // more than ~50% — that's the model "improving" instead of
      // fixing. Fall back to raw.
      if (
        cleaned.length < rawTranscript.length * 0.5 ||
        cleaned.length > rawTranscript.length * 1.8
      ) {
        console.warn(
          `[stt] cleanup length swing rejected: raw=${rawTranscript.length} cleaned=${cleaned.length}; using raw`,
        )
        cleaned = rawTranscript
      }
    } catch (err) {
      console.warn('[stt] cleanup LLM call failed, using raw:', err)
    }
    return { ok: true as const, text: cleaned, rawText: rawTranscript }
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
  }
})

ipcMain.handle('screen:capture', async () => {
  const all = await captureAllScreensPng(getConfig().proactive.excludedScreenIds)
  // Each entry is a base64 PNG — JSON-serialisable + small enough for IPC.
  return all.map((bytes) => ({
    mimeType: 'image/png',
    base64: Buffer.from(bytes).toString('base64'),
  }))
})

/** Enumerate currently-attached displays — used by Settings → 主动 to
 *  let the user pick which screens are OK for the AI to see. Returns
 *  preview thumbnails small enough for the picker grid. */
ipcMain.handle('screen:list', async () => {
  const { listScreens } = await import('./screen-host.js')
  return listScreens()
})

/**
 * Quick screen-react — user clicked the "看屏幕" button. Capture all
 * displays, ask the vision LLM to comment in persona voice + current
 * tier, broadcast through the same proactive:remark channel so it
 * gets the chat bubble + TTS + emotion classifier + memory persistence
 * for free.
 *
 * Idempotent against rapid clicks: handler is single-shot per call,
 * renderer side gates with a busy flag so the user can't fire 10
 * captures in 2 seconds.
 */
/**
 * Parse the JSON output of buildQuickScreenReactPrompt — {spoken,
 * noted}. Tolerant of fence-wrapped, bare-JSON, and "embedded JSON
 * in a paragraph" forms. Falls back to treating the entire raw text
 * as the spoken line when parsing fails — better UX than crashing.
 */
function parseScreenReactJson(raw: string): { spoken: string; noted: string[] } {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates: string[] = []
  if (fenced?.[1]) candidates.push(fenced[1])
  candidates.push(trimmed)
  // Look for the first balanced {...} block as last resort.
  const objStart = trimmed.indexOf('{')
  if (objStart >= 0) candidates.push(trimmed.slice(objStart))
  for (const s of candidates) {
    try {
      const obj = JSON.parse(s) as Record<string, unknown>
      const spoken = typeof obj.spoken === 'string' ? obj.spoken : ''
      const noted = Array.isArray(obj.noted)
        ? obj.noted
            .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
            .map((x) => x.trim())
        : []
      if (spoken) return { spoken, noted }
    } catch {
      /* try next */
    }
  }
  // No valid JSON — treat the raw output as the spoken line, no notes.
  return { spoken: trimmed, noted: [] }
}

ipcMain.handle('chat:quickScreenReact', async () => {
  console.log(`[quickScreen] triggered at ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`)
  try {
    const cfg = getConfig()
    const { resolvePersona } = await import('../shared/config.js')
    const { buildTierPromptBlock } = await import('../shared/affinity.js')
    const { buildQuickScreenReactPrompt, buildQuickScreenFallbackPrompt } =
      await import('../shared/daily-prompts.js')
    const { runExtraction, runExtractionWithImages } = await import('./chat-host.js')
    const { classifyAndApply } = await import('./emotion-classifier.js')
    const { formatLocalNow } = await import('../shared/time-format.js')
    const { visionModel } = await import('../shared/lightweight-models.js')

    const persona = resolvePersona(cfg.persona)
    const memory = getMemoryService()
    const affinity = memory ? await memory.getAffinity().catch(() => null) : null
    const tierBlock = buildTierPromptBlock(
      affinity?.score ?? 0,
      persona.name,
      persona.traits,
    )
    const userName = memory ? await memory.getUserName().catch(() => null) : null

    // Two paths that lead to "can't see screen, fall back to text":
    //   1. User toggled off proactive.includeScreen — they explicitly
    //      don't want her looking. Respect it; produce a text-only
    //      acknowledgement remark instead.
    //   2. Configured backend's lightweight-tier table has vision:null
    //      (DeepSeek today, plus any local model we don't know about).
    //      Calling runExtractionWithImages would just 400 from the
    //      provider; better to pre-detect and route to text fallback.
    //
    // Both produce a normal proactive:remark broadcast — TTS, persisted
    // episode, emotion classifier all fire as if she said it of her
    // own accord. The button always produces SOMETHING; never errors.
    const fallbackReason: 'disabled' | 'no-vision' | null = !cfg.proactive.includeScreen
      ? 'disabled'
      : visionModel(cfg.backend.baseUrl) === null
        ? 'no-vision'
        : null

    if (fallbackReason) {
      console.log(`[quickScreen] text-fallback path · reason=${fallbackReason}`)
      const prompt = buildQuickScreenFallbackPrompt({
        persona,
        tierBlock,
        now: formatLocalNow(),
        userName,
        reason: fallbackReason,
      })
      let raw: string
      try {
        raw = await runExtraction(prompt, {
          temperature: 0.7,
          feature: 'quick-screen-fallback',
        })
      } catch (err) {
        return {
          ok: false as const,
          error: 'LLM 调用失败：' + (err instanceof Error ? err.message : String(err)),
        }
      }
      // Same JSON shape as quickScreenReact's parser would handle, but
      // simpler — no noted field. Defensive parsing in case the model
      // returns plain text.
      let line = ''
      try {
        const cleaned = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')
        const parsed = JSON.parse(cleaned) as { should_speak?: boolean; comment?: string }
        if (parsed.should_speak && typeof parsed.comment === 'string') {
          line = parsed.comment.trim()
        }
      } catch {
        // Treat raw output as the line if JSON parse fails.
        line = raw.trim().slice(0, 80)
      }
      if (!line) {
        line =
          fallbackReason === 'disabled'
            ? '看不到屏幕呢——不过聊点别的吧？'
            : '现在这双眼睛看不见图——换个能看图的模型试试？'
      }
      if (memory) {
        try {
          await memory.addEpisode('assistant', line)
        } catch (err) {
          console.warn('[quickScreen-fallback] episode persist failed:', err)
        }
      }
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('proactive:remark', {
            text: line,
            ts: new Date().toISOString(),
            triggers: ['quick-screen-fallback'],
          })
        }
      }
      void classifyAndApply(line, '')
      console.log(`[quickScreen-fallback] → "${line}"`)
      return { ok: true as const, text: line }
    }

    // Pull memory context: distilled facts + recent silent observations
    // from past screen captures. This is what lets her say "又在看
    // 猎鹰" on day 2 — she silently noted "Falcons 战队" on day 1.
    const factsBlock = memory ? await memory.factsBlock(0.5).catch(() => '') : ''
    const recentEpisodes = memory ? await memory.listRecent(60).catch(() => []) : []
    const pastObservations = recentEpisodes
      .filter((e) => e.speaker === 'assistant' && e.text.startsWith('[obs] '))
      .slice(-10) // last 10 observations
      .map((e) => e.text.slice('[obs] '.length))

    let imageBytes: Uint8Array[]
    try {
      imageBytes = await captureAllScreensPng(cfg.proactive.excludedScreenIds)
    } catch (err) {
      return { ok: false as const, error: '截屏失败：' + String(err) }
    }
    if (imageBytes.length === 0) {
      return { ok: false as const, error: '没有可用的屏幕。' }
    }
    const images = imageBytes.map((bytes) => ({ mimeType: 'image/png', bytes }))

    const prompt = buildQuickScreenReactPrompt({
      persona,
      tierBlock,
      now: formatLocalNow(),
      userName,
      factsBlock,
      pastObservations,
    })

    let raw: string
    try {
      raw = await runExtractionWithImages(prompt, images, {
        temperature: 0.8,
        feature: 'quick-screen',
      })
    } catch (err) {
      return {
        ok: false as const,
        error: 'LLM 调用失败：' + (err instanceof Error ? err.message : String(err)),
      }
    }
    // Parse JSON {spoken, noted}. Falls back to treating the whole
    // output as the spoken line when JSON is malformed — better than
    // showing a stack trace to the user.
    const parsed = parseScreenReactJson(raw)
    const line = parsed.spoken.trim()
    // Privacy escape — model can output "(SILENT)" when the screen
    // shows something it shouldn't comment on (passwords, banking, etc).
    if (!line || /^\(?SILENT\)?$/i.test(line) || line.length < 4) {
      console.log(`[quickScreen] silent (raw="${raw.slice(0, 80)}")`)
      return { ok: false as const, error: '画面太敏感了，这次先不说。' }
    }

    // Persist as an assistant episode so future retrieval sees it
    // ("she commented on what I was doing earlier").
    if (memory) {
      try {
        await memory.addEpisode('assistant', line)
      } catch (err) {
        console.warn('[quickScreen] episode persist failed:', err)
      }
    }
    // Persist the silent observation block as a separate "[obs] ..."
    // assistant episode. UI filters this prefix; L3 reflection still
    // sees it and can distill patterns into facts ("user.interest.game:
    // CS2"). Future screen-react prompts re-inject the last 10 of these
    // as `pastObservations` — that's how she goes from "你喜欢 CS2 吗"
    // on day 0 to "又看猎鹰啊" on day 1.
    if (memory && parsed.noted.length > 0) {
      const obsText = '[obs] ' + parsed.noted.join(', ')
      try {
        await memory.addEpisode('assistant', obsText)
        console.log(`[quickScreen] noted: ${parsed.noted.join(', ')}`)
      } catch (err) {
        console.warn('[quickScreen] observation persist failed:', err)
      }
    }
    // Broadcast — same channel as proactive remarks. Renderer renders
    // it as an assistant bubble, plays TTS, fires emotion classifier.
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('proactive:remark', {
          text: line,
          ts: new Date().toISOString(),
          triggers: ['quick-screen-react'],
        })
      }
    }
    void classifyAndApply(line, '')
    // Print FULL text (no truncation) so prompt-iteration debug doesn't
    // require running inspect-memory. Adds a clear visual marker around
    // the bubble so it's easy to grep / pick out of the dev terminal.
    console.log(`[quickScreen] →→→ ${line.length} 字`)
    console.log(`  ${line.replace(/\n/g, '\n  ')}`)
    console.log(`[quickScreen] ←←←`)
    return { ok: true as const, text: line }
  } catch (err) {
    console.warn('[quickScreen] failed:', err)
    return { ok: false as const, error: String(err) }
  }
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
ipcMain.handle(
  'memory:listRecentFor',
  async (_event, personaId: string, limit: number = 200) => {
    const svc = getMemoryService()
    if (!svc) return []
    return svc.listRecentFor(personaId, limit)
  },
)
ipcMain.handle('memory:clear', async () => {
  const svc = getMemoryService()
  if (!svc) return 0
  return svc.clearAll()
})
ipcMain.handle(
  'memory:export',
  async (): Promise<{ ok: true; path: string } | { ok: false; error: string; canceled?: boolean }> => {
    const adapter = getMemoryAdapter()
    if (!adapter) return { ok: false, error: '记忆系统未初始化' }
    // Default filename includes date + version so multiple backups
    // sort + identify themselves at a glance. ISO date is locale-
    // neutral; the version helps when restoring across upgrades.
    const dateStr = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
    const defaultName = `openmeido-memory-${dateStr}-v${app.getVersion()}.sqlite`
    const result = await dialog.showSaveDialog(mainWindow ?? undefined as never, {
      title: '导出记忆备份',
      defaultPath: defaultName,
      filters: [{ name: 'SQLite Database', extensions: ['sqlite'] }],
    })
    if (result.canceled || !result.filePath) {
      return { ok: false, error: '已取消', canceled: true }
    }
    try {
      await adapter.exportTo(result.filePath)
      console.log(`[memory] exported to ${result.filePath}`)
      return { ok: true, path: result.filePath }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn('[memory] export failed:', msg)
      return { ok: false, error: msg }
    }
  },
)
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
ipcMain.handle('memory:deleteFact', async (_event, factId: number) => {
  const svc = getMemoryService()
  if (!svc) return false
  return svc.deleteFact(factId)
})

// Dev / testing convenience: nuke local state and relaunch into the
// fresh-install flow. Three flavors:
//   - reset:config  — wipe config.json (lose API keys, persona pick,
//                     window position, voice setting etc.)
//   - reset:memory  — wipe memory.sqlite (lose chat history, facts,
//                     affinity)
//   - reset:all     — wipe entire userData contents (everything
//                     including downloaded fonts + embedding model)
// Implementation hands off to the --reset-* argv branch at the very
// top of this file: we relaunch with the flag and the next process
// deletes the files BEFORE any module grabs a file handle.
//
// In dev mode (`!app.isPackaged`), `app.relaunch + app.exit` doesn't
// work cleanly — electron-vite manages the Electron process as its
// child, and our exit usually tears down the whole dev session
// without a new window coming back. Show an explicit dialog instead
// so the user knows to run `npm run dev` again. In prod (.exe) the
// auto-relaunch path is fine.
async function performReset(flag: '--reset-config' | '--reset-memory' | '--reset-all'): Promise<void> {
  if (app.isPackaged) {
    app.relaunch({ args: [...process.argv.slice(1), flag] })
    app.exit(0)
    return
  }
  // Dev mode — show a heads-up before exiting so the user isn't
  // staring at a dead dev server wondering what happened. Attach to
  // mainWindow so it renders ON TOP of the always-on-top window
  // (otherwise the dialog opens behind and the user never sees it).
  await dialog.showMessageBox(mainWindow ?? undefined as never, {
    type: 'info',
    title: '重置完成 — 请手动重启',
    message: `dev 模式下的 reset 不能自动重启。\n\n应用即将退出。请回到终端重新运行：\n\n    npm run dev\n\n下次启动会自动完成清空 (sentinel: ${flag})。`,
    buttons: ['好，我去重启'],
    defaultId: 0,
  })
  // Write a sentinel arg into a file so the next dev launch picks it
  // up — argv won't carry across electron-vite's restart. Loaded by
  // handleResetFlags at the top of this file.
  try {
    const userData = app.getPath('userData')
    // Defensive: userData may not exist yet on first run, or could have
    // been wiped by a previous reset cycle. Create before write.
    const { mkdirSync } = await import('node:fs')
    mkdirSync(userData, { recursive: true })
    const sentinelPath = join(userData, '.pending-reset')
    writeFileSync(sentinelPath, flag, 'utf8')
    console.log(`[reset] sentinel WRITTEN → ${sentinelPath} (content="${flag}")`)
  } catch (err) {
    console.warn('[reset] failed to write sentinel:', err)
  }
  app.exit(0)
}
ipcMain.handle('reset:config', () => performReset('--reset-config'))
ipcMain.handle('reset:memory', () => performReset('--reset-memory'))
ipcMain.handle('reset:all', () => performReset('--reset-all'))

// Set a single fact directly (vs the LLM-extraction path). Used by
// the setup wizard to seed user-supplied personalization (preferred
// address / occupation) so the very first greeting can reference
// them. Scope (shared vs persona) is auto-inferred from the key
// prefix inside upsertFact — see sqlite-memory-adapter.
ipcMain.handle(
  'memory:upsertFact',
  async (_event, payload: { key: string; value: string }) => {
    const adapter = getMemoryAdapter()
    if (!adapter) return { ok: false, error: 'memory not ready' }
    if (!payload?.key || typeof payload.value !== 'string') {
      return { ok: false, error: 'key + value required' }
    }
    try {
      const personaId = getConfig().persona.preset
      const fact = await adapter.upsertFact(
        personaId,
        { key: payload.key, value: payload.value.trim() },
        'personal',
      )
      return { ok: true, id: fact?.id ?? null }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
)

// Persist a mute-button feedback line as an assistant episode. The
// renderer already displayed the line locally (zero-latency); this just
// writes it to memory so the NEXT user reply doesn't land as a dangling
// turn (model would otherwise have no context that she said "主人你回来了"
// before the user said "是啊我回来了").
//
// Deliberately doesn't trigger affinity / emotion classifiers — these
// are UI acknowledgement lines, not conversation, and feeding them
// through warmth-judging would drift the score every toggle. L3
// reflection still sees the episodes but the LLM naturally ignores
// content-free mechanical turns when distilling facts.
// Optional fonts — renderer asks "what's installable / what's already
// installed" at boot, then triggers download / uninstall on user click.
// Progress streams back over 'fonts:download:progress' BrowserWindow
// message channel so the Settings UI can show a bar without polling.
ipcMain.handle('fonts:list', () => {
  return listOptionalFonts()
})
ipcMain.handle('fonts:download', async (event, fontId: string) => {
  try {
    await downloadFont(fontId, (p) => {
      // Per-chunk progress back to the originating window.
      event.sender.send('fonts:download:progress', p)
    })
    return { ok: true, fontId, installed: isFontInstalled(fontId) }
  } catch (err) {
    return { ok: false, fontId, error: err instanceof Error ? err.message : String(err) }
  }
})
ipcMain.handle('fonts:uninstall', async (_event, fontId: string) => {
  try {
    await uninstallFont(fontId)
    return { ok: true, fontId, installed: isFontInstalled(fontId) }
  } catch (err) {
    return { ok: false, fontId, error: err instanceof Error ? err.message : String(err) }
  }
})

// Preset lines — renderer fetches once at boot to feed pickMuteFeedback
// (and future "preset" consumers like persona prompts when we expand).
ipcMain.handle('lines:get', () => {
  return getLines()
})
// Trigger the OS default editor on the lines file. Seeds the file with
// bundled defaults on first call so notepad doesn't open empty.
ipcMain.handle('lines:openFile', async () => {
  try {
    const path = await ensureLinesFile()
    await shell.openPath(path)
    return { ok: true, path }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})
ipcMain.handle('lines:path', () => {
  return getLinesFilePath()
})

ipcMain.handle('mute:announce', async (_event, payload: { text: string }) => {
  if (!payload?.text || typeof payload.text !== 'string') return { ok: false }
  const svc = getMemoryService()
  if (!svc) return { ok: false }
  try {
    await svc.addEpisode('assistant', payload.text.trim())
    return { ok: true }
  } catch (err) {
    console.warn('[mute] persist failed:', err)
    return { ok: false }
  }
})

// Diagnostic — fire a presence tick on demand. Used from DevTools when
// you don't want to wait 10 minutes between ticks while investigating
// why presence isn't accruing.
ipcMain.handle('presence:tickNow', async () => {
  await presenceTickNow()
})
ipcMain.handle('memory:reflectNow', async () => {
  const svc = getMemoryService()
  if (!svc) return 0
  return svc.reflectOnce()
})

ipcMain.handle('memory:recentToolActivity', async (_event, limit: number = 20) => {
  const adapter = getMemoryAdapter()
  // Pull more episodes than the requested cap because each row contributes
  // 0-N tool entries; we trim after flattening.
  const out: Array<{
    episodeId: number
    ts: string
    kind: 'call' | 'result'
    toolName: string
    summary: string
  }> = []
  if (adapter) {
    const episodes = await adapter.recent(getConfig().persona.preset, Math.max(limit * 2, 30), null)
    for (const e of episodes) {
      if (!e.toolParts || e.toolParts.length === 0) continue
      for (const p of e.toolParts) {
        if (p.type === 'tool-call') {
          out.push({
            episodeId: e.id,
            ts: e.ts,
            kind: 'call',
            toolName: p.toolName,
            summary: summarizeToolPayload(p.input),
          })
        } else if (p.type === 'tool-result') {
          out.push({
            episodeId: e.id,
            ts: e.ts,
            kind: 'result',
            toolName: p.toolName,
            summary: summarizeToolPayload(p.output),
          })
        }
      }
    }
  }
  // Emotion events used to be folded in here so the user could "see"
  // her non-verbal reactions in 最近活动. Removed (2026-05-21 post-release):
  // every chat turn now produces an emotion → activity feed turned
  // into a wall of "换表情 · 害羞". The user can see the face directly
  // on the Live2D model in real-time; the activity feed should surface
  // tool work (which IS invisible), not redundant visible state.
  return out.slice(-limit).reverse()
})

function summarizeToolPayload(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v.length > 80 ? v.slice(0, 80) + '…' : v
  try {
    const s = JSON.stringify(v)
    return s.length > 80 ? s.slice(0, 80) + '…' : s
  } catch {
    return String(v)
  }
}

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
  // Scope "recently completed" to the current app session — see
  // tasks-host.bootAt. Without this, X-deleting a done row pulls an
  // older one into the top-N window and the user reads it as the
  // deleted task coming back.
  return svc.listAll(recentDoneLimit, getTasksBootAt())
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

// ---- Embed model download ----

ipcMain.handle('embed:status', () => ({
  naive: isNaiveMemoryMode(),
  ...getDownloadState(),
}))
ipcMain.handle('embed:download', () => startEmbedDownload())

// STT model status + download — same shape as embed:* so the Settings
// UI can share a panel pattern. Status reports whether the whisper
// model files are on disk + whether a download is currently in flight.
ipcMain.handle('stt:status', () => getSttStatus())
ipcMain.handle('stt:downloadModel', () => startSttDownload())

// ---- Sidebar window-resize ----

const SIDEBAR_WIDTH = 260
let sidebarOpenInMain = false

ipcMain.handle('sidebar:setOpen', async (_event, open: boolean) => {
  if (!mainWindow || mainWindow.isDestroyed()) return sidebarOpenInMain
  if (open === sidebarOpenInMain) return sidebarOpenInMain // idempotent
  const size = mainWindow.getSize()
  const w = size[0] ?? 800
  const h = size[1] ?? 600
  sidebarOpenInMain = open
  if (open) {
    // Lock the window minimum width so the user can't drag-resize narrower
    // than sidebar + meaningful content. Without this lock, a user could
    // resize down to ~260, the sidebar would cover the entire visible
    // area, and the app would feel "stuck" (no maid, no chat reachable).
    mainWindow.setMinimumSize(260 + SIDEBAR_WIDTH, 400)
    mainWindow.setSize(w + SIDEBAR_WIDTH, h)
  } else {
    // Restore the bare minimum (the BrowserWindow constructor's 260,400).
    // Sequence matters: shrink the window FIRST while min-size is still
    // permissive, THEN tighten min-size. Setting min-size first would
    // refuse the shrink.
    mainWindow.setSize(Math.max(260, w - SIDEBAR_WIDTH), h)
    mainWindow.setMinimumSize(260, 400)
  }
  // Broadcast the resolved state so any renderer that drifted out of
  // sync (e.g. via an HMR restart that wiped its useState) can
  // reconcile. The handler also returns the value for the caller's
  // direct await.
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('sidebar:state', sidebarOpenInMain)
    }
  }
  return sidebarOpenInMain
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
  registerFontProtocol()
  registerBackgroundProtocol()
  // Eager-seed demos.json — readDemos creates it on first read, but doing
  // so up-front means the user can find the file immediately after install
  // instead of having to press the hotkey once to "materialize" it.
  await readDemos()

  // Sequence matters: memory must finish resuming its session before any
  // chat IPC handler fires, otherwise the first turn lands in a fresh
  // session and breaks continuity. createWindow is last so the renderer
  // never sees a half-initialized backend.
  await initMemory()
  // Token usage tracker — separate sqlite file (usage.sqlite), not
  // touched by reset:memory. After init the recordUsage path is wired
  // into chat-host.runExtraction + chat/run.streamText so every LLM
  // call lands a row. Safe to init before or after memory.
  initUsage()
  // initReminders() was the v0.0.13-era host. It's been dead code since
  // the unified TaskService landed: no tool calls it, no UI reads from
  // it. Worse, it kept reminders.sqlite open during boot, which made
  // initTasks's "rename to .bak after migration" silently fail with
  // EBUSY. Removed.
  // Tasks (unified reminders + TODOs, v0.0.14) — depends on memory for
  // session-id injection in add(). Migrates legacy reminders.sqlite on
  // first run if found.
  await initTasks()
  // Preset台词 file — loaded once at boot; user edits + restart picks
  // up the new values. Bundled defaults serve as fallback for missing
  // / malformed file, so the renderer always gets a valid structure.
  await initLines()
  initProactive(onConfigChange)
  initNotifListener()
  initAffinity(getConfig().persona.preset)
  initWeeklyReview()
  initPresence(() => mainWindow)
  // Wire the goodbye-on-close hook BEFORE creating the window — that way
  // the very first quit attempt (whether from window close, Cmd-Q, etc.)
  // is intercepted and gets the farewell line.
  initGoodbye()
  // Sync OS auto-start registration to whatever the persisted config says.
  // Runs every boot so the user's choice survives uninstall/reinstall
  // (the registry entry would be orphaned otherwise).
  applyStartAtLogin(getConfig().window.startAtLogin)
  initHotkey(() => mainWindow)
  applyHotkey(getConfig().window.summonHotkey)
  createWindow()
  // Fire-and-forget the greeting — it self-waits for the renderer to be
  // ready, so we don't block window creation behind an LLM round-trip.
  void greetOnLaunch()
  // Auto-update host — checks GitHub Releases 30s after boot + every 6h.
  // Skipped in dev mode. Broadcasts updater:downloaded to renderer when
  // a new version is ready; renderer shows a pill to restart.
  initUpdater()
  // Demo profile seeding — only fires when --demo on argv. Pumps a
  // few L3 facts + mid-tier affinity + 3 demo tasks into the SANDBOX
  // userData so screen-recording / showcasing the app starts from a
  // "user who's already comfortable with her" state, not a cold
  // stranger. Awaited so a demo always sees the seed take effect
  // before the first frame.
  void seedDemoData()
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
 * Wire `meido-font://<filename>` URLs to disk reads under
 * `<userData>/fonts/<filename>`. Strict allow-list of filenames (only
 * the ones registered as OPTIONAL_FONTS) so the renderer can't read
 * arbitrary user files.
 */
function registerFontProtocol(): void {
  protocol.handle('meido-font', async (req) => {
    const url = new URL(req.url)
    // meido-font://lxgw-wenkai/font.ttf — single-segment names also OK
    const filename = decodeURIComponent(
      url.pathname.replace(/^\/+/, '') || url.hostname,
    )
    const resolved = await readFontFile(filename)
    if (!resolved) {
      return new Response('Not Found', {
        status: 404,
        headers: { 'access-control-allow-origin': '*' },
      })
    }
    try {
      const nodeStream = createReadStream(resolved.path)
      const webStream = Readable.toWeb(nodeStream) as ReadableStream
      return new Response(webStream, {
        status: 200,
        headers: {
          'content-type': 'font/ttf',
          'content-length': String(resolved.size),
          'access-control-allow-origin': '*',
          // Fonts on disk are immutable per-install; cache hard so the
          // renderer doesn't re-fetch on every reload.
          'cache-control': 'public, max-age=86400, immutable',
        },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[font] protocol read failed: ${filename} — ${msg}`)
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
