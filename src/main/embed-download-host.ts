/**
 * Embed-model download host. Fetches the bge-small-zh-v1.5 ONNX bundle
 * into <userData>/hf-cache so the next chat turn can load it and exit
 * naive memory mode.
 *
 * Triggered from the renderer (Settings → 记忆 → "下载嵌入模型").
 * Broadcasts byte-count progress on every chunk so a progress bar can
 * follow along. After the last file lands, calls exitNaiveMemoryMode()
 * so the running session upgrades without a restart.
 *
 * Hosts are tried in order: huggingface.co first (faster when accessible),
 * hf-mirror.com next (works inside the GFW). If both fail we surface a
 * clear error to the user.
 *
 * Crash / network safety: each file streams into `<file>.part` and is
 * renamed onto its final path only after its size matches Content-Length,
 * so the final path only ever holds a complete file — findBundledModel
 * (and the isNaiveMemoryMode self-heal that polls it) can't mistake a
 * half-written model for an installed one. A stall watchdog aborts a
 * connection that stops delivering bytes (the usual GFW failure mode is
 * a silent hang, not an error), so `inProgress` can't get stuck.
 */

import { app, BrowserWindow } from 'electron'
import { createWriteStream, mkdirSync, renameSync, rmSync, statSync, type WriteStream } from 'node:fs'
import { join, dirname } from 'node:path'
import { once } from 'node:events'
import { finished } from 'node:stream/promises'

import {
  LOCAL_EMBED_MODEL,
  LOCAL_EMBED_FILES,
  embedFileComplete,
  findBundledModel,
  writeVerifiedManifest,
  type LocalEmbedFile,
} from './local-embed.js'
import { exitNaiveMemoryMode } from './memory-host.js'

// NOTE: `main` is a moving ref. No commit sha is recorded anywhere in the
// repo, so we don't pin one blind. If upstream ever re-exports the model,
// the Content-Length check + verified manifest keep a fresh download
// self-consistent; LOCAL_EMBED_ONNX_BYTES only covers the current file.
// To pin: swap `main` for the sha here (on-disk layout is unaffected —
// local-embed loads from localModelPath, which has no revision in it).
const REPO_PATH = `${LOCAL_EMBED_MODEL}/resolve/main`
const FILES = LOCAL_EMBED_FILES

const HOSTS = ['https://huggingface.co', 'https://hf-mirror.com'] as const

/** Abort a file if no bytes arrive (incl. waiting for headers) for this long. */
const STALL_TIMEOUT_MS = 60_000
/** Hard ceiling for the whole run — only guards against a trickle that
 *  keeps resetting the stall timer. ~95MB at 20KB/s still fits. */
const OVERALL_TIMEOUT_MS = 90 * 60_000

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

interface DownloadState {
  inProgress: boolean
  /** Total bytes expected across all files. Estimated from Content-Length
   *  of each in-flight file. Updated as headers arrive. */
  totalBytes: number
  /** Bytes downloaded so far across all files. */
  receivedBytes: number
  /** Current file being downloaded ('onnx/model.onnx' etc.) — for the UI. */
  currentFile: string | null
}

const state: DownloadState = {
  inProgress: false,
  totalBytes: 0,
  receivedBytes: 0,
  currentFile: null,
}

/** Where the downloaded files land. local-embed.findBundledModel checks
 *  this path among its candidates so the model loads from here after
 *  download. */
function downloadDir(): string {
  return join(app.getPath('userData'), 'hf-cache')
}

function modelDir(): string {
  return join(downloadDir(), LOCAL_EMBED_MODEL)
}

/** Remove leftover `.part` files (crash / kill mid-download in a prior
 *  session). Only called while no download is running — we're the only
 *  writer of `.part`, so nothing live gets deleted. */
function cleanupStaleParts(): void {
  for (const f of FILES) {
    try {
      rmSync(`${join(modelDir(), f.path)}.part`, { force: true })
    } catch (err) {
      console.warn(`[embed-download] couldn't remove stale ${f.path}.part:`, err)
    }
  }
}

/** Close a write stream and wait for its fd to be released, so the
 *  `.part` can be deleted / re-created right after (Windows refuses to
 *  reopen a path that's still pending delete). */
