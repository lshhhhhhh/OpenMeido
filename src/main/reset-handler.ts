/**
 * Reset-flags handler — wipes config / memory / both depending on argv
 * flags or a sentinel file from the previous session.
 *
 * **Why this lives in its own module**: ES modules evaluate ALL static
 * imports of a file BEFORE that file's own body runs. The wipe MUST
 * happen before `src/main/config.ts` (and similar) initialize, because
 * those modules read userData files into in-memory state at import
 * time. If we left the wipe as an IIFE inside index.ts, the imports
 * above would already have loaded the stale config into memory by the
 * time the IIFE wiped the file on disk — and subsequent setConfig()
 * calls would persist the stale data right back, defeating the reset.
 *
 * Importing this module FIRST in index.ts guarantees:
 *   reset-handler.ts body → wipes files
 *   config.ts body         → Store reads the (now missing/blank) config
 *   ...etc...
 *
 * Side effects only — no exports needed. The act of importing runs it.
 */

import { app } from 'electron'
import { existsSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv
const dir = app.getPath('userData')
console.log(`[reset] handler entry · userData=${dir} · argv=${JSON.stringify(argv)}`)

// Sentinel file fallback for dev mode. `app.relaunch + app.exit` is
// unreliable under electron-vite (the dev server doesn't always restart
// the Electron child), so the reset IPC writes a `.pending-reset` file
// containing the flag instead. On the next manual `npm run dev` we
// pick it up here, treat it as if it were an argv flag, and delete the
// sentinel after handling.
let sentinelFlag: string | null = null
try {
  const sentinelPath = join(dir, '.pending-reset')
  if (existsSync(sentinelPath)) {
    sentinelFlag = String(readFileSync(sentinelPath, 'utf8')).trim()
    rmSync(sentinelPath, { force: true })
    console.log(
      `[reset] sentinel FOUND at ${sentinelPath} · content="${sentinelFlag}" (deleted after read)`,
    )
    // Surface it on argv so downstream "did we just reset?" checks
    // (e.g. affinity-host) see it.
    if (sentinelFlag.startsWith('--reset-')) {
      process.argv.push(sentinelFlag)
      console.log(`[reset] pushed "${sentinelFlag}" onto process.argv`)
    }
  } else {
    console.log(`[reset] no sentinel at ${sentinelPath}`)
  }
} catch (err) {
  console.warn('[reset] sentinel read failed:', err)
}

const wipeAll = argv.includes('--reset-all') || sentinelFlag === '--reset-all'
const wipeConfig =
  wipeAll || argv.includes('--reset-config') || sentinelFlag === '--reset-config'
const wipeMemory =
  wipeAll || argv.includes('--reset-memory') || sentinelFlag === '--reset-memory'

function tryDelete(absPath: string): void {
  if (!existsSync(absPath)) return
  try {
    rmSync(absPath, { recursive: true, force: true })
    console.log(`[reset] removed ${absPath}`)
  } catch (err) {
    console.warn(`[reset] failed to remove ${absPath}:`, err)
  }
}

if (wipeAll || wipeConfig || wipeMemory) {
  console.log(`[reset] wiping · all=${wipeAll} config=${wipeConfig} memory=${wipeMemory}`)
  if (wipeAll) {
    // Delete every file inside userData (NOT the dir itself — Electron
    // wrote config to it during the relaunch hand-off; we can wipe
    // CONTENTS but not the dir itself reliably mid-process).
    try {
      for (const name of readdirSync(dir)) {
        tryDelete(join(dir, name))
      }
      console.log(`[reset] wiped contents of ${dir}`)
    } catch (err) {
      console.warn(`[reset] wipe-all readdir failed:`, err)
    }
  } else {
    if (wipeConfig) {
      tryDelete(join(dir, 'config.json'))
    }
    if (wipeMemory) {
      // Sqlite WAL mode produces -wal / -shm sidecar files. Kill the
      // trio so the next better-sqlite3 open() creates a truly blank db.
      tryDelete(join(dir, 'memory.sqlite'))
      tryDelete(join(dir, 'memory.sqlite-wal'))
      tryDelete(join(dir, 'memory.sqlite-shm'))
    }
  }
} else {
  console.log(`[reset] no reset triggers`)
}
