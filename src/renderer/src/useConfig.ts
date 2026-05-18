import { useEffect, useState } from 'react'

import type { Config } from '../../shared/config'

/**
 * Subscribe to the running app config. Returns null while the initial fetch
 * is in flight, then the live config (auto-updates when main process pushes
 * a change — including settings saved from any window).
 */
export function useConfig(): Config | null {
  const [cfg, setCfg] = useState<Config | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api.config.get().then((c) => {
      if (!cancelled) setCfg(c)
    })
    const unsub = window.api.config.onChange((next) => setCfg(next))
    return () => {
      cancelled = true
      unsub()
    }
  }, [])

  return cfg
}
