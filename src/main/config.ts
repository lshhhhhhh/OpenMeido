/**
 * Config service — wraps electron-store, validates with Zod, broadcasts
 * changes to subscribers in main and to all renderer windows over IPC.
 *
 * Storage location: `<userData>/config.json` (per-user, survives app reinstalls
 * on most platforms).
 */

import Store from 'electron-store'
import { app, BrowserWindow, safeStorage } from 'electron'
import { renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  configSchema,
  ConfigIPC,
  isBackendConfigured,
  isLocalEndpoint,
  mapConfigSecrets,
  type Config,
} from '../shared/config.js'
import { parseConfigLenient, runConfigMigrations } from '../shared/config-migrations.js'
import { detectCelebrationTriggers } from '../shared/celebrations.js'

/** What went wrong loading config.json at boot, for a one-time notice. */
export interface ConfigBootIssues {
  /** config.json wasn't valid JSON — moved aside to this path. */
  corruptBackup?: string
  /** Fields that failed validation and fell back to defaults. */
  dropped: string[]
  /** Copy of the pre-repair file when `dropped` is non-empty. */
  invalidBackup?: string
  /** Encrypted API keys couldn't be decrypted (profile / machine moved). */
  secretsLost?: boolean
}
const bootIssues: ConfigBootIssues = { dropped: [] }
export function getConfigBootIssues(): ConfigBootIssues {
  return bootIssues
}

function openStore(): Store<Config> {
  const opts = { name: 'config', defaults: configSchema.parse({}) }
  try {
    return new Store<Config>(opts)
  } catch (err) {
    // conf throws from its constructor on unparseable JSON
    // (clearInvalidConfig defaults to false). Before, that meant the app
    // could never start again until the user found and deleted the file.
    // Move it aside (keeps their keys recoverable by hand) and start fresh.
    const file = join(app.getPath('userData'), 'config.json')
    const backup = file.replace(/\.json$/, `.corrupt-${Date.now()}.json`)
    try {
      renameSync(file, backup)
      bootIssues.corruptBackup = backup
    } catch (moveErr) {
      console.error('[config] could not move corrupt config.json aside:', moveErr)
    }
    console.error(`[config] config.json unreadable — moved to ${backup}:`, err)
    return new Store<Config>(opts)
  }
}

const store = openStore()

// `store.store` re-reads and re-parses the file on EVERY access, so take
// one copy and do everything on it — the old code migrated one copy and
// then parsed a fresh one, silently discarding every migration.
const raw = store.store as unknown as Record<string, unknown>

// Pre-Zod migrations for shape changes between releases (Zod silently
// strips unknown keys, which loses intent when e.g. a boolean becomes an
// enum) and for provider-retired model ids. See shared/config-migrations.ts.
if (runConfigMigrations(raw)) console.log('[config] applied config migrations')

// Validate without ever throwing: a single bad field falls back to its
// default instead of bricking startup.
const lenient = parseConfigLenient(raw)
if (lenient.dropped.length > 0) {
  bootIssues.dropped = lenient.dropped
  const backup = store.path.replace(/\.json$/, `.invalid-${Date.now()}.json`)
  try {
    writeFileSync(backup, JSON.stringify(raw, null, 2), 'utf-8')
    bootIssues.invalidBackup = backup
  } catch (err) {
    console.warn('[config] could not back up invalid config:', err)
  }
  console.warn(`[config] reset invalid fields to defaults: ${lenient.dropped.join(', ')}`)
}
let current: Config = lenient.config

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

// ── Credentials at rest ─────────────────────────────────────────────────
// API keys / TTS tokens are stored in config.json as `enc:v1:<base64>`
// (safeStorage → DPAPI on Windows) and held as plaintext only in memory.
// Before v0.4.0 every provider key sat in config.json in the clear.
//
// Uses the async safeStorage API — the sync one is deprecated in Electron
// 45 and removed in 46. safeStorage only works after app `ready`, but this
// module loads earlier, so until unlockConfigSecrets() runs (first thing
// in whenReady) `current` still holds the ciphertext strings. Nothing needs
// a key before ready; isAiConfigured only checks non-emptiness.
//
// (mail.password still uses its older sync scheme — see setConfig and
// decryptMailPassword; move it over before bumping to Electron 46.)
const SECRET_PREFIX = 'enc:v1:'
let secretsUnlocked = false
let encryptionAvailable = false
/** plaintext → ciphertext for every secret seen, so saves that don't
 *  change a key stay synchronous (and don't rewrite fresh ciphertext). */
const cipherCache = new Map<string, string>()

/** Sealed copy for disk, or null if some secret isn't encrypted yet. */
function sealFromCache(cfg: Config): Config | null {
  if (!secretsUnlocked || !encryptionAvailable) return cfg
  let missing = false
  const sealed = mapConfigSecrets(cfg, (v) => {
    if (!v || v.startsWith(SECRET_PREFIX)) return v
    const c = cipherCache.get(v)
    if (!c) missing = true
    return c ?? ''
  })
  return missing ? null : sealed
}

