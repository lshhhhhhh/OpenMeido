/**
 * Config service — wraps electron-store, validates with Zod, broadcasts
 * changes to subscribers in main and to all renderer windows over IPC.
 *
 * Storage location: `<userData>/config.json` (per-user, survives app reinstalls
 * on most platforms).
 */

import Store from 'electron-store'
import { BrowserWindow, safeStorage } from 'electron'

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
  // If the renderer sent a fresh plaintext mail password (passwordEncrypted
  // = false but password non-empty), encrypt it now so plaintext never
  // touches disk. safeStorage uses OS keychain on macOS, DPAPI on Windows,
  // libsecret on Linux — falls back to plaintext on platforms where it's
  // unavailable (then the flag stays false and we behave like API keys).
  if (next.mail.password && !next.mail.passwordEncrypted && safeStorage.isEncryptionAvailable()) {
    const ciphertext = safeStorage.encryptString(next.mail.password).toString('base64')
    next = {
      ...next,
      mail: { ...next.mail, password: ciphertext, passwordEncrypted: true },
    }
  }

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

/** Decrypt the mail password if it was stored as ciphertext. Host-side use only. */
export function decryptMailPassword(cfg: Config = current): string {
  if (!cfg.mail.password) return ''
  if (!cfg.mail.passwordEncrypted) return cfg.mail.password
  try {
    return safeStorage.decryptString(Buffer.from(cfg.mail.password, 'base64'))
  } catch (err) {
    console.warn('[config] failed to decrypt mail password:', err)
    return ''
  }
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
/** Same logic but takes just the backend subtree — useful when we have a
 *  draft from Settings that isn't a full Config yet (e.g. the test button). */
export function resolveBackendKey(backend: Config['backend']): string {
  if (backend.apiKey) return backend.apiKey
  const url = backend.baseUrl
  if (url.includes('googleapis.com')) return process.env.GEMINI_API_KEY ?? ''
  if (url.includes('anthropic.com')) return process.env.ANTHROPIC_API_KEY ?? ''
  if (url.includes('openai.com')) return process.env.OPENAI_API_KEY ?? ''
  if (url.includes('bigmodel.cn')) return process.env.ZHIPU_API_KEY ?? ''
  if (url.includes('deepseek.com')) return process.env.DEEPSEEK_API_KEY ?? ''
  if (url.includes('dashscope.aliyuncs.com')) return process.env.DASHSCOPE_API_KEY ?? ''
  if (url.includes('volces.com') || url.includes('ark.cn-beijing')) return process.env.ARK_API_KEY ?? ''
  // Local / self-hosted endpoints often don't need a real key.
  return process.env.OPENAI_API_KEY ?? ''
}

export function resolveApiKey(cfg: Config = current): string {
  return resolveBackendKey(cfg.backend)
}
