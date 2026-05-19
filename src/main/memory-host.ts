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
import type { ReflectionExtractor } from '../core/memory/reflection.js'
import { getConfig } from './config.js'
import { embedLocal, LOCAL_EMBED_DIM, preloadLocalEmbed } from './local-embed.js'
import { runExtraction } from './chat-host.js'

let adapter: MemoryAdapter | null = null
let service: MemoryService | null = null
let initError: string | null = null

/** Init once at app whenReady. No-op if already up. */
export async function initMemory(): Promise<void> {
  if (service || initError) return
  const cfg = getConfig()
  if (!cfg.memory.enabled) return

  try {
    // dim is locked to bge-small-zh-v1.5's native 512. The adapter handles
    // migration if an older 1536-dim schema is on disk.
    adapter = openSqliteMemory(app.getPath('userData'), LOCAL_EMBED_DIM)
    // L3 reflection uses the same LLM backend the user already configured
    // for chat. Wrap the chat-host extraction helper as a ReflectionExtractor
    // so the memory service stays platform-agnostic.
    const reflectExtractor: ReflectionExtractor = async (prompt) => runExtraction(prompt)

    // Resume the most-recently-active session so chat history carries across
    // app restarts. Skip the synthetic 'legacy' bucket — that's for old rows
    // with NULL session_id, not a real session to write new turns into.
    // better-sqlite3 is synchronous, so awaiting here costs ~1ms.
    const recent = await adapter.listSessions()
    const resumeId = recent.find((s) => s.id !== 'legacy')?.id

    service = createMemoryService({
      adapter,
      getConfig,
      embed: embedLocal,
      reflectExtractor,
      initialSessionId: resumeId,
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
    console.log(
      `[memory] ready (sqlite, local bge-small-zh, dim=${LOCAL_EMBED_DIM})${
        resumeId ? ` · resumed session ${resumeId.slice(0, 8)}…` : ' · new session'
      }`,
    )
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
