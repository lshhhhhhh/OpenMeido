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
 *  status pill / banner via IPC.
 *
 *  Self-healing: when the in-memory flag says "naive" but findBundledModel
 *  finds the files on disk, the two states have diverged (e.g. the
 *  background warmup downloaded the model but its post-download flip
 *  failed, OR the user copied files manually, OR a prior session's
 *  partial download finished offline). In that case the Settings panel
 *  shows "已就绪" while the App banner still nags to download — a real
 *  bug users hit. Calling exitNaiveMemoryMode() here flips the flag,
 *  broadcasts the change, and fires the naive-exit hooks (including
 *  the persona-lore auto-reseed). Subsequent reads return false. */
export function isNaiveMemoryMode(): boolean {
  if (naiveMode && findBundledModel()) {
    console.log('[memory] isNaiveMemoryMode self-heal: model is on disk, exiting naive mode')
    exitNaiveMemoryMode()
  }
  return naiveMode
}

// Hooks that fire when the embed model becomes available. Used by
// persona-lore-host to auto-reseed lore episodes that were silently
// skipped during naive-mode seeding (anchor facts persist OK without
// embeddings, but lore episodes need a vec entry to be RAG-retrievable).
const naiveExitCallbacks: Array<() => void> = []

/** Register a callback that fires once when the embed model becomes
 *  available. Safe to call before initMemory(). */
export function onNaiveModeExit(cb: () => void): void {
  naiveExitCallbacks.push(cb)
}

/** Called by the download host after the model lands on disk. */
export function exitNaiveMemoryMode(): void {
  if (naiveMode) {
    naiveMode = false
    console.log('[memory] exiting naive mode — model is now available')
    // Warm the model so the next turn doesn't pay cold-start.
    preloadLocalEmbed()
    for (const cb of naiveExitCallbacks) {
      try {
        cb()
      } catch (err) {
        console.warn('[memory] naive-exit callback failed:', err)
      }
    }
    // Tell the renderer so any naive-mode banner can hide. Without this
    // broadcast, paths that flip naiveMode internally (e.g. the
    // isNaiveMemoryMode self-heal, the post-reset short-circuit) would
    // leave App.tsx's cached `naiveMode` state at its boot value forever.
    // Settings reads modelPresent directly from the IPC, so it already
    // shows the correct state — only the App banner needs this push.
    // We re-use the existing embed:downloadComplete channel; App.tsx and
    // Settings both subscribe and react to {ok: true} the same way they
    // do for a real download finish, so this is a free reuse.
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) {
        w.webContents.send('embed:downloadComplete', { ok: true })
      }
    }
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
      const justReset = process.argv.some(
        (a) =>
          a === '--reset-all' ||
          a === '--reset-config' ||
          a === '--reset-memory',
      )
      console.log(
        `[memory] ready in NAIVE mode (no embed model on disk) — ` +
          `L1 recall + L3 facts work; L2 semantic recall disabled until ` +
          `user downloads the model${
            resumeId ? ` · resumed session ${resumeId.slice(0, 8)}…` : ' · new session'
          }${justReset ? ' · post-reset, skipping silent warmup' : ''}`,
      )
      // Try the remote fallback in the background — transformers.js pulls
      // ~95MB from huggingface.co / hf-mirror.com. If that succeeds, exit
      // naive mode + broadcast to renderer so banner hides without a
      // restart. Reachability failures (offline, GFW without mirror)
      // leave naive mode on, which is the intended behavior.
      //
      // Skip the warmup when --reset-* was on argv. Otherwise a user
      // who clicked 全部清空 expecting a true clean slate would see the
      // model auto-redownload within seconds, defeating the purpose of
      // the reset (and making the cold-start demo flow untestable).
      // Same pattern as the affinity dev-override skip-on-reset.
      if (!justReset) {
        void import('./local-embed.js').then(async (m) => {
          try {
            // getExtractor would auto-fallback to remote; we just call embedLocal
            // once with a trivial input to trigger that path.
            await m.embedLocal('warmup')
            if (naiveMode) {
              naiveMode = false
              console.log('[memory] remote embed reachable — exiting naive mode')
              // Tell the renderer so the chat-panel banner can hide and
              // the Settings panel can refresh. We re-use the existing
              // embed:downloadComplete channel — the App.tsx + Settings
              // subscriptions both already listen and update state on
              // {ok: true}.
              for (const w of BrowserWindow.getAllWindows()) {
                if (!w.isDestroyed()) {
                  w.webContents.send('embed:downloadComplete', { ok: true })
                }
              }
            }
          } catch (err) {
            console.warn('[memory] remote embed unreachable, staying naive:', err)
          }
        })
      }
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
