/**
 * Custom background image host.
 *
 * Two responsibilities:
 *   1. File picker + copy: when the user clicks "导入图片" in Settings,
 *      open a native picker, copy the chosen file into
 *      `<userData>/custom-backgrounds/<personaId>-<timestamp><ext>` so
 *      it survives the picker context being closed, and return the
 *      basename for the renderer to write into config.
 *   2. Protocol handler: the renderer references custom files via
 *      `meido-bg://custom/<basename>`. We resolve those reads back to
 *      the on-disk copy under userData. Same pattern as live2d-models —
 *      keeps file:// out of the renderer (which Chromium increasingly
 *      restricts in privileged contexts) AND lets us scope where the
 *      renderer can read from.
 *
 * Why copy rather than reference the user's chosen path directly: the
 * user might delete / move / rename the source after import. Copying
 * once locks in the asset so OpenMeido keeps working.
 */

import { app, dialog, protocol } from 'electron'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { join, extname, basename, resolve } from 'node:path'
import { Readable } from 'node:stream'

/** Directory where copied custom-background files live. */
function customBackgroundsDir(): string {
  return join(app.getPath('userData'), 'custom-backgrounds')
}

/**
 * Pick a file via native dialog and copy it under userData. Returns the
 * basename to store in config, or null if the user cancelled.
 */
export async function importCustomBackground(
  personaId: string,
): Promise<{ basename: string } | null> {
  const result = await dialog.showOpenDialog({
    title: '选择背景图片',
    properties: ['openFile'],
    filters: [
      { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
    ],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const src = result.filePaths[0]!
  const ext = extname(src).toLowerCase() || '.png'
  const dir = customBackgroundsDir()
  await mkdir(dir, { recursive: true })
  // Filename: <personaId>-<timestamp><ext> so multiple imports under the
  // same persona get distinct files (lets the user "redo" without
  // overwriting; old files orphan until manually cleaned, which is
  // cheap since they live under userData and are tiny relative to the
  // bge model already there).
  const out = `${sanitizeId(personaId)}-${Date.now()}${ext}`
  const dst = join(dir, out)
  await copyFile(src, dst)
  return { basename: out }
}

/** Strip anything that could create path-traversal risk from a persona id. */
function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32)
}

/**
 * Register the `meido-bg://` privileged scheme. Must run before app.whenReady
 * (alongside meido-live2d). Renderer URLs look like:
 *   meido-bg://custom/<basename>
 * The host part is always `custom` (room for future built-in subschemes).
 */
export function registerBackgroundScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'meido-bg',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: true,
        corsEnabled: true,
      },
    },
  ])
}

/** Wire the actual file-read handler. Call after app.whenReady. */
export function registerBackgroundProtocol(): void {
  protocol.handle('meido-bg', async (req) => {
    const url = new URL(req.url)
    // host = 'custom'; path = '/<basename>'
    const slug = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    if (!slug) return new Response('Not Found', { status: 404 })
    const dir = customBackgroundsDir()
    // Resolve under the custom-backgrounds dir and verify the resolved
    // path is still WITHIN it — guards against ../ traversal even though
    // the renderer is trusted.
    const resolved = resolve(dir, slug)
    if (!resolved.startsWith(resolve(dir) + (process.platform === 'win32' ? '\\' : '/'))) {
      return new Response('Forbidden', { status: 403 })
    }
    try {
      const info = await stat(resolved)
      if (!info.isFile()) return new Response('Not a file', { status: 404 })
      const nodeStream = createReadStream(resolved)
      const webStream = Readable.toWeb(nodeStream) as ReadableStream
      return new Response(webStream, {
        status: 200,
        headers: {
          'content-type': contentTypeFor(resolved),
          'content-length': String(info.size),
          'access-control-allow-origin': '*',
          'cache-control': 'public, max-age=86400',
        },
      })
    } catch {
      return new Response('Not Found', {
        status: 404,
        headers: { 'access-control-allow-origin': '*' },
      })
    }
  })
}

function contentTypeFor(path: string): string {
  const ext = extname(path).toLowerCase()
  switch (ext) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    default:
      return 'application/octet-stream'
  }
}

/** Used by Settings to remove the file on disk when the user clears
 *  the custom background. Best-effort — silent on missing file. */
export async function deleteCustomBackground(name: string): Promise<void> {
  if (!name) return
  const dir = customBackgroundsDir()
  const resolved = resolve(dir, basename(name))
  try {
    const { unlink } = await import('node:fs/promises')
    await unlink(resolved)
  } catch {
    /* file already gone or never existed; ignore */
  }
}
