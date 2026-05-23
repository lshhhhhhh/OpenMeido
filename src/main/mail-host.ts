/**
 * Mail host — Electron-side wiring for the core MailService.
 *
 * Builds the IMAP adapter lazily from the current config. Tears it down
 * when the user changes mail settings (next getMailService() rebuilds).
 */

import { createImapAdapter } from './mail/imap-adapter.js'
import { createFakeMailAdapter } from './mail/fake-adapter.js'
import { createMailService, type MailService } from '../core/mail/service.js'
import type { MailAdapter } from '../core/mail/adapter.js'
import { decryptMailPassword, getConfig, onConfigChange } from './config.js'
import type { Config } from '../shared/config.js'

let adapter: MailAdapter | null = null
let service: MailService | null = null
let configuredHash = ''

/** Hash of the bits we care about; if they change we rebuild the adapter. */
function mailHash(cfg: ResolvedMailConfig): string {
  return [cfg.enabled, cfg.host, cfg.port, cfg.secure, cfg.username, cfg.password].join('|')
}

interface ResolvedMailConfig {
  enabled: boolean
  host: string
  port: number
  secure: boolean
  username: string
  /** Plaintext password — already decrypted (if cfg) / read directly (if env). */
  password: string
}

/**
 * Resolve effective mail config by merging cfg + .env fallback. Lets
 * the user wipe Settings (reset:config) and still have mail working
 * from the .env on next launch — useful for testing the fresh-install
 * flow without re-entering IMAP credentials every time.
 *
 * Field-by-field fallback (cfg wins per-field if non-empty), plus a
 * smart `enabled`: if cfg.enabled is false but env has a complete
 * credential set, we treat mail as enabled too. The Settings UI still
 * shows cfg values only — env stays invisible to the renderer.
 */
export function resolveMailConfig(): ResolvedMailConfig {
  const cfg = getConfig().mail
  const envHost = process.env.MAIL_HOST?.trim() ?? ''
  const envPortRaw = process.env.MAIL_PORT?.trim()
  const envPort = envPortRaw ? parseInt(envPortRaw, 10) : NaN
  const envUser = process.env.MAIL_USER?.trim() ?? ''
  const envPass = process.env.MAIL_PASSWORD?.trim() ?? ''
  const envSecureRaw = process.env.MAIL_SECURE?.trim().toLowerCase()
  const envSecure = envSecureRaw === undefined ? true : envSecureRaw !== 'false'

  const host = cfg.host || envHost
  // cfg.port defaults to 993 even when user never set anything — so we
  // can't tell "user picked 993" from "user picked nothing". Use env
  // only when cfg.host is empty (i.e. user hasn't configured cfg.mail
  // at all). Same logic for `secure`.
  const cfgConfigured = !!cfg.host
  const port = cfgConfigured ? cfg.port : Number.isFinite(envPort) ? envPort : 993
  const secure = cfgConfigured ? cfg.secure : envSecure
  const username = cfg.username || envUser
  const cfgPass = cfg.passwordEncrypted ? decryptMailPassword() : cfg.password
  const password = cfgPass || envPass

  // Enabled if EITHER the user explicitly turned it on (cfg.enabled)
  // OR cfg is blank but env has full creds. The env-only path is the
  // post-reset "fallback still works" use case.
  const hasFullEnvCreds = !!envHost && !!envUser && !!envPass
  const enabled = cfg.enabled || (!cfgConfigured && hasFullEnvCreds)

  return { enabled, host, port, secure, username, password }
}

/** Convenience for chat/run.ts gating: returns true if mail tools
 *  should be exposed to the model. Includes the FAKE_MODE override. */
export function isMailEnabled(): boolean {
  if (process.env.OPENMEIDO_FAKE_MAIL === '1') return true
  return resolveMailConfig().enabled
}

function isConfigured(resolved: ResolvedMailConfig): boolean {
  return resolved.enabled && !!resolved.host && !!resolved.username && !!resolved.password
}

/** When set, mail-host uses a hardcoded in-memory adapter with synthetic
 *  reply chains instead of dialing real IMAP. For testing email-with-context
 *  flows on inboxes that don't have suitable threads. Set via:
 *    $env:OPENMEIDO_FAKE_MAIL = '1'  (PowerShell)
 *    OPENMEIDO_FAKE_MAIL=1           (POSIX)
 *  before launching the app, or use `npm run dev:fake-mail`. */
const FAKE_MODE = process.env.OPENMEIDO_FAKE_MAIL === '1'

/** Lazy getter — returns null when mail isn't fully configured. */
export function getMailService(): MailService | null {
  // Fake mode bypasses real config entirely — we don't need IMAP credentials,
  // and we don't need the user to flip mail.enabled. chat.ts mirrors the same
  // env-var check so the mail tools get exposed to the model.
  if (FAKE_MODE) {
    if (!service) {
      adapter = createFakeMailAdapter()
      service = createMailService(adapter)
      configuredHash = 'fake'
    }
    return service
  }

  const resolved = resolveMailConfig()
  if (!isConfigured(resolved)) return null

  const hash = mailHash(resolved)
  if (hash !== configuredHash || !service) {
    void teardown()
    adapter = createImapAdapter({
      host: resolved.host,
      port: resolved.port,
      secure: resolved.secure,
      user: resolved.username,
      pass: resolved.password,
    })
    service = createMailService(adapter)
    configuredHash = hash
  }
  return service
}

async function teardown(): Promise<void> {
  if (adapter) {
    try {
      await adapter.close()
    } catch {
      /* ignore */
    }
    adapter = null
    service = null
  }
}

// Rebuild on any config change so the next mail call uses fresh credentials.
// Hashes the RESOLVED config (cfg + env fallback), not cfg.mail directly —
// otherwise edits that touch only the resolved env-fallback side would
// not invalidate the cache.
onConfigChange(() => {
  const hash = mailHash(resolveMailConfig())
  if (hash !== configuredHash) {
    void teardown()
    configuredHash = ''
  }
})

/**
 * One-shot connectivity probe using arbitrary credentials, NOT the cached
 * adapter. Used by the Settings "Test Connection" button.
 *
 * `passwordPlaintext`, if provided, takes precedence over the cfg.password
 * field — Settings sends it when the user has typed a new password they
 * haven't saved yet. If omitted, we decrypt the stored ciphertext.
 */
export async function testMailConfig(
  cfg: Config['mail'],
  passwordPlaintext?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const pass = passwordPlaintext ?? (cfg.passwordEncrypted ? decryptMailPassword() : cfg.password)
  if (!cfg.host || !cfg.username || !pass) {
    return { ok: false, error: 'host / username / password 必填' }
  }
  const probe = createImapAdapter({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    user: cfg.username,
    pass,
  })
  try {
    return await probe.testConnection()
  } finally {
    await probe.close()
  }
}
