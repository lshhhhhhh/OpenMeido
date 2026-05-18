/**
 * Cross-platform memory types — no Node / Electron / native imports.
 * Safe to consume from renderer, Node, browser, Capacitor, etc.
 */

export type Speaker = 'user' | 'assistant'

export interface Episode {
  id: number
  ts: string
  speaker: Speaker
  text: string
  sessionId: string | null
}
