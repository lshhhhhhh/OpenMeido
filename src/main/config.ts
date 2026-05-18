/**
 * Config service — wraps electron-store, validates with Zod, broadcasts
 * changes to subscribers in main and to all renderer windows over IPC.
 *
 * Storage location: `<userData>/config.json` (per-user, survives app reinstalls
 * on most platforms).
 */

import Store from 'electron-store'
import { BrowserWindow } from 'electron'

import { configSchema, ConfigIPC, type Config } from '../shared/config.js'

const store = new Store<Config>({
  name: 'config',
  defaults: configSchema.parse({}),
})

// Re-validate on load — recovers gracefully if a previous version wrote a
// shape we no longer accept, or if the user hand-edited the JSON badly.
let current: Config = configSchema.parse(store.store)
store.store = current

type ChangeListener = (next: Config) => void
const mainListeners = new Set<ChangeListener>()

export function getConfig(): Config {
  return current
}

export function setConfig(next: Config): Config {
  current = configSchema.parse(next)
  store.store = current

  // Notify in-process subscribers (chat.ts re-reads provider on next call).
  for (const cb of mainListeners) cb(current)

  // Notify all renderer windows so the settings UI in any of them updates.
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(ConfigIPC.Changed, current)
  }

  return current
}

/** Subscribe inside the main process. Returns an unsubscribe function. */
export function onConfigChange(cb: ChangeListener): () => void {
  mainListeners.add(cb)
  return () => mainListeners.delete(cb)
}

/**
 * Resolve the API key with .env fallback. Empty in config means "use whatever
 * is in process.env for the matching provider". Shipped builds shouldn't
 * carry .env, but it's convenient for the developer to skip the GUI.
 */
export function resolveApiKey(cfg: Config = current): string {
  if (cfg.backend.apiKey) return cfg.backend.apiKey
  const url = cfg.backend.baseUrl
  if (url.includes('googleapis.com')) return process.env.GEMINI_API_KEY ?? ''
  if (url.includes('anthropic.com')) return process.env.ANTHROPIC_API_KEY ?? ''
  if (url.includes('openai.com')) return process.env.OPENAI_API_KEY ?? ''
  // Local / self-hosted endpoints often don't need a real key.
  return process.env.OPENAI_API_KEY ?? ''
}
