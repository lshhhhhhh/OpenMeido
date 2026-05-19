/**
 * Drop-in replacement for `window.confirm()` that doesn't break input
 * focus on transparent + frameless Electron windows.
 *
 * ===========================================================================
 * THE BUG (and why this file exists)
 * ===========================================================================
 *
 * Symptom (Windows + Electron, `transparent: true, frame: false`):
 *   After the user dismisses ANY native confirm dialog — "清空全部记忆"
 *   yes/no, "删除人设" yes/no, "AI 绑定表情" yes/no, etc. — clicking the
 *   chat input briefly focuses it (cursor blinks once) then immediately
 *   blurs back to document.body. Cursor can't enter. Keyboard Tab also
 *   stops cycling between elements. Workaround: click the desktop and
 *   then click back onto OpenMeido — that forces Windows DWM to re-
 *   evaluate window focus and the input becomes usable again.
 *
 * Diagnostic timeline (logged from a real repro):
 *   05:21:21.597  WINDOW focus
 *   05:21:21.598  input FOCUS              ← user click landed
 *   05:21:21.856  input BLUR (next=null)   ← 258 ms later, focus gone
 *   05:21:21.857  WINDOW blur              ← 1 ms after input blur
 *   05:21:21.857  WINDOW focus             ← same ms, immediately back
 *
 * Things we tried that did NOT fix it:
 *   - Tracking `busy` state    — stays false, not the cause
 *   - Removing render storms   — App wasn't actually storming, false lead
 *   - Tracking React mounts    — input element wasn't being unmounted
 *   - Window-level click-through (setIgnoreMouseEvents) — removed entirely
 *     in favor of plain opaque-to-clicks; bug persisted
 *   - Disabling `transparent: true` — bug still reproduced opaque
 *   - Disabling `alwaysOnTop: true` — bug still reproduced
 *   - 200 ms debounce on click-through enable — no effect
 *
 * Things that did NOT match the original mental model:
 *   - `next focus = null` after blur, NOT a competing element. So nothing
 *     else was stealing focus — focus was being explicitly revoked.
 *   - Window blur fires AFTER input blur, in the same ~1 ms tick. So the
 *     order is: DOM input loses focus first → window then sees no focused
 *     element → window itself loses focus → Windows immediately gives it
 *     back. Looked like a focus-storm but is really one event.
 *
 * Root cause:
 *   Chromium's native `window.confirm()` dialog. Even after the user
 *   dismisses it, opening any synchronous modal-dialog primitive over a
 *   transparent + frameless `BrowserWindow` leaves the OS-level focus
 *   pump in a fragile state. The first subsequent DOM focus event on a
 *   text input gets shed back to body ~250 ms later, and the window
 *   bounces blur→focus once. After that bounce the state IS healthy
 *   again, but the user has by then perceived "input can't be typed in"
 *   and the focused-once-then-blurred pattern can repeat if they click
 *   again before settling.
 *
 *   Reproducible 100% of the time when:
 *     1. window has `transparent: true, frame: false`
 *     2. ANY `window.confirm()` (or `window.alert()`, by extension) opens
 *        and closes
 *     3. user immediately clicks a text input
 *
 * Fix: never call `window.confirm()` in this app. Use the async
 * `confirm()` exported below — it renders a React modal that doesn't
 * touch native dialogs.
 *
 * ===========================================================================
 * API
 * ===========================================================================
 *
 *   confirm(message): Promise<boolean>
 *     Async equivalent of `window.confirm`. Resolves true / false. Falls
 *     back to native `window.confirm` ONLY if `<ConfirmHost />` is not
 *     mounted (shouldn't happen in normal use; only relevant if someone
 *     calls confirm during very early module init).
 *
 *   <ConfirmHost />
 *     Mount exactly once in the renderer tree (App.tsx does this). All
 *     `confirm()` calls anywhere in the app are routed to this single
 *     modal.
 *
 * Imperative bridge over module-level state rather than React context
 * because most call sites are inside async event handlers — converting
 * them all into context-consuming components for one call would be much
 * more invasive than a 5-line module global.
 */

