/**
 * Screen capture — desktop-only feature using Electron's desktopCapturer.
 *
 * Returns a PNG (lossless, alpha-channel-OK) of the primary display, scaled
 * down to a sensible size for vision models. Multi-monitor: we just take
 * the first source for v1; "which screen" picker is a v2 feature.
 *
 * Mobile / PWA hosts will need a completely different impl (getDisplayMedia
 * or platform-native). We'll define a ScreenCapturer interface in core/ when
 * that day comes — for now the surface is too small to justify abstracting.
 */

import { desktopCapturer } from 'electron'

/**
 * Target thumbnail dimensions. Real captures of 4K screens shrunk to this
 * stay around 100-500 KB as PNG — comfortable for the Vercel AI SDK's
 * multimodal message format without abusing token budgets.
 */
const FULL_SIZE = { width: 1600, height: 900 }
/** Smaller preview used in the screen picker (NOT what's sent to the model). */
const PREVIEW_SIZE = { width: 240, height: 135 }

export interface ScreenInfo {
  /** Desktop-capturer source id, opaque to renderer; pass back to captureScreenPng. */
  id: string
  /** Display name from the OS — usually "Screen 1" / "屏幕 2" etc. */
  name: string
  /** Tiny base64 PNG preview for the screen picker UI. */
  previewBase64: string
}

/**
 * Enumerate available screens. Returns an empty array on systems that don't
 * permit screen capture (the call doesn't normally fail).
 */
export async function listScreens(): Promise<ScreenInfo[]> {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: PREVIEW_SIZE,
  })
  return sources.map((s) => ({
    id: s.id,
    name: s.name || s.id,
    previewBase64: s.thumbnail.toPNG().toString('base64'),
  }))
}

/**
 * Capture EVERY connected screen and return them as a list of PNG byte
 * arrays. Single-monitor users get a one-element array; multi-monitor users
 * get one image per display. We let the vision model decide which screen
 * is relevant rather than making the user pick.
 */
export async function captureAllScreensPng(
  excludedIds: readonly string[] = [],
): Promise<Uint8Array[]> {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: FULL_SIZE,
  })
  if (sources.length === 0) throw new Error('screen-host: no screens available')
  // Honor the user's exclusion list — they opted certain displays out
  // of "what the AI can see" via Settings → 主动 → 屏幕选择. Empty list
  // = capture everything (default).
  const excluded = new Set(excludedIds)
  const filtered = sources.filter((s) => !excluded.has(s.id))
  if (excludedIds.length > 0) {
    console.log(
      `[screen] excluded ${sources.length - filtered.length}/${sources.length} source(s) by user setting`,
    )
  }
  if (filtered.length === 0) {
    throw new Error(
      'screen-host: all available screens are in the user exclusion list',
    )
  }
  // Diagnostic: surface what Electron actually saw — name, id, thumbnail
  // dimensions, and whether the thumbnail is suspiciously small (a sign
  // the OS denied capture for that source).
  console.log(`[screen] captured ${filtered.length} source(s):`)
  for (const s of filtered) {
    const size = s.thumbnail.getSize()
    const isEmpty = s.thumbnail.isEmpty()
    console.log(
      `[screen]  · "${s.name}" (id=${s.id.slice(0, 24)}…) → ${size.width}×${size.height}${
        isEmpty ? ' EMPTY' : ''
      }`,
    )
  }
  // Drop empty thumbnails so we don't send a 0×0 black image to the
  // vision model (which would either silently ignore it or hallucinate
  // a description of nothing).
  const valid = filtered.filter((s) => !s.thumbnail.isEmpty())
  if (valid.length === 0) {
    throw new Error('screen-host: all screen thumbnails empty (OS denied capture?)')
  }
  if (valid.length < filtered.length) {
    console.warn(
      `[screen] dropped ${filtered.length - valid.length} empty thumbnail(s) before sending`,
    )
  }
  return valid.map((s) => {
    const buf = s.thumbnail.toPNG()
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  })
}
