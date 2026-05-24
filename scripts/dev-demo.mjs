#!/usr/bin/env node
/**
 * Launch electron-vite dev with `--demo` on argv so demo-mode.ts
 * activates: separate userData sandbox + fake mail + seeded persona
 * data. Useful for screen recording / showing the app off without
 * polluting the real install or leaking real email content.
 *
 * Cross-platform: mirrors dev-fake-mail.mjs. shell:true is needed on
 * Windows to find npx.cmd via PATH (Node 24 refuses .cmd shims
 * directly).
 */
import { spawn } from 'node:child_process'

// Pass --demo through electron-vite to the spawned Electron process.
// `--` separator tells electron-vite "everything after this goes to
// the child", matching the convention electron-vite documents.
const child = spawn('npx', ['electron-vite', 'dev', '--', '--demo'], {
  stdio: 'inherit',
  shell: true,
})
child.on('exit', (code) => process.exit(code ?? 0))
child.on('error', (err) => {
  console.error('dev-demo launcher failed:', err)
  process.exit(1)
})
