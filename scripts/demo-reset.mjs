#!/usr/bin/env node
/**
 * Wipe the demo sandbox profile (created by `--demo` launch) so the
 * next `npm run dev:demo` starts from a true fresh-install state:
 * setup wizard, no API key, no chat history, no affinity, no facts.
 *
 * Useful between screen recordings — each demo video starts from
 * "I just installed OpenMeido for the first time".
 *
 * Does NOT touch the real `openmeido/` profile, only `openmeido-demo/`.
 * Refuses to run if the demo app is currently open (file locks would
 * leave the dir in an inconsistent state — close dev:demo first).
 */
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const appData = process.env.APPDATA || join(process.env.HOME || '', '.config')
const demoDir = join(appData, 'openmeido-demo')

if (!existsSync(demoDir)) {
  console.log(`No demo profile at ${demoDir}. Nothing to reset.`)
  process.exit(0)
}

try {
  rmSync(demoDir, { recursive: true, force: true })
  console.log(`✓ Wiped ${demoDir}`)
  console.log('Next `npm run dev:demo` will boot into the fresh-install flow (wizard, no data).')
} catch (err) {
  if (err && typeof err === 'object' && 'code' in err && err.code === 'EBUSY') {
    console.error(`✗ Demo profile is locked — close any running dev:demo / OpenMeido demo first.`)
  } else {
    console.error('✗ Failed to wipe demo profile:', err)
  }
  process.exit(1)
}
