/**
 * Wire-format types shared between main, preload, and renderer.
 *
 * Each event carries the `messageId` of the user-turn it belongs to, so the
 * renderer can route streamed chunks to the right reply bubble even if
 * multiple sends are in flight (won't happen in Spike 2, but cheap to design in).
 *
 * We model the event as `body & { messageId }` rather than putting messageId
 * inside each union arm — that way `Omit<ChatEvent, 'messageId'>` (which TS
 * does NOT distribute across union arms) is never needed. The main process
 * emits a `ChatEventBody` and the wire layer tacks `messageId` on.
 */

export type ChatEventBody =
  | { type: 'text'; delta: string }
  | { type: 'tool-call'; toolName: string; args: unknown }
  | { type: 'tool-result'; toolName: string; result: unknown }
  | { type: 'done' }
  | { type: 'error'; error: string }

export type ChatEvent = ChatEventBody & { messageId: string }

/** Image attached to a user turn (screenshot, file upload, paste, etc). */
export interface ChatImageAttachment {
  /** "image/png", "image/jpeg", ... */
  mimeType: string
  /** Base64 of the raw bytes — keeps the wire format stringy + JSON-safe. */
  base64: string
  /** Source tag so the UI can label the bubble (📷 截屏 / 📎 文件 / 📋 粘贴). */
  source: 'screenshot' | 'file' | 'paste'
}

export interface ChatSendPayload {
  messageId: string
  text: string
  /**
   * Zero or more image attachments. Multi-screen users get one entry per
   * display when they hit the camera button; future paste / file-drop
   * features extend this list too.
   */
  images?: ChatImageAttachment[]
}

/** One entry per attached display. UI renders a preview + name in the picker. */
export interface ScreenInfo {
  id: string
  name: string
  /** Base64 PNG, ~240x135 — for the dropdown thumbnail, NOT what gets sent to the model. */
  previewBase64: string
}

// IPC channel names — single source of truth for both sides.
export const IPC = {
  ChatSend: 'chat:send',
  ChatEvent: 'chat:event',
} as const
