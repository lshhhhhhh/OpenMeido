import { contextBridge, ipcRenderer } from 'electron'

import { IPC, type ChatEvent } from '../shared/ipc.js'

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
}

contextBridge.exposeInMainWorld('api', api)

// Exported so the renderer can `typeof api` for its global Window augmentation.
export type Api = typeof api
