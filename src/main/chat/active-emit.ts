/**
 * Module-scoped pointer to the active turn's emit callback. Tools defined
 * at module level don't have closure access to the `localEmit` inside
 * `runChat`, so when a tool needs to push a side-channel event to the
 * renderer (e.g. the email-draft card from `draftEmailReply`), it reads
 * this. Cleared in `runChat`'s finally so a closed turn never leaks into
 * the next.
 */
import type { ChatEventBody } from '../../shared/ipc.js'

let active: ((body: ChatEventBody) => void) | null = null

export function setActiveEmit(emit: ((body: ChatEventBody) => void) | null): void {
  active = emit
}

export function getActiveEmit(): ((body: ChatEventBody) => void) | null {
  return active
}
