/**
 * Global hotkey to summon / dismiss the main window.
 *
 * Behavior: when fired, if the window is visible AND focused → hide; otherwise
 * show + focus. So the same combo toggles in/out from the user's POV, but a
 * window that's already on screen but buried gets pulled to the front instead
 * of being hidden away.
 *
 * Accelerator strings follow Electron's format
 * (https://www.electronjs.org/docs/latest/api/accelerator). Empty string =
 * disabled. Re-registers on every config change so the user can rebind from
 * Settings without restart.
 */

import { app, BrowserWindow, globalShortcut } from 'electron'

let currentAccelerator = ''
let lastError: string | null = null
let getWindow: () => BrowserWindow | null = () => null

export function initHotkey(windowAccessor: () => BrowserWindow | null): void {
  getWindow = windowAccessor
  // Belt-and-suspenders: Electron auto-unregisters on quit, but being explicit
  // makes accidental double-registration on dev HMR less likely.
  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
  })
}

function toggleWindow(): void {
  const win = getWindow()
  if (!win || win.isDestroyed()) return
  if (win.isVisible() && win.isFocused()) {
    win.hide()
  } else {
    if (!win.isVisible()) win.show()
    if (win.isMinimized()) win.restore()
    win.focus()
  }
}

/** Re-register based on the new config value. Idempotent. */
export function applyHotkey(accelerator: string): void {
  const next = (accelerator || '').trim()
  if (next === currentAccelerator) return

  if (currentAccelerator) {
    try {
      globalShortcut.unregister(currentAccelerator)
    } catch (err) {
      console.warn('[hotkey] unregister failed:', err)
    }
  }
  currentAccelerator = ''
  lastError = null

  if (!next) return // disabled

  try {
    const ok = globalShortcut.register(next, toggleWindow)
    if (!ok) {
      lastError = `无法注册 "${next}"——可能已被其他程序占用或格式不正确`
      console.warn('[hotkey]', lastError)
      return
    }
    currentAccelerator = next
    console.log(`[hotkey] registered "${next}"`)
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
    console.warn('[hotkey] register threw:', err)
  }
}

export function getHotkeyStatus(): {
  registered: boolean
  accelerator: string
  error: string | null
} {
  return {
    registered: currentAccelerator !== '',
    accelerator: currentAccelerator,
    error: lastError,
  }
}
