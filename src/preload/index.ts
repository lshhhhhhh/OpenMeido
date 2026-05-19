import { contextBridge, ipcRenderer } from 'electron'

import { IPC, type ChatEvent, type ChatImageAttachment } from '../shared/ipc.js'
import { ConfigIPC } from '../shared/config-ipc.js'
// Type-only import — erased at runtime, doesn't pull Zod into preload bundle.
import type { Config } from '../shared/config.js'
import type { Episode, Fact, SessionSummary } from '../core/memory/types.js'
import type { Reminder } from '../core/reminders/types.js'
import type { ModelListEntry, ModelSidecar } from '../shared/live2d-models.js'
import type { Demo } from '../shared/demos.js'

type MailTestResult = { ok: true } | { ok: false; error: string }
type MemoryStatus =
  | { ready: false; initError?: string }
  | { ready: true; count: number; sessionId: string }

/**
 * Typed bridge between renderer (sandboxed) and main (Node).
 *
 * Renderer code only ever sees `window.api`. Anything not exposed here is
 * unreachable from the page — that's the whole point of contextIsolation.
 */
const api = {
  chat: {
    send(text: string, images?: ChatImageAttachment[]): string {
      const messageId = crypto.randomUUID()
      ipcRenderer.send(IPC.ChatSend, { messageId, text, images })
      return messageId
    },

    /** Subscribe to all chat events. Returns an unsubscribe function. */
    onEvent(cb: (event: ChatEvent) => void): () => void {
      const handler = (_: Electron.IpcRendererEvent, event: ChatEvent): void => cb(event)
      ipcRenderer.on(IPC.ChatEvent, handler)
      return () => {
        ipcRenderer.off(IPC.ChatEvent, handler)
      }
    },

    /**
     * Probe the LLM backend without spending tokens. Hits `/models` on the
     * OpenAI-compatible endpoint. `apiKeyOverride` lets Settings pass a key
     * the user has typed but not yet saved.
     */
    test(
      cfg: Config['backend'],
      apiKeyOverride?: string,
    ): Promise<{ ok: boolean; error?: string }> {
      return ipcRenderer.invoke('chat:test', { cfg, apiKeyOverride }) as Promise<{
        ok: boolean
        error?: string
      }>
    },

    /**
     * Subscribe to LLM connectivity status pushes — fired by main after a
     * test or a real chat call. App-bar status pill listens.
     */
    onStatus(cb: (status: 'ok' | 'error' | 'idle') => void): () => void {
      const handler = (_: Electron.IpcRendererEvent, status: 'ok' | 'error' | 'idle'): void =>
        cb(status)
      ipcRenderer.on('chat:status', handler)
      return () => {
        ipcRenderer.off('chat:status', handler)
      }
    },
  },

  config: {
    get(): Promise<Config> {
      return ipcRenderer.invoke(ConfigIPC.Get) as Promise<Config>
    },

    set(next: Config): Promise<Config> {
      return ipcRenderer.invoke(ConfigIPC.Set, next) as Promise<Config>
    },

    /** Fires whenever the config is written from any window. */
    onChange(cb: (next: Config) => void): () => void {
      const handler = (_: Electron.IpcRendererEvent, next: Config): void => cb(next)
      ipcRenderer.on(ConfigIPC.Changed, handler)
      return () => {
        ipcRenderer.off(ConfigIPC.Changed, handler)
      }
    },
  },

  mail: {
    /**
     * Probe an IMAP connection without writing to disk. `passwordPlaintext`
     * is passed when the user has typed a new password in Settings that
     * hasn't been saved yet — otherwise main decrypts the stored ciphertext.
     */
    test(cfg: Config['mail'], passwordPlaintext?: string): Promise<MailTestResult> {
      return ipcRenderer.invoke('mail:test', { cfg, passwordPlaintext }) as Promise<MailTestResult>
    },
  },

  window: {
    /**
     * Toggle OS-level click-through on the BrowserWindow. The renderer
     * decides per-mousemove whether the cursor sits on opaque UI or
     * transparent canvas space, and only flips this on actual state
     * transitions to avoid setIgnoreMouseEvents churn. `forward: true`
     * is set in main so mousemove keeps flowing even while the window
     * is ignoring clicks — needed to detect when the cursor re-enters
     * an opaque region.
     */
    setClickThrough(enabled: boolean): void {
      ipcRenderer.send('window:setClickThrough', enabled)
    },
    /**
     * 20Hz OS-level cursor position stream from main. Fills the gap when
     * the window is unfocused and Chromium's forward-mousemove is too
     * laggy to drive click-through state changes off real DOM events.
     * Returns an unsubscribe function.
     */
    onCursorPoint(
      cb: (info: { clientX: number; clientY: number; inside: boolean }) => void,
    ): () => void {
      const handler = (
        _: Electron.IpcRendererEvent,
        info: { clientX: number; clientY: number; inside: boolean },
      ): void => cb(info)
      ipcRenderer.on('cursor:point', handler)
      return () => {
        ipcRenderer.off('cursor:point', handler)
      }
    },
  },

  proactive: {
    /** Maid spoke up on her own (timer / idle trigger). Subscribe to render the bubble. */
    onRemark(
      cb: (info: { text: string; ts: string; triggers: string[] }) => void,
    ): () => void {
      const handler = (
        _: Electron.IpcRendererEvent,
        info: { text: string; ts: string; triggers: string[] },
      ): void => cb(info)
      ipcRenderer.on('proactive:remark', handler)
      return () => {
        ipcRenderer.off('proactive:remark', handler)
      }
    },
  },

  tts: {
    /** Microsoft Edge voice catalog. Cached server-side so this is fast on repeat calls. */
    listVoices(): Promise<
      { shortName: string; locale: string; gender: string; friendlyName: string }[]
    > {
      return ipcRenderer.invoke('tts:listVoices') as Promise<
        { shortName: string; locale: string; gender: string; friendlyName: string }[]
      >
    },
    /**
     * Synthesize a string. Returns base64-encoded audio bytes (MP3 for Edge,
     * WAV for GPT-SoVITS) ready to feed into AudioContext.decodeAudioData.
     *
     * If `override` is provided, main uses that draft TTS config instead of
     * the persisted one — Settings calls this for the 试听 button so users
     * can preview before saving. If omitted, main reads from current config.
     *
     * Returns `{ error }` on failure (network down, voice unavailable, etc.)
     * — caller decides whether to silently skip or surface a toast.
     */
    synthesize(
      text: string,
      override?: Config['tts'],
    ): Promise<{ base64: string; mimeType: 'audio/mpeg' | 'audio/wav' } | { error: string }> {
      return ipcRenderer.invoke('tts:synthesize', { text, override }) as Promise<
        { base64: string; mimeType: 'audio/mpeg' | 'audio/wav' } | { error: string }
      >
    },
  },

  screen: {
    /**
     * Capture EVERY connected screen as a list of base64 PNGs. Single-monitor
     * users get a one-element array. The model decides which screen is
     * relevant, so the UI never has to ask.
     */
    capture(): Promise<{ mimeType: string; base64: string }[]> {
      return ipcRenderer.invoke('screen:capture') as Promise<
        { mimeType: string; base64: string }[]
      >
    },
  },

  memory: {
    status(): Promise<MemoryStatus> {
      return ipcRenderer.invoke('memory:status') as Promise<MemoryStatus>
    },
    listRecent(limit: number, sessionId?: string): Promise<Episode[]> {
      return ipcRenderer.invoke('memory:listRecent', limit, sessionId) as Promise<Episode[]>
    },
    listSessions(): Promise<SessionSummary[]> {
      return ipcRenderer.invoke('memory:listSessions') as Promise<SessionSummary[]>
    },
    clear(): Promise<number> {
      return ipcRenderer.invoke('memory:clear') as Promise<number>
    },
    deleteSession(sessionId: string): Promise<number> {
      return ipcRenderer.invoke('memory:deleteSession', sessionId) as Promise<number>
    },
    listFacts(limit?: number): Promise<Fact[]> {
      return ipcRenderer.invoke('memory:listFacts', limit) as Promise<Fact[]>
    },
    clearFacts(): Promise<number> {
      return ipcRenderer.invoke('memory:clearFacts') as Promise<number>
    },
    /** Force a reflection cycle on demand (Settings → 记忆 → "提取事实"). */
    reflectNow(): Promise<number> {
      return ipcRenderer.invoke('memory:reflectNow') as Promise<number>
    },
    newSession(): Promise<string | null> {
      return ipcRenderer.invoke('memory:newSession') as Promise<string | null>
    },
    setSession(id: string): Promise<string | null> {
      return ipcRenderer.invoke('memory:setSession', id) as Promise<string | null>
    },
    onError(
      cb: (info: { operation: string; message: string; ts: number }) => void,
    ): () => void {
      const handler = (_: Electron.IpcRendererEvent, info: { operation: string; message: string; ts: number }): void => cb(info)
      ipcRenderer.on('memory:error', handler)
      return () => {
        ipcRenderer.off('memory:error', handler)
      }
    },
  },

  live2d: {
    /**
     * Subscribe to Live2D commands broadcast by main (chat tool calls land here).
     * Returns unsubscribe.
     */
    onCommand(
      cb: (
        cmd:
          | { type: 'setExpression'; name: string | null }
          | { type: 'playMotion'; group: string; index?: number },
      ) => void,
    ): () => void {
      const handler = (
        _: Electron.IpcRendererEvent,
        cmd:
          | { type: 'setExpression'; name: string | null }
          | { type: 'playMotion'; group: string; index?: number },
      ): void => cb(cmd)
      ipcRenderer.on('live2d:command', handler)
      return () => {
        ipcRenderer.off('live2d:command', handler)
      }
    },
    /** Enumerate installed models from <userData>/live2d-models/. */
    listModels(): Promise<ModelListEntry[]> {
      return ipcRenderer.invoke('live2d:listModels') as Promise<ModelListEntry[]>
    },
    /** Fetch a single model's sidecar (or synthesized defaults). */
    getSidecar(name: string): Promise<ModelSidecar | null> {
      return ipcRenderer.invoke('live2d:getSidecar', name) as Promise<ModelSidecar | null>
    },
    /** Persist a sidecar edit (emotion mapping changes, lip-sync param, etc.). */
    setSidecar(name: string, sidecar: ModelSidecar): Promise<{ ok: true }> {
      return ipcRenderer.invoke('live2d:setSidecar', name, sidecar) as Promise<{ ok: true }>
    },
    /** Remove a model directory under userData. Idempotent. */
    deleteModel(name: string): Promise<{ ok: true }> {
      return ipcRenderer.invoke('live2d:deleteModel', name) as Promise<{ ok: true }>
    },
    /**
     * Ask the LLM to map this model's expressions/motions onto the 8 emotion
     * enum slots, then persist the result to the sidecar. Uses whichever chat
     * backend is currently configured.
     */
    autoBindEmotions(
      name: string,
    ): Promise<{ ok: true; sidecar: ModelSidecar } | { ok: false; error: string }> {
      return ipcRenderer.invoke('live2d:autoBindEmotions', name) as Promise<
        { ok: true; sidecar: ModelSidecar } | { ok: false; error: string }
      >
    },
    /**
     * Open a file picker for a .zip and unpack into userData. Returns the
     * derived model name on success, or canceled=true if the user dismissed.
     */
    importZip(
      opts: { overwrite?: boolean } = {},
    ): Promise<{ ok: true; name: string } | { ok: false; error: string; canceled?: boolean }> {
      return ipcRenderer.invoke('live2d:importZip', opts) as Promise<
        { ok: true; name: string } | { ok: false; error: string; canceled?: boolean }
      >
    },
  },

  demos: {
    /** Fetch the current demo list from disk (one demo = one hotkey). */
    list(): Promise<Demo[]> {
      return ipcRenderer.invoke('demos:list') as Promise<Demo[]>
    },
    /** Open the demos.json in the OS default text editor. Returns the path. */
    reveal(): Promise<string> {
      return ipcRenderer.invoke('demos:reveal') as Promise<string>
    },
  },

  reminders: {
    list(limit: number = 50): Promise<Reminder[]> {
      return ipcRenderer.invoke('reminders:list', limit) as Promise<Reminder[]>
    },
    cancel(id: number): Promise<boolean> {
      return ipcRenderer.invoke('reminders:cancel', id) as Promise<boolean>
    },
    /** Fires when a scheduled reminder's timer goes off in main. */
    onFired(cb: (reminder: Reminder) => void): () => void {
      const handler = (_: Electron.IpcRendererEvent, r: Reminder): void => cb(r)
      ipcRenderer.on('reminder:fired', handler)
      return () => {
        ipcRenderer.off('reminder:fired', handler)
      }
    },
  },
}

contextBridge.exposeInMainWorld('api', api)

// Exported so the renderer can `typeof api` for its global Window augmentation.
export type Api = typeof api
