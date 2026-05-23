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
 */

import { app, BrowserWindow } from 'electron'
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'

import { LOCAL_EMBED_MODEL, findBundledModel } from './local-embed.js'
import { exitNaiveMemoryMode } from './memory-host.js'

const REPO_PATH = `${LOCAL_EMBED_MODEL}/resolve/main`
const FILES = [
  { path: 'config.json', minBytes: 100 },
  { path: 'tokenizer.json', minBytes: 100_000 },
  { path: 'tokenizer_config.json', minBytes: 100 },
  { path: 'onnx/model.onnx', minBytes: 50_000_000 },
] as const

const HOSTS = ['https://huggingface.co', 'https://hf-mirror.com'] as const

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

function fileLooksGood(absPath: string, minBytes: number): boolean {
  if (!existsSync(absPath)) return false
  try {
    return statSync(absPath).size >= minBytes
  } catch {
    return false
  }
}

async function fetchFileWithProgress(host: string, file: typeof FILES[number]): Promise<void> {
  const url = `${host}/${REPO_PATH}/${file.path}`
  const dest = join(downloadDir(), LOCAL_EMBED_MODEL, file.path)
  mkdirSync(dirname(dest), { recursive: true })
  state.currentFile = file.path
  const res = await fetch(url, {
    headers: { 'User-Agent': 'openmeido-app/0.0.14' },
  })
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`)
  }
  const contentLength = Number(res.headers.get('content-length') ?? '0')
  if (contentLength > 0) {
    state.totalBytes += contentLength
    broadcast('embed:downloadProgress', { ...state })
  }
  // Stream the body so we can emit progress as bytes flow in.
  const reader = res.body.getReader()
  const out = createWriteStream(dest)
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      out.write(Buffer.from(value))
      state.receivedBytes += value.byteLength
      broadcast('embed:downloadProgress', { ...state })
    }
  }
  out.end()
  await finished(out)
  if (!fileLooksGood(dest, file.minBytes)) {
    throw new Error(
      `${file.path} downloaded but is short (got ${statSync(dest).size}, want ≥ ${file.minBytes})`,
    )
  }
}

/** Public entry point — fire and follow the broadcasts in the renderer. */
async function runDownload(): Promise<{ ok: true } | { ok: false; error: string }> {
  if (state.inProgress) {
    return { ok: false, error: '已经在下载中' }
  }
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

  // Decide which files actually need downloading (resume support — partial
  // re-runs only fetch what's still missing).
  const todo = FILES.filter(
    (f) => !fileLooksGood(join(downloadDir(), LOCAL_EMBED_MODEL, f.path), f.minBytes),
  )
  if (todo.length === 0) {
    state.inProgress = false
    broadcast('embed:downloadComplete', { ok: true })
    exitNaiveMemoryMode()
    return { ok: true }
  }

  let lastErr: unknown = null
  for (const host of HOSTS) {
    try {
      for (const f of todo) await fetchFileWithProgress(host, f)
      state.inProgress = false
      broadcast('embed:downloadComplete', { ok: true })
      exitNaiveMemoryMode()
      return { ok: true }
    } catch (err) {
      lastErr = err
      console.warn(
        `[embed-download] ${host} failed: ${err instanceof Error ? err.message : err}`,
      )
      // Try the next host. We don't clean up partials — the next attempt
      // re-uses successfully-downloaded files (resume).
    }
  }

  state.inProgress = false
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'unknown')
  broadcast('embed:downloadComplete', { ok: false, error: msg })
  return { ok: false, error: msg }
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
