/**
 * Single-instance guard. Imported right after demo-mode.ts (the lock is
 * keyed on the userData dir, so --demo gets its own) and BEFORE
 * reset-handler.ts / anything that opens storage.
 *
 * Without it, a second launch (start-at-login + a manual double-click, or
 * the installer relaunching while an old copy lingers) ran a full second
 * app on the same data: every reminder fired twice, and on the first boot
 * after an upgrade both copies raced the same sqlite schema migrations.
 *
 * A second copy exits immediately; the first gets `second-instance` and
 * brings its window forward (wired in index.ts).
 */

import { app } from 'electron'

if (!app.requestSingleInstanceLock()) {
  console.log('[main] another OpenMeido instance is running — handing over and exiting')
  // app.exit, not app.quit: quit is async and would let the rest of the
  // module graph (reset wipe, stores, sqlite) evaluate first.
  app.exit(0)
}
