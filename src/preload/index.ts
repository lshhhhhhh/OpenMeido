import { contextBridge, ipcRenderer } from 'electron'

import { IPC, type ChatEvent, type ChatImageAttachment } from '../shared/ipc.js'
import { ConfigIPC } from '../shared/config-ipc.js'
// Type-only import — erased at runtime, doesn't pull Zod into preload bundle.
import type { Config } from '../shared/config.js'
import type { Episode, SessionSummary } from '../core/memory/types.js'

type MailTestResult = { ok: true } | { ok: false; error: string }
type MemoryStatus =
  | { ready: false }
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
    newSession(): Promise<string | null> {
      return ipcRenderer.invoke('memory:newSession') as Promise<string | null>
    },
  },
}

contextBridge.exposeInMainWorld('api', api)

// Exported so the renderer can `typeof api` for its global Window augmentation.
export type Api = typeof api
