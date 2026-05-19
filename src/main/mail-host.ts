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
function mailHash(cfg: Config['mail']): string {
  return [cfg.enabled, cfg.host, cfg.port, cfg.secure, cfg.username, cfg.password].join('|')
}

function isConfigured(cfg: Config['mail']): boolean {
  return cfg.enabled && !!cfg.host && !!cfg.username && !!cfg.password
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

  const cfg = getConfig().mail
  if (!isConfigured(cfg)) return null

  const hash = mailHash(cfg)
  if (hash !== configuredHash || !service) {
    void teardown()
    adapter = createImapAdapter({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      user: cfg.username,
      pass: decryptMailPassword(),
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
onConfigChange((next) => {
  const hash = mailHash(next.mail)
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
