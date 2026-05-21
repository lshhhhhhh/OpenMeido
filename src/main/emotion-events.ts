/**
 * Emotion event log — in-memory ring buffer of "she just played X face / Y
 * motion" events. The Sidebar's 最近活动 feed merges these with chat tool
 * activity so the user can see her non-verbal reactions alongside her
 * tool work.
 *
 * Why in-memory rather than persisted: the activity feed only shows recent
 * activity (~15 entries). Restarting the app legitimately wipes the feed —
 * a Live2D face from yesterday isn't actionable info. Keeping this off-disk
 * also avoids a schema migration just for a UI surface.
 *
 * Replaceable for tests via `__setPusher` — see emotion-classifier tests.
 */

import type { Emotion } from '../shared/live2d-models.js'

export interface EmotionEvent {
  ts: string
  emotion: Emotion
  /** Which sidecar branch handled this emotion. */
  kind: 'expression' | 'motion'
  /** For 'expression': the expression name. For 'motion': "<group>[<index>]". */
  target: string
}

const MAX_EVENTS = 50

const ring: EmotionEvent[] = []

function defaultPusher(e: EmotionEvent): void {
  ring.push(e)
  if (ring.length > MAX_EVENTS) ring.splice(0, ring.length - MAX_EVENTS)
}

let pusher: (e: EmotionEvent) => void = defaultPusher

export function pushEmotionEvent(e: EmotionEvent): void {
  pusher(e)
}

/** Newest first, capped at `limit`. */
export function recentEmotionEvents(limit: number = 20): EmotionEvent[] {
  return ring.slice(-limit).reverse()
}

/** Test seam — replace storage with a spy. */
export function __setPusher(fn: (e: EmotionEvent) => void): void {
  pusher = fn
}

export function __resetPusher(): void {
  pusher = defaultPusher
}

/** Test seam — wipe the ring without unloading the module. */
export function __clearEvents(): void {
  ring.length = 0
}
