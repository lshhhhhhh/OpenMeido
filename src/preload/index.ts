import { contextBridge, ipcRenderer } from 'electron'

import { IPC, type ChatEvent } from '../shared/ipc.js'
import { ConfigIPC } from '../shared/config-ipc.js'
// Type-only import — erased at runtime, doesn't pull Zod into preload bundle.
import type { Config } from '../shared/config.js'

type MailTestResult = { ok: true } | { ok: false; error: string }

/**
 * Typed bridge between renderer (sandboxed) and main (Node).
 *
 * Renderer code only ever sees `window.api`. Anything not exposed here is
 * unreachable from the page — that's the whole point of contextIsolation.
 */
const api = {
  chat: {
    send(text: string): string {
      const messageId = crypto.randomUUID()
      ipcRenderer.send(IPC.ChatSend, { messageId, text })
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
}

contextBridge.exposeInMainWorld('api', api)

// Exported so the renderer can `typeof api` for its global Window augmentation.
export type Api = typeof api
