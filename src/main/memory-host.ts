/**
 * Memory host — Electron-specific assembly of the core MemoryService.
 *
 * Picks the sqlite adapter (Node-native) and wires it up with the
 * Electron-resolved data dir + config accessor + .env-aware key resolver.
 *
 * Other platforms (PWA, Capacitor) ship their own host that wires the
 * same core service to a different adapter.
 */

import { app, BrowserWindow } from 'electron'

import { createMemoryService, type MemoryService } from '../core/memory/service.js'
import { openSqliteMemory } from './storage/sqlite-memory-adapter.js'
import type { MemoryAdapter } from '../core/memory/adapter.js'
import { getConfig, resolveApiKey, onConfigChange } from './config.js'

let adapter: MemoryAdapter | null = null
let service: MemoryService | null = null
let initError: string | null = null

/** Init once at app whenReady. No-op if already up. */
export function initMemory(): void {
  if (service || initError) return
  const cfg = getConfig()
  if (!cfg.memory.enabled) return

  try {
    adapter = openSqliteMemory(app.getPath('userData'), cfg.embedding.dim)
    service = createMemoryService({
      adapter,
      getConfig,
      resolveApiKey: () => resolveApiKey(),
      onError: (operation, message) => {
        // Broadcast so renderer windows can surface a toast / status pill.
        // Silently failing writes are the worst class of memory bug, so we
        // make sure the user can see when it happens.
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('memory:error', {
              operation,
              message,
              ts: Date.now(),
            })
          }
        }
      },
    })
    console.log('[memory] ready (sqlite, dim=' + cfg.embedding.dim + ')')
  } catch (err) {
    initError = err instanceof Error ? err.message : String(err)
    console.error('[memory] init failed — running without memory:', err)
  }

  // Warn if the embedding dim later changes — the vec table is locked to
  // whatever dim the first init used.
  onConfigChange((next) => {
    if (adapter && next.embedding.dim !== cfg.embedding.dim) {
      console.warn(
        `[memory] embedding.dim changed (${cfg.embedding.dim} -> ${next.embedding.dim}). ` +
          'Existing vectors mismatch the new dim; delete memory.sqlite to recreate.',
      )
    }
  })
}

export function getMemoryService(): MemoryService | null {
  return service
}

export function getMemoryInitError(): string | null {
  return initError
}
