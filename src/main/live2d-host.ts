/**
 * Live2D command host. Tools called by the LLM in the main process need to
 * drive the model that lives in the renderer. We broadcast a single
 * 'live2d:command' channel to every open BrowserWindow; the renderer
 * dispatches the payload to its Live2DController.
 *
 * We don't keep a direct ref to the renderer's controller in main, because
 * the renderer can hot-reload, close, and reopen — broadcast is more
 * resilient than a tracked handle.
 */

import { BrowserWindow } from 'electron'

export type Live2DCommand =
  | { type: 'setExpression'; name: string | null }
  | { type: 'playMotion'; group: string; index?: number }

export function broadcastLive2D(cmd: Live2DCommand): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('live2d:command', cmd)
    }
  }
}
