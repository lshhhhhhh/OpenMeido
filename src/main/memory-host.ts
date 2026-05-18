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
import { getConfig } from './config.js'
import { embedLocal, LOCAL_EMBED_DIM, preloadLocalEmbed } from './local-embed.js'

let adapter: MemoryAdapter | null = null
let service: MemoryService | null = null
let initError: string | null = null

/** Init once at app whenReady. No-op if already up. */
export function initMemory(): void {
  if (service || initError) return
  const cfg = getConfig()
  if (!cfg.memory.enabled) return

  try {
    // dim is locked to bge-small-zh-v1.5's native 512. The adapter handles
    // migration if an older 1536-dim schema is on disk.
    adapter = openSqliteMemory(app.getPath('userData'), LOCAL_EMBED_DIM)
    service = createMemoryService({
      adapter,
      getConfig,
      embed: embedLocal,
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
    console.log(`[memory] ready (sqlite, local bge-small-zh, dim=${LOCAL_EMBED_DIM})`)
    // Warm the ONNX model in the background so the first user turn doesn't
    // pay the ~1-2s cold-start.
    preloadLocalEmbed()
  } catch (err) {
    initError = err instanceof Error ? err.message : String(err)
    console.error('[memory] init failed — running without memory:', err)
  }
}

export function getMemoryService(): MemoryService | null {
  return service
}

export function getMemoryInitError(): string | null {
  return initError
}
