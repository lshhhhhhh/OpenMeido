/**
 * Tell TS about the `window.api` bridge that preload exposes.
 *
 * We import the Api type from preload — the renderer doesn't actually run
 * any preload code (it's executed by Electron in a separate context), but
 * TypeScript happily uses it for type-only inference.
 */
import type { Api } from '../../preload/index'

declare global {
  interface Window {
    api: Api
  }
}

export {}
