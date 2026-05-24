/**
 * Demo mode — `--demo` CLI flag flips OpenMeido into a sandbox profile.
 *
 * What it does (all at module import time, before any other code reads
 * userData):
 *
 *   1. Re-points `app.getPath('userData')` to `<original>/../openmeido-demo`.
 *      Everything that follows — electron-store config, memory.sqlite,
 *      tasks.sqlite, hf-cache, custom backgrounds — lands in this
 *      sandbox dir. Your real install is untouched, and switching
 *      between demo / real is just toggling the flag.
 *
 *   2. Forces `OPENMEIDO_FAKE_MAIL=1` so mail-host's existing fake
 *      adapter path activates. Demo emails are synthetic; nothing
 *      real ever leaks during a screen recording.
 *
 * After `app.whenReady` finishes the normal boot, demo-seed.ts runs
 * (called from index.ts) to populate a sensible default state —
 * mid-tier affinity, a few L3 facts about the "user", maybe some demo
 * tasks. That way the persona shows callbacks + acquaintance-tier
 * warmth instead of cold stranger defaults the moment you fire up
 * the demo.
 *
 * Triggering:
 *   - Dev:  npm run dev:demo
 *   - Packaged: shortcut to `OpenMeido.exe --demo`
 *
 * **CRITICAL**: this file must be imported FIRST in index.ts, before
 * reset-handler.ts and config.ts. ES module imports of THOSE eagerly
 * read userData at module-init time, so setting the path after the
 * fact wouldn't reach them.
 */

import { app } from 'electron'
import { join, dirname, basename } from 'node:path'

const isDemoFlag = process.argv.includes('--demo')

if (isDemoFlag) {
  const original = app.getPath('userData')
  // Sibling dir to the real one. basename keeps any custom suffix the
  // user may have set, then we append '-demo'. E.g.
  //   C:\Users\lsh\AppData\Roaming\openmeido
  //   → C:\Users\lsh\AppData\Roaming\openmeido-demo
  const demoDir = join(dirname(original), basename(original) + '-demo')
  app.setPath('userData', demoDir)
  // Re-use the existing OPENMEIDO_FAKE_MAIL pathway in mail-host so
  // demo emails come from src/main/mail/fake-adapter.ts. Setting it
  // here also covers the case where the user forgets to pass both
  // flag + env-var to the dev script.
  process.env.OPENMEIDO_FAKE_MAIL = '1'
  console.log(`[demo] mode active — userData → ${demoDir}`)
}

export function isDemoMode(): boolean {
  return isDemoFlag
}
