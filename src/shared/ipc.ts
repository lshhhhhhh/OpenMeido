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

export interface ChatSendPayload {
  messageId: string
  text: string
}

// IPC channel names — single source of truth for both sides.
export const IPC = {
  ChatSend: 'chat:send',
  ChatEvent: 'chat:event',
} as const
