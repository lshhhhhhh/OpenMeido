import { contextBridge, ipcRenderer } from 'electron'

import { IPC, type ChatEvent, type ChatImageAttachment } from '../shared/ipc.js'
import { ConfigIPC } from '../shared/config-ipc.js'
// Type-only import — erased at runtime, doesn't pull Zod into preload bundle.
import type { Config } from '../shared/config.js'
import type { Episode, Fact, SessionSummary } from '../core/memory/types.js'
import type { Reminder } from '../core/reminders/types.js'
import type { Task } from '../core/tasks/types.js'
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
     * Quick screen-react — captures all displays, sends them with the
     * current persona+tier prompt to the vision-capable model, and
     * broadcasts the resulting comment through the proactive:remark
     * channel (so the chat panel renders an assistant bubble + TTS
     * plays + emotion classifier fires, same as a normal proactive).
     *
     * Returns the produced text on success, or an error string when
     * the model refused (privacy-sensitive screen) / network failed.
     */
    quickScreenReact(): Promise<
      { ok: true; text: string } | { ok: false; error: string }
    > {
      return ipcRenderer.invoke('chat:quickScreenReact') as Promise<
        { ok: true; text: string } | { ok: false; error: string }
      >
    },

    /** List attached displays — used by Settings to show the screen-
     *  exclusion picker. Each entry has a small preview thumbnail. */
    listScreens(): Promise<
      Array<{ id: string; name: string; previewBase64: string }>
    > {
      return ipcRenderer.invoke('screen:list') as Promise<
        Array<{ id: string; name: string; previewBase64: string }>
      >
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
     * Toggle window-level click-through. When `ignore` is true, mouse
     * input passes through to whatever's behind OpenMeido (desktop /
     * other windows). Renderer drives this from the Live2D coverage
     * probe — over-pixel = false (capture), over-transparent = true
     * (pass through). Main process applies the corresponding
     * setIgnoreMouseEvents call with forward:true so mousemove still
     * fires (otherwise we couldn't detect when to turn it back off).
     *
     * Gated by `cfg.window.clickThroughTransparent` — when that's off,
     * the renderer never calls this, and the window stays fully
     * interactive.
     */
    setIgnoreMouseEvents(ignore: boolean): Promise<void> {
      return ipcRenderer.invoke('window:setIgnoreMouseEvents', ignore) as Promise<void>
    },
    /** Reports whether the configured global hotkey is currently registered. */
    getHotkeyStatus(): Promise<{
      registered: boolean
      accelerator: string
      error: string | null
    }> {
      return ipcRenderer.invoke('window:getHotkeyStatus') as Promise<{
        registered: boolean
        accelerator: string
        error: string | null
      }>
    },
  },

  affinity: {
    /** Current affinity for the active (or specified) persona. Returns null
     *  before memory init. */
    get(personaId?: string): Promise<{
      personaId: string
      score: number
      lastUpdated: string
      lastReason: string | null
    } | null> {
      return ipcRenderer.invoke('affinity:get', personaId) as Promise<{
        personaId: string
        score: number
        lastUpdated: string
        lastReason: string | null
      } | null>
    },
    /** Dev-only — force the score for a persona (defaults to active).
     *  Skips all guardrails (per-turn clamp / curve / daily cap). Returns
     *  `{ ok: false, error: ... }` in production builds where the IPC
     *  handler isn't registered. Use from DevTools to test tier-driven
     *  prompts: `window.api.affinity.setForTest(90)` / `(0)` / `(50)`. */
    setForTest(
      score: number,
      personaId?: string,
    ): Promise<{ ok: boolean; personaId?: string; score?: number; error?: string }> {
      return ipcRenderer.invoke('affinity:setForTest', score, personaId) as Promise<{
        ok: boolean
        personaId?: string
        score?: number
        error?: string
      }>
    },
    /** All personas (built-in + custom) with their affinity + episode count.
     *  Drives the Settings 人物 tab chip annotations. */
    listAll(): Promise<
      Array<{
        personaId: string
        score: number
        lastUpdated: string
        lastReason: string | null
        episodeCount: number
      }>
    > {
      return ipcRenderer.invoke('affinity:listAll') as Promise<
        Array<{
          personaId: string
          score: number
          lastUpdated: string
          lastReason: string | null
          episodeCount: number
        }>
      >
    },
    /** Subscribe to score changes. Fires on every successful judge update.
     *  `delta` is the effective change in score (post-guardrail) when the
     *  update came from a judgement or presence bump — null for decay /
     *  dev overrides / one-shot writes. Renderers use it to surface a
     *  floating "+1" / "-1" over the affinity chip; null = silent update. */
    onChanged(
      cb: (info: {
        personaId: string
        score: number
        tier: { tier: string; zhLabel: string; min: number; max: number }
        reason: string
        delta: number | null
      }) => void,
    ): () => void {
      const handler = (
        _: Electron.IpcRendererEvent,
        info: {
          personaId: string
          score: number
          tier: { tier: string; zhLabel: string; min: number; max: number }
          reason: string
          delta: number | null
        },
      ): void => cb(info)
      ipcRenderer.on('affinity:changed', handler)
      return () => {
        ipcRenderer.off('affinity:changed', handler)
      }
    },
    /** Subscribe to persona-switch events (config change). The sidebar
     *  uses this to re-fetch the affinity for the new active persona. */
    onPersonaSwitched(cb: (info: { personaId: string }) => void): () => void {
      const handler = (_: Electron.IpcRendererEvent, info: { personaId: string }): void =>
        cb(info)
      ipcRenderer.on('persona:switched', handler)
      return () => {
        ipcRenderer.off('persona:switched', handler)
      }
    },
  },

  persona: {
    /** Delete a persona's entire bucket (episodes + facts + affinity).
     *  Returns total rows removed. The renderer should NOT call this while
     *  the persona is active; switch first. */
    delete(personaId: string): Promise<number> {
      return ipcRenderer.invoke('persona:delete', personaId) as Promise<number>
    },
  },

  background: {
    /** Open a native picker; main copies the chosen file under userData and
     *  returns the basename to write into config.customBackgrounds[personaId].
     *  Null = user cancelled. */
    import(personaId: string): Promise<{ basename: string } | null> {
      return ipcRenderer.invoke('background:import', personaId) as Promise<{
        basename: string
      } | null>
    },
    /** Remove the on-disk copy. Idempotent; doesn't throw on missing file. */
    delete(basename: string): Promise<{ ok: true }> {
      return ipcRenderer.invoke('background:delete', basename) as Promise<{ ok: true }>
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

  mute: {
    /**
     * Persist a mute-toggle feedback line as an assistant episode so the
     * NEXT chat turn has it in context (otherwise her "主人你回来了啊"
     * would be invisible to the model when the user replies "是啊我回来
     * 了" — model gets a dangling user message).
     *
     * Deliberately does NOT trigger the affinity classifier or emotion
     * apply — these are UI acknowledgement lines, not real conversation,
     * and multiplying them through the warmth-judging pipeline would
     * drift the score every time the user toggles mute.
     */
    announce(text: string): Promise<{ ok: boolean }> {
      return ipcRenderer.invoke('mute:announce', { text }) as Promise<{ ok: boolean }>
    },
  },

  lines: {
    /** Fetch the merged preset台词 structure (bundled defaults ∪ user
     *  overrides from lines.json). Renderer calls once at boot and
     *  caches; user edits require app restart to take effect. */
    get(): Promise<unknown> {
      return ipcRenderer.invoke('lines:get') as Promise<unknown>
    },
    /** Open the user-editable lines.json in the OS default editor.
     *  Seeds the file with defaults on first call. */
    openFile(): Promise<{ ok: boolean; path?: string; error?: string }> {
      return ipcRenderer.invoke('lines:openFile') as Promise<{ ok: boolean; path?: string; error?: string }>
    },
    /** Where the file lives. Used by Settings hint text. */
    path(): Promise<string> {
      return ipcRenderer.invoke('lines:path') as Promise<string>
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

  stt: {
    /**
     * Transcribe pre-decoded audio samples to text via local Whisper.
     * Caller must supply Float32 PCM at 16 kHz mono (the renderer
     * captures via MediaRecorder → AudioContext.decodeAudioData →
     * resamples to 16 kHz before sending). First call lazy-loads the
     * Whisper model (~74 MB, cached in userData/hf-cache thereafter).
     */
    transcribe(samples: Float32Array): Promise<
      | { ok: true; text: string; rawText: string }
      | { ok: false; error: string }
    > {
      return ipcRenderer.invoke('stt:transcribe', { samples }) as Promise<
        | { ok: true; text: string; rawText: string }
        | { ok: false; error: string }
      >
    },
    /** Whether the whisper model files are on disk + whether a download
     *  is currently in flight. Mirrors the embed model panel's shape. */
    status(): Promise<{
      modelPresent: boolean
      inProgress: boolean
      totalBytes: number
      receivedBytes: number
      currentFile: string | null
    }> {
      return ipcRenderer.invoke('stt:status') as Promise<{
        modelPresent: boolean
        inProgress: boolean
        totalBytes: number
        receivedBytes: number
        currentFile: string | null
      }>
    },
    /** Kick off the model download. Resolves when finished (success or
     *  failure). The progress events fire while it runs. */
    download(): Promise<{ ok: true } | { ok: false; error: string }> {
      return ipcRenderer.invoke('stt:downloadModel') as Promise<
        { ok: true } | { ok: false; error: string }
      >
    },
    /** Fires on each chunk during download. */
    onProgress(
      cb: (p: {
        inProgress: boolean
        totalBytes: number
        receivedBytes: number
        currentFile: string | null
      }) => void,
    ): () => void {
      const handler = (
        _: Electron.IpcRendererEvent,
        p: {
          inProgress: boolean
          totalBytes: number
          receivedBytes: number
          currentFile: string | null
        },
      ): void => cb(p)
      ipcRenderer.on('stt:downloadProgress', handler)
      return () => {
        ipcRenderer.off('stt:downloadProgress', handler)
      }
    },
    /** Fires once when the download finishes (ok=true) or errors out. */
    onComplete(cb: (r: { ok: true } | { ok: false; error: string }) => void): () => void {
      const handler = (
        _: Electron.IpcRendererEvent,
        r: { ok: true } | { ok: false; error: string },
      ): void => cb(r)
      ipcRenderer.on('stt:downloadComplete', handler)
      return () => {
        ipcRenderer.off('stt:downloadComplete', handler)
      }
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
    /** Recent episodes for a specific persona, regardless of active.
     *  Used by Settings 人物 tab to preview history when a chip is
     *  focused but not yet saved. */
    listRecentFor(personaId: string, limit: number = 200): Promise<Episode[]> {
      return ipcRenderer.invoke('memory:listRecentFor', personaId, limit) as Promise<Episode[]>
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
    deleteFact(factId: number): Promise<boolean> {
      return ipcRenderer.invoke('memory:deleteFact', factId) as Promise<boolean>
    },
    /** Force a reflection cycle on demand (Settings → 记忆 → "提取事实"). */
    reflectNow(): Promise<number> {
      return ipcRenderer.invoke('memory:reflectNow') as Promise<number>
    },
    /** Sidebar feed: recent tool calls + results, derived from episodes. */
    recentToolActivity(limit: number = 20): Promise<
      Array<{
        episodeId: number
        ts: string
        kind: 'call' | 'result'
        toolName: string
        summary: string
      }>
    > {
      return ipcRenderer.invoke('memory:recentToolActivity', limit) as Promise<
        Array<{
          episodeId: number
          ts: string
          kind: 'call' | 'result'
          toolName: string
          summary: string
        }>
      >
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

  // Unified tasks (v0.0.14): supersedes the old reminders/todos split.
  // A task may carry a fireAt (becomes a time-triggered reminder) and/or
  // sit on the list forever (becomes a TODO). Both share this API.
  tasks: {
    listAll(recentDoneLimit: number = 5): Promise<Task[]> {
      return ipcRenderer.invoke('tasks:listAll', recentDoneLimit) as Promise<Task[]>
    },
    add(
      text: string,
      fireAt: string | null = null,
      dueAt: string | null = null,
    ): Promise<number | null> {
      return ipcRenderer.invoke('tasks:add', text, fireAt, dueAt) as Promise<number | null>
    },
    markDone(id: number): Promise<boolean> {
      return ipcRenderer.invoke('tasks:markDone', id) as Promise<boolean>
    },
    markActive(id: number): Promise<boolean> {
      return ipcRenderer.invoke('tasks:markActive', id) as Promise<boolean>
    },
    remove(id: number): Promise<boolean> {
      return ipcRenderer.invoke('tasks:remove', id) as Promise<boolean>
    },
    onFired(cb: (task: Task) => void): () => void {
      const handler = (_: Electron.IpcRendererEvent, t: Task): void => cb(t)
      ipcRenderer.on('task:fired', handler)
      return () => {
        ipcRenderer.off('task:fired', handler)
      }
    },
    onChanged(cb: () => void): () => void {
      const handler = (): void => cb()
      ipcRenderer.on('tasks:changed', handler)
      return () => {
        ipcRenderer.off('tasks:changed', handler)
      }
    },
  },

  // Sidebar window-resize control. Renderer calls this when the user
  // toggles the sidebar so main can grow/shrink the BrowserWindow by
  // ~260px to the right. The sidebar then occupies the new space rather
  // than overlapping existing chat content.
  sidebar: {
    setOpen(open: boolean): Promise<void> {
      return ipcRenderer.invoke('sidebar:setOpen', open) as Promise<void>
    },
  },

  // Embed-model download. The renderer kicks off the download via
  // `download()` (which resolves when done), watches progress via
  // `onProgress(cb)`, and queries current state via `status()` to
  // decide whether to show the "下载嵌入模型" banner / Settings
  // section in the first place.
  embed: {
    status(): Promise<{
      naive: boolean
      modelPresent: boolean
      inProgress: boolean
      totalBytes: number
      receivedBytes: number
      currentFile: string | null
    }> {
      return ipcRenderer.invoke('embed:status') as Promise<{
        naive: boolean
        modelPresent: boolean
        inProgress: boolean
        totalBytes: number
        receivedBytes: number
        currentFile: string | null
      }>
    },
    download(): Promise<{ ok: true } | { ok: false; error: string }> {
      return ipcRenderer.invoke('embed:download') as Promise<
        { ok: true } | { ok: false; error: string }
      >
    },
    /** Fires on each chunk during a download. */
    onProgress(
      cb: (p: {
        inProgress: boolean
        totalBytes: number
        receivedBytes: number
        currentFile: string | null
      }) => void,
    ): () => void {
      const handler = (
        _: Electron.IpcRendererEvent,
        p: {
          inProgress: boolean
          totalBytes: number
          receivedBytes: number
          currentFile: string | null
        },
      ): void => cb(p)
      ipcRenderer.on('embed:downloadProgress', handler)
      return () => {
        ipcRenderer.off('embed:downloadProgress', handler)
      }
    },
    /** Fires once when the download finishes (ok=true) or errors out. */
    onComplete(cb: (r: { ok: true } | { ok: false; error: string }) => void): () => void {
      const handler = (
        _: Electron.IpcRendererEvent,
        r: { ok: true } | { ok: false; error: string },
      ): void => cb(r)
      ipcRenderer.on('embed:downloadComplete', handler)
      return () => {
        ipcRenderer.off('embed:downloadComplete', handler)
      }
    },
  },

  // Diagnostic surface — only meant to be called from DevTools while
  // investigating bugs. Don't wire UI buttons to these.
  diag: {
    /** Fire one presence tick now and dump the gate state to main log. */
    presenceTickNow(): Promise<void> {
      return ipcRenderer.invoke('presence:tickNow') as Promise<void>
    },
  },
}

contextBridge.exposeInMainWorld('api', api)

// Exported so the renderer can `typeof api` for its global Window augmentation.
export type Api = typeof api
