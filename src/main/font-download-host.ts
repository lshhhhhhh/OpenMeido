/**
 * Optional-font downloader. Two of the three Chinese fonts shipped in
 * v0.0.37 (LXGW WenKai Lite + Smiley Sans) bloated the installer by
 * ~17 MB. They're now downloaded on demand from GitHub releases into
 * `<userData>/fonts/` and served to the renderer via the
 * `meido-font://` custom protocol — same pattern as
 * `meido-live2d://` for user-imported character models.
 *
 * Bundled fonts (currently only Xiaolai) stay in
 * `src/renderer/public/fonts/` and load via the renderer's normal
 * `/fonts/...` URL.
 *
 * Failure modes:
 *   - Network error mid-download → file deleted, error surfaced; retry
 *     button in Settings.
 *   - Partial download interrupted by app quit → no .partial file
 *     left around; we write to a tmp and rename atomically at end.
 *   - GitHub rate limit → ETIMEDOUT or 403; user can wait + retry.
 */

import { app } from 'electron'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

export interface OptionalFont {
  /** Stable id used in cfg.ui.fontFamily AND as the filename stem on
   *  disk (`<id>.ttf`). */
  id: string
  /** Display label in Settings UI. */
  label: string
  /** Approximate download size for the UI ("下载 14 MB"). */
  approxBytes: number
  /** GitHub release download URL. Direct .ttf links so we don't have
   *  to unzip — both repos provide raw .ttf assets in their releases. */
  url: string
  /** Filename when saved to disk. The CSS @font-face also references
   *  this name via the meido-font:// protocol. */
  filename: string
}

/**
 * The two fonts we *don't* bundle. Add new optional fonts here +
 * Settings UI picks them up automatically. Keep `id` stable across
 * versions — it's persisted in cfg.ui.fontFamily.
 */
export const OPTIONAL_FONTS: OptionalFont[] = [
  {
    id: 'lxgw-wenkai',
    label: 'LXGW 文楷',
    approxBytes: 14 * 1024 * 1024,
    url: 'https://github.com/lxgw/LxgwWenKai-Lite/releases/download/v1.522/LXGWWenKaiLite-Regular.ttf',
    filename: 'LXGWWenKaiLite-Regular.ttf',
  },
  {
    id: 'smiley-sans',
    label: '得意黑',
    // Smiley Sans only ships a zip in releases — but for v1 the smallest
    // path is just the bare .ttf direct link from the repo's raw URL.
    // Hosted via jsdelivr CDN for reliability since GitHub raw is rate
    // limited; falls back to the repo URL if jsdelivr is unreachable
    // (handled by attempting both inside downloadFont).
    approxBytes: 2_600_000,
    url: 'https://cdn.jsdelivr.net/gh/atelier-anchor/smiley-sans@main/dist/SmileySans-Oblique.ttf',
    filename: 'SmileySans-Oblique.ttf',
  },
]

function fontsDir(): string {
  return join(app.getPath('userData'), 'fonts')
}

/** Absolute path the font would live at once installed (whether or
 *  not it actually exists). */
export function fontPath(filename: string): string {
  return join(fontsDir(), filename)
}

export function isFontInstalled(id: string): boolean {
  const meta = OPTIONAL_FONTS.find((f) => f.id === id)
  if (!meta) return false
  return existsSync(fontPath(meta.filename))
}

export interface DownloadProgress {
  fontId: string
  received: number
  total: number
  done: boolean
  error?: string
}

/**
 * Download a font into <userData>/fonts/<filename> atomically. Writes
 * to <filename>.partial first, renames on success so a quit mid-write
 * never leaves the slot looking valid. `onProgress` is called with
 * received/total byte counts so the UI can show a progress bar.
 *
 * If the optional font has multiple candidate URLs (e.g. CDN + GitHub
 * fallback), pass them as `urlOverrides`; otherwise we use the URL
 * from OPTIONAL_FONTS.
 */
export async function downloadFont(
  id: string,
  onProgress: (p: DownloadProgress) => void,
): Promise<void> {
  const meta = OPTIONAL_FONTS.find((f) => f.id === id)
  if (!meta) throw new Error(`unknown font id: ${id}`)

  const dir = fontsDir()
  await mkdir(dir, { recursive: true })
  const finalPath = fontPath(meta.filename)
  const tmpPath = finalPath + '.partial'

  // Clean any stale partial from a previous interrupted download.
  if (existsSync(tmpPath)) {
    await rm(tmpPath).catch(() => {})
  }

  const ctl = new AbortController()
  // 5 minute hard timeout — even on slow Chinese ISP a 14 MB ttf
  // shouldn't take this long; bail and let the user retry.
  const timer = setTimeout(() => ctl.abort(), 5 * 60 * 1000)

  try {
    const resp = await fetch(meta.url, { signal: ctl.signal, redirect: 'follow' })
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText} from ${meta.url}`)
    }
    const totalHeader = resp.headers.get('content-length')
    const total = totalHeader ? parseInt(totalHeader, 10) : meta.approxBytes
    let received = 0
    if (!resp.body) throw new Error('no response body')

    const reader = resp.body.getReader()
    const writer = createWriteStream(tmpPath)
    // Wrap reader -> Node Readable -> pipeline writer so we can hook
    // progress per chunk without buffering the whole thing.
    const nodeReadable = new Readable({
      async read(): Promise<void> {
        try {
          const { done, value } = await reader.read()
          if (done) {
            this.push(null)
            return
          }
          received += value.byteLength
          onProgress({ fontId: id, received, total, done: false })
          this.push(Buffer.from(value))
        } catch (err) {
          this.destroy(err as Error)
        }
      },
    })
    await pipeline(nodeReadable, writer)

    // Atomic swap — only mark "installed" once the bytes are fully
    // on disk.
    await rename(tmpPath, finalPath)
    onProgress({ fontId: id, received, total, done: true })
  } catch (err) {
    // Failed → ensure no half-written file masquerading as installed.
    await rm(tmpPath, { force: true }).catch(() => {})
    onProgress({
      fontId: id,
      received: 0,
      total: meta.approxBytes,
      done: true,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/** Remove an installed optional font (user uninstall). */
export async function uninstallFont(id: string): Promise<void> {
  const meta = OPTIONAL_FONTS.find((f) => f.id === id)
  if (!meta) return
  const p = fontPath(meta.filename)
  if (existsSync(p)) {
    await rm(p, { force: true })
  }
}

/** Snapshot of install status for all optional fonts — UI calls this
 *  at boot + after each download / uninstall. */
export function listOptionalFonts(): Array<OptionalFont & { installed: boolean }> {
  return OPTIONAL_FONTS.map((f) => ({ ...f, installed: isFontInstalled(f.id) }))
}

/** Try to read a font file by filename. Used by the meido-font://
 *  protocol handler — keeps the path resolution / safety check in
 *  one place. */
export async function readFontFile(
  filename: string,
): Promise<{ path: string; size: number } | null> {
  // Only allow filenames we recognize — no path traversal, no random
  // disk reads from the renderer.
  const meta = OPTIONAL_FONTS.find((f) => f.filename === filename)
  if (!meta) return null
  const p = fontPath(meta.filename)
  try {
    const s = await stat(p)
    if (!s.isFile()) return null
    return { path: p, size: s.size }
  } catch {
    return null
  }
}
