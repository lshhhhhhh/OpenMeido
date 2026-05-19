#!/usr/bin/env node
/**
 * Launch `electron-vite dev` with OPENMEIDO_FAKE_MAIL=1 so mail-host
 * uses the in-memory synthetic adapter (see src/main/mail/fake-adapter.ts)
 * instead of real IMAP. Useful when your real inbox doesn't have
 * suitable reply chains to exercise email-with-context.
 *
 * Cross-platform: this Node launcher works the same on PowerShell and
 * POSIX, avoiding a `cross-env` dependency for one variable.
 */
import { spawn } from 'node:child_process'

// shell:true so Windows can resolve npx.cmd via PATH. Node 24 tightened
// child_process and refuses to spawn .cmd shims directly (EINVAL).
const child = spawn('npx', ['electron-vite', 'dev'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, OPENMEIDO_FAKE_MAIL: '1' },
})
child.on('exit', (code) => process.exit(code ?? 0))
child.on('error', (err) => {
  console.error('dev-fake-mail launcher failed:', err)
  process.exit(1)
})
