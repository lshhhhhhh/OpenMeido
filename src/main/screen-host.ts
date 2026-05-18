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
export async function captureAllScreensPng(): Promise<Uint8Array[]> {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: FULL_SIZE,
  })
  if (sources.length === 0) throw new Error('screen-host: no screens available')
  return sources.map((s) => {
    const buf = s.thumbnail.toPNG()
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  })
}
