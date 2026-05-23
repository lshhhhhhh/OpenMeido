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
import { migrateProactiveLegacyKnobs } from '../shared/config-migrations.js'
import { detectCelebrationTriggers } from '../shared/celebrations.js'

const store = new Store<Config>({
  name: 'config',
  defaults: configSchema.parse({}),
})

// Pre-Zod migrations for shape changes between releases. Zod silently
// strips unknown keys, which is fine for additions but loses information
// when a boolean field is replaced by an enum (e.g. proactive.enabled →
// proactive.mode). Translate before parsing so opt-outs survive the
// upgrade.
migrateProactiveLegacyKnobs(store.store as unknown as Record<string, unknown>)

// Re-validate on load — recovers gracefully if a previous version wrote a
// shape we no longer accept, or if the user hand-edited the JSON badly.
let current: Config = configSchema.parse(store.store)

// Wizard-completion migration. The flag was added in v0.0.40; existing
// installs land on the default `false` which would re-prompt long-time
// users on upgrade. If their config already shows signs of "I've used
// this app before" (raw apiKey set in config — NOT via env fallback,
// since env wouldn't persist into config.json), flip the flag silently.
// Fresh installs land at false + empty key → wizard opens as intended.
if (!current.onboarding.wizardCompleted && current.backend.apiKey.trim()) {
  current = {
    ...current,
    onboarding: { ...current.onboarding, wizardCompleted: true },
  }
}
store.store = current

// Migration body lives in src/shared/config-migrations.ts so it stays
// unit-testable from plain Node (no Electron module-load side effects).

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

  // Detect onboarding-milestone celebrations BEFORE we persist + before we
  // flip the matching flags. detectCelebrationTriggers reads prev.flag ===
  // false; if we let setConfig persist with the same flag value, it would
  // be missed; if we'd flipped flags first, the detection would short-
  // circuit. So: diff → flip the flags atomically into `next` → persist.
  const triggers = detectCelebrationTriggers(current, next)
  if (triggers.length > 0) {
    next = {
      ...next,
      onboarding: {
        ...next.onboarding,
        aiSetupCelebrated:
          triggers.includes('ai') || next.onboarding.aiSetupCelebrated,
        advancedTtsCelebrated:
          triggers.includes('tts') || next.onboarding.advancedTtsCelebrated,
      },
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

  // Fire celebrations AFTER persist + subscriber notification so the
  // affinity bump, overlay event, and persona line all see the post-
  // flag-flip state. Dynamic import to break the cycle: celebrations-host
  // depends on config-host (this file) via getConfig().
  if (triggers.length > 0) {
    void (async () => {
      const { fireCelebration } = await import('./celebrations-host.js')
      for (const kind of triggers) {
        try {
          await fireCelebration(kind)
        } catch (err) {
          console.warn(`[celebration] fireCelebration(${kind}) threw:`, err)
        }
      }
    })()
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
  if (url.includes('moonshot.cn') || url.includes('moonshot.ai')) return process.env.MOONSHOT_API_KEY ?? ''
  // Local / self-hosted endpoints often don't need a real key.
  return process.env.OPENAI_API_KEY ?? ''
}

export function resolveApiKey(cfg: Config = current): string {
  return resolveBackendKey(cfg.backend)
}

/**
 * "Has the USER explicitly configured an AI backend?"
 *
 * Checks `cfg.backend.apiKey` directly — does NOT consult env-var
 * fallback. The env-var path is a developer convenience (so devs don't
 * have to retype their key after reset:all wipes config), but it would
 * silently bleed through to UX gating and defeat the very mode we want
 * to test. Real production users have no .env, so the distinction is
 * dev-only — but treating env-var as "configured" makes dev testing of
 * cold-start impossible, and makes the wizard never trigger after
 * reset (both observed in v0.0.39).
 *
 * Used by greeting-host + chat-host to decide whether to take the
 * hardcoded cold-start path, and by the celebration trigger in
 * setConfig to detect "user just configured AI for the first time".
 *
 * (The actual LLM call still uses resolveApiKey which DOES fall back
 * to env — so if config is empty but env has a key, the chat path
 * with cold-start replies STILL doesn't fire any LLM. Consistent UX.)
 */
export function isAiConfigured(cfg: Config = current): boolean {
  return cfg.backend.apiKey.trim().length > 0
}