function closeStream(out: WriteStream): Promise<void> {
  if (out.closed) return Promise.resolve()
  return new Promise((resolve) => {
    out.once('close', () => resolve())
    out.destroy()
  })
}

/**
 * Download one file into `<dest>.part`, verify, then rename onto `dest`.
 * Returns the verified byte size. Throws (with the `.part` removed and
 * this file's progress rolled back) on HTTP error, stall, size mismatch,
 * or when `runSignal` aborts.
 */
async function fetchFileWithProgress(
  host: string,
  file: LocalEmbedFile,
  runSignal: AbortSignal,
): Promise<number> {
  const url = `${host}/${REPO_PATH}/${file.path}`
  const dest = join(modelDir(), file.path)
  const part = `${dest}.part`
  mkdirSync(dirname(dest), { recursive: true })
  state.currentFile = file.path

  // Per-file controller: fired by the stall watchdog, or forwarded from
  // the run-level signal (overall timeout).
  const ctrl = new AbortController()
  const onRunAbort = (): void => ctrl.abort(runSignal.reason)
  if (runSignal.aborted) onRunAbort()
  else runSignal.addEventListener('abort', onRunAbort, { once: true })
  let stallTimer: ReturnType<typeof setTimeout> | null = null
  const armStall = (): void => {
    if (stallTimer) clearTimeout(stallTimer)
    stallTimer = setTimeout(
      () =>
        ctrl.abort(
          new Error(`${file.path}: ${STALL_TIMEOUT_MS / 1000}s 内没有收到数据，连接可能被阻断`),
        ),
      STALL_TIMEOUT_MS,
    )
  }

  let fileTotal = 0
  let fileReceived = 0
  let out: WriteStream | null = null
  try {
    armStall()
    const res = await fetch(url, {
      // identity: Content-Length must describe the bytes we write, which
      // it doesn't once fetch transparently gunzips the body.
      headers: { 'User-Agent': 'openmeido-app/0.0.14', 'Accept-Encoding': 'identity' },
      signal: ctrl.signal,
    })
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`)
    }
    const encoding = (res.headers.get('content-encoding') ?? 'identity').toLowerCase()
    const contentLength =
      encoding === 'identity' ? Number(res.headers.get('content-length') ?? '0') || 0 : 0
    if (contentLength > 0) {
      fileTotal = contentLength
      state.totalBytes += contentLength
      broadcast('embed:downloadProgress', { ...state })
    }
    // Stream the body so we can emit progress as bytes flow in.
    const reader = res.body.getReader()
    const stream = createWriteStream(part) // truncates any stale .part
    out = stream
    // Surface disk errors even when we're not currently waiting on drain.
    let writeErr: unknown = null
    stream.on('error', (err) => {
      writeErr = err
      ctrl.abort(err)
    })
    while (true) {
      armStall()
      const { done, value } = await reader.read()
      if (done) break
      if (writeErr) throw writeErr
      if (value) {
        if (!stream.write(value)) await once(stream, 'drain', { signal: ctrl.signal })
        fileReceived += value.byteLength
        state.receivedBytes += value.byteLength
        broadcast('embed:downloadProgress', { ...state })
      }
    }
    if (stallTimer) clearTimeout(stallTimer)
    stream.end()
    await finished(stream)
    const size = statSync(part).size
    if (contentLength > 0 && size !== contentLength) {
      throw new Error(`${file.path} 下载不完整 (got ${size}, want ${contentLength})`)
    }
    if (size < file.minBytes) {
      throw new Error(`${file.path} downloaded but is short (got ${size}, want ≥ ${file.minBytes})`)
    }
    try {
      renameSync(part, dest)
    } catch (err) {
      // Windows refuses to replace a file another handle has open. If a
      // concurrent writer (transformers.js's naive-mode warmup uses the
      // same cache dir) already put a complete copy there, take it.
      if (!embedFileComplete(modelDir(), file)) throw err
      rmSync(part, { force: true })
      return statSync(dest).size
    }
    return size
  } catch (err) {
    // An abort surfaces as a generic AbortError; the reason we passed
    // (stall / overall timeout / disk error) is the useful message.
    // Read it before the teardown abort below, which would otherwise make
    // every failure look like an abort.
    const abortReason: unknown = ctrl.signal.aborted ? ctrl.signal.reason : null
    // Tear down the connection on every failure path (HTTP error with an
    // unread body, short file, rename failure …), not just on stalls.
    ctrl.abort()
    // Roll back this file's contribution so the next host's retry
    // doesn't push the bar past 100%.
    state.receivedBytes -= fileReceived
    state.totalBytes -= fileTotal
    if (out) await closeStream(out)
    try {
      rmSync(part, { force: true })
    } catch {
      /* best effort — cleanupStaleParts retries next run */
    }
    throw abortReason instanceof Error ? abortReason : err
  } finally {
    if (stallTimer) clearTimeout(stallTimer)
    runSignal.removeEventListener('abort', onRunAbort)
  }
}

/** Public entry point — fire and follow the broadcasts in the renderer. */
async function runDownload(): Promise<{ ok: true } | { ok: false; error: string }> {
  if (state.inProgress) {
    return { ok: false, error: '已经在下载中' }
  }
  cleanupStaleParts()
  // findBundledModel validates sizes (not just existence), so a truncated
  // model.onnx left by an older build falls through to the download
  // below and gets replaced instead of short-circuiting here forever.
  if (findBundledModel()) {
    // From the user's POV "model already on disk" is success, not an
    // error. Without this broadcast the renderer's banner (which only
    // hides on a complete-with-ok event) would stay stuck saying
    // "暂未启用长期记忆" forever even though Settings shows the model
    // installed. The exitNaiveMemoryMode is also defensive — if the
    // model arrived via transformers.js's silent remote warmup, main's
    // naiveMode flag may already be false, but calling again is a
    // cheap no-op.
    exitNaiveMemoryMode()
    broadcast('embed:downloadComplete', { ok: true })
    return { ok: true }
  }
  state.inProgress = true
  state.totalBytes = 0
  state.receivedBytes = 0
  state.currentFile = null
  broadcast('embed:downloadProgress', { ...state })

  const runCtrl = new AbortController()
  const overallTimer = setTimeout(
    () => runCtrl.abort(new Error(`下载超时（超过 ${OVERALL_TIMEOUT_MS / 60_000} 分钟）`)),
    OVERALL_TIMEOUT_MS,
  )
  // try/finally so every exit path — success, all hosts failed, or an
  // unexpected throw — clears inProgress. A stuck flag used to lock the
  // download button until restart.
  try {
    let lastErr: unknown = null
    for (const host of HOSTS) {
      try {
        // Recomputed per host (resume support): files that already landed
        // complete — earlier run or the previous host — aren't refetched.
        const todo = FILES.filter((f) => !embedFileComplete(modelDir(), f))
        const verified: Record<string, number> = {}
        for (const f of todo) verified[f.path] = await fetchFileWithProgress(host, f, runCtrl.signal)
        if (Object.keys(verified).length > 0) writeVerifiedManifest(modelDir(), verified)
        if (!findBundledModel()) {
          throw new Error('模型文件已下载，但校验未通过')
        }
        broadcast('embed:downloadComplete', { ok: true })
        exitNaiveMemoryMode()
        return { ok: true }
      } catch (err) {
        lastErr = err
        console.warn(
          `[embed-download] ${host} failed: ${err instanceof Error ? err.message : err}`,
        )
        // Overall timeout: don't start over on the next host.
        if (runCtrl.signal.aborted) break
        // Otherwise try the next host. The failed file's .part is already
        // gone; completed files stay (resume).
      }
    }
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'unknown')
    broadcast('embed:downloadComplete', { ok: false, error: msg })
    return { ok: false, error: msg }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[embed-download] unexpected failure:', err)
    broadcast('embed:downloadComplete', { ok: false, error: msg })
    return { ok: false, error: msg }
  } finally {
    clearTimeout(overallTimer)
    state.inProgress = false
    state.currentFile = null
  }
}

/** State accessor for renderer IPC. */
export function getDownloadState(): DownloadState & { modelPresent: boolean } {
  return { ...state, modelPresent: !!findBundledModel() }
}

/** Triggered by renderer "下载" button. Returns when done (success or fail);
 *  the renderer can either await or just watch broadcasts. */
export function startEmbedDownload(): Promise<{ ok: true } | { ok: false; error: string }> {
  return runDownload()
}
