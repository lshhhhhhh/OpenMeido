/**
 * One demo entry, loaded from `<userData>/demos.json`. The file is a flat
 * array — each entry has its own hotkey so different lines can fire from
 * different keys (e.g. `1` plays demo 1, `2` plays demo 2). The renderer
 * re-reads the file on every keydown that could plausibly be a hotkey, so
 * user edits take effect on the very next press — no restart.
 */
export interface Demo {
  /**
   * Local keyboard shortcut that fires THIS demo. Window-focused only (not
   * OS-global). Format: '+'-separated modifier list + key, e.g.
   *   '1'              ← bare key works; suppressed when an input is focused
   *   'Ctrl+Shift+D'
   *   'Alt+F1'
   * Modifiers accepted (case-insensitive): Ctrl / Control / Shift / Alt / Meta / Cmd.
   * Key is the final segment (e.g. 'D', 'Space', 'F1', '1').
   */
  hotkey: string
  /** The line that goes into the chat history + drives TTS. */
  text: string
  /**
   * Live2D expression name. Must match an entry in the active model's
   * `*.exp3.json` registry (see openmeido.json sidecar for the model).
   * Use `null` or omit to clear any held expression.
   */
  expression?: string | null
  /** Optional one-shot motion. group must exist in the model3.json. */
  motion?: { group: string; index: number }
}

/**
 * Does `event` match `hotkey`? Permissive matching: requires every modifier
 * named in `hotkey` to be pressed (and only those — extras like also-holding
 * Alt count as a non-match so a key combo doesn't ambiguously fire).
 */
export function matchHotkey(event: KeyboardEvent, hotkey: string): boolean {
  const parts = hotkey
    .split('+')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  if (parts.length === 0) return false
  const wantCtrl = parts.includes('ctrl') || parts.includes('control') || parts.includes('cmdorctrl')
  const wantShift = parts.includes('shift')
  const wantAlt = parts.includes('alt')
  const wantMeta = parts.includes('meta') || parts.includes('cmd')
  const MODS = new Set(['ctrl', 'control', 'cmdorctrl', 'shift', 'alt', 'meta', 'cmd'])
  const key = parts.find((p) => !MODS.has(p)) ?? ''
  if (!key) return false
  return (
    event.ctrlKey === wantCtrl &&
    event.shiftKey === wantShift &&
    event.altKey === wantAlt &&
    event.metaKey === wantMeta &&
    event.key.toLowerCase() === key
  )
}
