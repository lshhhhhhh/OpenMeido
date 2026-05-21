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
import { embedLocal, LOCAL_EMBED_DIM, preloadLocalEmbed, findBundledModel } from './local-embed.js'
import { runExtraction } from './chat-host.js'

let adapter: MemoryAdapter | null = null
let service: MemoryService | null = null
let initError: string | null = null

/**
 * "Naive mode" = the embed model isn't on disk yet so semantic recall (L2)
 * is unavailable. We still persist + replay episodes (L1) and L3 facts
 * work normally. The user sees a banner nudging them to download.
 *
 * Stays true until either (a) findBundledModel finds the files OR (b) the
 * user-initiated download completes and we re-poll. The flag is read by
 * MemoryService at every operation, so a flip-to-false takes effect on
 * the next chat turn without re-init.
 */
let naiveMode = true

/** Read by service.isNaiveMode() per-call. Exported for the renderer
 *  status pill / banner via IPC. */
export function isNaiveMemoryMode(): boolean {
  return naiveMode
}

/** Called by the download host after the model lands on disk. */
export function exitNaiveMemoryMode(): void {
  if (naiveMode) {
    naiveMode = false
    console.log('[memory] exiting naive mode — model is now available')
    // Warm the model so the next turn doesn't pay cold-start.
    preloadLocalEmbed()
  }
}

/** Init once at app whenReady. No-op if already up. */
export async function initMemory(): Promise<void> {
  if (service || initError) return
  const cfg = getConfig()
  if (!cfg.memory.enabled) return

  try {
    // dim is locked to bge-small-zh-v1.5's native 512. The adapter handles
    // migration if an older 1536-dim schema is on disk.
    //
    // The active-persona arg is used ONLY by the schema migration to
    // backfill persona_id on existing rows for upgrading users. Day-to-day
    // queries take persona as a method arg, so a persona switch after
    // boot takes effect immediately without re-opening the adapter.
    adapter = openSqliteMemory(app.getPath('userData'), LOCAL_EMBED_DIM, cfg.persona.preset)
    // L3 reflection uses the same LLM backend the user already configured
    // for chat. Wrap the chat-host extraction helper as a ReflectionExtractor
    // so the memory service stays platform-agnostic.
    const reflectExtractor: ReflectionExtractor = async (prompt) => runExtraction(prompt)

    // Resume the most-recently-active session for the current persona so
    // chat history carries across app restarts. Skip the synthetic 'legacy'
    // bucket — that's for old rows with NULL session_id, not a real session
    // to write new turns into.
    const recent = await adapter.listSessions(cfg.persona.preset)
    const resumeId = recent.find((s) => s.id !== 'legacy')?.id

    // Decide initial mode based on whether the model is reachable on disk.
    const bundled = findBundledModel()
    naiveMode = !bundled

    service = createMemoryService({
      adapter,
      getConfig,
      embed: embedLocal,
      reflectExtractor,
      initialSessionId: resumeId,
      isNaiveMode: () => naiveMode,
      onError: (operation, message) => {
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
    if (naiveMode) {
      console.log(
        `[memory] ready in NAIVE mode (no embed model on disk) — ` +
          `L1 recall + L3 facts work; L2 semantic recall disabled until ` +
          `user downloads the model${
            resumeId ? ` · resumed session ${resumeId.slice(0, 8)}…` : ' · new session'
          }`,
      )
      // Try the remote fallback in the background — transformers.js will
      // pull from huggingface.co / hf-mirror.com. If that succeeds, exit
      // naive mode automatically so users on networks that CAN reach HF
      // don't keep seeing the "model not installed" banner forever.
      // Reachability failures (offline, GFW without mirror) leave
      // naive mode on, which is the intended behavior.
      void import('./local-embed.js').then(async (m) => {
        try {
          // getExtractor would auto-fallback to remote; we just call embedLocal
          // once with a trivial input to trigger that path.
          await m.embedLocal('warmup')
          if (naiveMode) {
            naiveMode = false
            console.log('[memory] remote embed reachable — exiting naive mode')
          }
        } catch (err) {
          console.warn('[memory] remote embed unreachable, staying naive:', err)
        }
      })
    } else {
      console.log(
        `[memory] ready (sqlite, local bge-small-zh, dim=${LOCAL_EMBED_DIM})${
          resumeId ? ` · resumed session ${resumeId.slice(0, 8)}…` : ' · new session'
        }`,
      )
      // Warm the ONNX model in the background so the first user turn doesn't
      // pay the ~1-2s cold-start.
      preloadLocalEmbed()
    }
  } catch (err) {
    initError = err instanceof Error ? err.message : String(err)
    console.error('[memory] init failed — running without memory:', err)
  }
}

export function getMemoryService(): MemoryService | null {
  return service
}

export function getMemoryAdapter(): MemoryAdapter | null {
  return adapter
}

export function getMemoryInitError(): string | null {
  return initError
}