let persistChain: Promise<void> = Promise.resolve()

/** Write `current` to disk with secrets sealed. Synchronous when every
 *  secret is already cached; otherwise encrypts the new ones first. */
function persist(): void {
  const sealed = sealFromCache(current)
  if (sealed) {
    store.store = sealed
    return
  }
  persistChain = persistChain.then(async () => {
    try {
      const pending = new Set<string>()
      mapConfigSecrets(current, (v) => {
        if (v && !v.startsWith(SECRET_PREFIX) && !cipherCache.has(v)) pending.add(v)
        return v
      })
      for (const plain of pending) {
        const buf = await safeStorage.encryptStringAsync(plain)
        cipherCache.set(plain, SECRET_PREFIX + buf.toString('base64'))
      }
      const out = sealFromCache(current) // latest state, not a stale snapshot
      if (out) store.store = out
    } catch (err) {
      // Never fall back to writing plaintext; the next save retries.
      console.error('[config] could not encrypt credentials — config not saved:', err)
    }
  })
}

/**
 * Decrypt credentials into memory, and re-save any still stored in
 * plaintext (first launch after upgrading) encrypted. Await once, right
 * at the start of app.whenReady, before any window or LLM call.
 */
export async function unlockConfigSecrets(): Promise<void> {
  if (secretsUnlocked) return
  encryptionAvailable = await safeStorage.isAsyncEncryptionAvailable().catch(() => false)
  const ciphertexts = new Set<string>()
  let sawPlaintext = false
  mapConfigSecrets(current, (v) => {
    if (v.startsWith(SECRET_PREFIX)) ciphertexts.add(v)
    else if (v) sawPlaintext = true
    return v
  })
  const plainOf = new Map<string, string>()
  let lost = false
  let reEncrypt = false
  for (const c of ciphertexts) {
    try {
      if (!encryptionAvailable) throw new Error('safeStorage unavailable')
      const r = await safeStorage.decryptStringAsync(Buffer.from(c.slice(SECRET_PREFIX.length), 'base64'))
      plainOf.set(c, r.result)
      if (r.shouldReEncrypt) reEncrypt = true
      else cipherCache.set(r.result, c)
    } catch (err) {
      lost = true
      console.warn('[config] could not decrypt a stored credential:', err)
      plainOf.set(c, '')
    }
  }
  current = mapConfigSecrets(current, (v) => (v.startsWith(SECRET_PREFIX) ? plainOf.get(v) ?? '' : v))
  secretsUnlocked = true
  if (lost) bootIssues.secretsLost = true
  if ((sawPlaintext || reEncrypt) && encryptionAvailable) {
    persist()
    await persistChain
    console.log('[config] credentials encrypted at rest')
  }
}

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
  persist()

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
  // Local servers (LM Studio, Ollama…) ignore auth, but the OpenAI client
  // refuses to send a request without SOME key.
  if (isLocalEndpoint(url)) return 'local-no-key'
  return process.env.OPENAI_API_KEY ?? ''
}

export function resolveApiKey(cfg: Config = current): string {
  return resolveBackendKey(cfg.backend)
}

/**
 * Resolve the GPT-SoVITS config with .env fallback for any empty field.
 *
 * Why: GPT-SoVITS needs a reference-audio path + its transcript, and
 * those are fiddly to retype. During demos (which start from a fresh
 * `--demo` profile, or after a reset) the dev would otherwise have to
 * re-paste them into Settings every single run. With this, drop them
 * in `.env` once and any empty field in config falls back to the env
 * value. Production users have no `.env`, so this is invisible to them.
 *
 * Env vars (all optional):
 *   SOVITS_BASE_URL   — server base URL (config already defaults to
 *                       http://127.0.0.1:9880, so rarely needed)
 *   SOVITS_REF_AUDIO  — absolute path to the reference clip
 *   SOVITS_REF_TEXT   — exact transcript of that clip
 *   SOVITS_REF_LANG   — reference language (defaults zh)
 *   SOVITS_TEXT_LANG  — synthesis language (defaults zh)
 */
export function resolveSovitsConfig(
  sovits: Config['tts']['sovits'],
): Config['tts']['sovits'] {
  return {
    ...sovits,
    baseUrl: sovits.baseUrl || process.env.SOVITS_BASE_URL || sovits.baseUrl,
    refAudio: sovits.refAudio || process.env.SOVITS_REF_AUDIO || '',
    refText: sovits.refText || process.env.SOVITS_REF_TEXT || '',
    refLang: sovits.refLang || process.env.SOVITS_REF_LANG || sovits.refLang,
    textLang: sovits.textLang || process.env.SOVITS_TEXT_LANG || sovits.textLang,
  }
}

/**
 * "Has the USER explicitly configured an AI backend?"
 *
 * Checks `cfg.backend.apiKey` directly (or a local no-key endpoint
 * like LM Studio) — does NOT consult env-var fallback. The env-var path is a developer convenience (so devs don't
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
  return isBackendConfigured(cfg.backend)
}
