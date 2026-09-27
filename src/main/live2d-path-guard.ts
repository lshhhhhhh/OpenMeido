/**
 * Pure path-safety helpers for the Live2D model host.
 *
 * Every model name / relative file path the host touches comes from somewhere
 * untrusted: a zip entry name, the `meido-live2d://<name>/<path>` URL, or an
 * IPC argument from the renderer. These helpers are the single place that
 * decides "does this stay inside the models root?".
 *
 * Deliberately free of Electron imports so `tools/smoke-live2d-zip-guard.mjs`
 * can exercise them under plain Node.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Zip-bomb ceilings for `importZip`. Real Cubism models are a few hundred
 *  files / tens of MB — these are generous upper bounds, not targets. */
export const MAX_ZIP_ENTRIES = 5000
export const MAX_ZIP_TOTAL_BYTES = 1024 * 1024 * 1024 // 1 GB uncompressed

/**
 * Replace any character that would be unsafe in a path or URL segment.
 * We keep CJK so Chinese model names round-trip; just kill slashes / quotes /
 * control chars. Idempotent (the trailing trim runs again after the slice),
 * so `isSafeModelName(sanitizeName(x))` holds for every non-empty result.
 */
export function sanitizeName(s: string): string {
  return s
    .replace(/[\\/\u0000-\u001f"<>|:?*]/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 96)
    .replace(/[\s.]+$/g, '')
}

/**
 * A model name is safe iff it's exactly what `sanitizeName` would produce —
 * i.e. a single path segment with no separators, no NUL, not `.` / `..`.
 * Callers still check the resolved dir with `isDirectChildDir` as a second
 * line of defense.
 */
export function isSafeModelName(name: unknown): name is string {
  if (typeof name !== 'string' || name.length === 0) return false
  if (name === '.' || name === '..') return false
  if (name.includes('\0') || name.includes('/') || name.includes('\\')) return false
  return sanitizeName(name) === name
}

/** True when `child` resolves to an immediate subdirectory of `root`. */
export function isDirectChildDir(root: string, child: string): boolean {
  const rel = relative(resolve(root), resolve(child))
  return rel.length > 0 && !isAbsolute(rel) && rel !== '..' && !rel.includes(sep) && !rel.includes('/')
}

/**
 * Resolve an untrusted relative path (zip entry name, URL path, sidecar
 * `modelFile`) against `root`. Returns the absolute path, or null when it
 * could land outside `root`.
 *
 * Rejected outright rather than normalized — a legit model never needs them:
 *   - NUL bytes
 *   - absolute POSIX paths and UNC shares (`/etc`, `//host/share`)
 *   - Windows drive letters (`C:/…`, `C:foo`)
 *   - any all-dots/spaces segment other than `.` (`..`, `...`, `.. `)
 *   - `:` inside a segment (NTFS alternate data streams, `a.png:evil`)
 * Then a final resolve + relative check catches anything the above missed.
 * `root` itself (e.g. `./`) is also null — callers want a file under it.
 */
export function resolveInside(root: string, rel: string): string | null {
  if (typeof rel !== 'string' || rel.length === 0 || rel.includes('\0')) return null
  const clean = rel.replace(/\\/g, '/')
  if (clean.startsWith('/') || /^[a-zA-Z]:/.test(clean)) return null
  const segs = clean.split('/')
  if (segs.some((s) => (s !== '.' && /^[.\s]+$/.test(s)) || s.includes(':'))) return null
  const base = resolve(root)
  const out = resolve(base, clean)
  const back = relative(base, out)
  if (!back || isAbsolute(back) || back === '..' || back.startsWith('..' + sep)) return null
  return out
}

/** The slice of adm-zip's IZipEntry the planner reads — structural so the
 *  smoke test can feed plain objects as well as real entries. */
export interface ZipEntryLike {
  entryName: string
  isDirectory: boolean
  header: { size: number; compressedSize: number }
}

/**
 * Validate every entry of a model zip and map it to its output path under
 * `dst` — BEFORE anything touches disk. `stripTop` is the single top-level
 * dir to drop from each entry name (null = keep names as-is).
 *
 *   - Zip-slip: each file entry must `resolveInside(dst, …)`; otherwise a
 *     `../../Startup/x.bat` or `C:/…` entry lands wherever the user can write.
 *   - Zip bomb: entry count ≤ MAX_ZIP_ENTRIES and the sum of the DECLARED
 *     uncompressed sizes (central header, read before getData() inflates
 *     anything) ≤ MAX_ZIP_TOTAL_BYTES.
 *
 * One bad entry rejects the whole zip — it's either broken or hostile, and a
 * half-installed model is worse than none. Directory entries are skipped:
 * they're never created from the entry itself (parents get mkdir'd from each
 * validated file path), so a hostile dir entry can't do anything.
 *
 * Throws with a Chinese message — Settings shows it as `导入失败：…`.
 */
export function planZipExtraction<E extends ZipEntryLike>(
  entries: readonly E[],
  dst: string,
  stripTop: string | null,
): { entry: E; outPath: string }[] {
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new Error(`zip 里文件太多（${entries.length} 个，上限 ${MAX_ZIP_ENTRIES}），拒绝导入`)
  }
  const plan: { entry: E; outPath: string }[] = []
  let totalBytes = 0
  for (const entry of entries) {
    if (entry.isDirectory) continue
    let rel = entry.entryName.replace(/\\/g, '/')
    if (stripTop && rel.startsWith(stripTop + '/')) rel = rel.slice(stripTop.length + 1)
    if (!rel) continue
    const outPath = resolveInside(dst, rel)
    if (!outPath) throw new Error(`zip 里有不安全的路径（${entry.entryName}），拒绝导入`)
    const { size, compressedSize } = entry.header
    // adm-zip only caps inflate output when the declared size is > 0, so a
    // "0-byte" entry carrying real compressed payload could inflate without
    // bound. An honest empty file compresses to a couple of bytes.
    if (!Number.isFinite(size) || size < 0 || (size === 0 && compressedSize > 64)) {
      throw new Error(`zip 条目大小字段异常（${entry.entryName}），拒绝导入`)
    }
    totalBytes += size
    if (totalBytes > MAX_ZIP_TOTAL_BYTES) {
      throw new Error(`zip 解压后超过 ${Math.round(MAX_ZIP_TOTAL_BYTES / 1024 / 1024)} MB，拒绝导入`)
    }
    plan.push({ entry, outPath })
  }
  return plan
}