import { useEffect, useState } from 'react'

type PendingDialog =
  | { kind: 'confirm'; message: string; resolve: (ok: boolean) => void }
  | {
      kind: 'prompt'
      message: string
      defaultValue: string
      resolve: (value: string | null) => void
    }
let setPending: ((p: PendingDialog | null) => void) | null = null

/**
 * Show a confirm dialog, await the user's choice. Returns true if OK
 * pressed, false if Cancel or dismissed.
 *
 * If `<ConfirmHost />` isn't mounted yet (very early startup), falls back
 * to window.confirm — that's the only branch where the focus-storm bug
 * could still surface, but in practice this code path is never hit.
 */
export function confirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!setPending) {
      console.warn('[confirm] host not mounted, falling back to native confirm')
      resolve(window.confirm(message))
      return
    }
    setPending({ kind: 'confirm', message, resolve })
  })
}

/**
 * Async equivalent of `window.prompt`. Returns the entered string, or null
 * if the user cancelled / dismissed. Same focus-storm-on-transparent-window
 * problem applies to `window.prompt` so this is the only safe entry point.
 */
export function prompt(message: string, defaultValue = ''): Promise<string | null> {
  return new Promise((resolve) => {
    if (!setPending) {
      console.warn('[prompt] host not mounted, falling back to native prompt')
      resolve(window.prompt(message, defaultValue))
      return
    }
    setPending({ kind: 'prompt', message, defaultValue, resolve })
  })
}

export function ConfirmHost() {
  const [pending, setPendingState] = useState<PendingDialog | null>(null)
  const [promptValue, setPromptValue] = useState('')
  useEffect(() => {
    setPending = setPendingState
    return () => {
      setPending = null
    }
  }, [])
  // Reset the prompt input value whenever a new prompt opens.
  useEffect(() => {
    if (pending?.kind === 'prompt') setPromptValue(pending.defaultValue)
  }, [pending])
  if (!pending) return null

  const cancel = (): void => {
    if (pending.kind === 'confirm') pending.resolve(false)
    else pending.resolve(null)
    setPendingState(null)
  }
  const accept = (): void => {
    if (pending.kind === 'confirm') pending.resolve(true)
    else pending.resolve(promptValue)
    setPendingState(null)
  }

  return (
    <div
      role="dialog"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 3000,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'system-ui, sans-serif',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) cancel()
      }}
    >
      <div
        style={{
          minWidth: 320,
          maxWidth: '85%',
          background: '#1f2128',
          color: '#eee',
          borderRadius: 8,
          padding: '16px 18px',
          boxShadow: '0 10px 40px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 14, whiteSpace: 'pre-wrap' }}>
          {pending.message}
        </div>
        {pending.kind === 'prompt' && (
          <input
            autoFocus
            value={promptValue}
            onChange={(e) => setPromptValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                accept()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                cancel()
              }
            }}
            style={{
              width: '100%',
              padding: '6px 10px',
              marginBottom: 14,
              background: '#2a2d36',
              border: '1px solid #3a3e48',
              color: '#eee',
              borderRadius: 5,
              fontSize: 13,
              fontFamily: 'monospace',
              boxSizing: 'border-box',
            }}
          />
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            onClick={cancel}
            autoFocus={pending.kind === 'confirm'}
            style={{
              padding: '6px 14px',
              background: 'transparent',
              border: '1px solid #4a4e58',
              color: '#aaa',
              borderRadius: 5,
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            取消
          </button>
          <button
            onClick={accept}
            style={{
              padding: '6px 14px',
              background:
                pending.kind === 'confirm'
                  ? 'rgba(200, 80, 80, 0.2)'
                  : 'rgba(120, 160, 255, 0.2)',
              border:
                '1px solid ' +
                (pending.kind === 'confirm'
                  ? 'rgba(200, 80, 80, 0.5)'
                  : 'rgba(120, 160, 255, 0.5)'),
              color: pending.kind === 'confirm' ? '#f99' : '#aad4ff',
              borderRadius: 5,
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 500,
            }}
          >
            确定
          </button>
        </div>
      </div>
    </div>
  )
}
