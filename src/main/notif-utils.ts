/**
 * Pure-logic helpers extracted from notif-host so they can be unit-tested
 * outside Electron. notif-host itself imports BrowserWindow / child_process
 * / etc. and would crash a `node --import tsx` load.
 */

export interface NotifDecision {
  shouldSpeak: boolean
  reason: string
  comment: string
}

/**
 * Does an app name pass the user's allowlist? Substring match, case-
 * insensitive. Empty list means accept everything (very noisy — only useful
 * if you want full pass-through to the LLM gate).
 */
export function passesAllowlist(appName: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true
  const lc = appName.toLowerCase()
  return allowlist.some((entry) => entry && lc.includes(entry.toLowerCase()))
}

/**
 * Parse the LLM's reply to the `should_speak` gate. Tolerates:
 *   - bare JSON object
 *   - fenced ```json ``` block
 *   - prose preamble before the JSON
 *   - missing `comment` / `reason` (fills with empty string)
 * Returns null on unparseable input or wrong shape, so the caller can fall
 * back to "stay silent".
 */
export function parseDecision(raw: string): NotifDecision | null {
  let text = raw.trim()
  const fenced = text.match(/```(?:json)?\s*([\s\S]+?)```/i)
  if (fenced) text = fenced[1]!.trim()
  const objMatch = text.match(/\{[\s\S]*\}/)
  const candidate = objMatch ? objMatch[0] : text
  try {
    const parsed = JSON.parse(candidate) as {
      should_speak?: unknown
      reason?: unknown
      comment?: unknown
    }
    if (typeof parsed.should_speak !== 'boolean') return null
    return {
      shouldSpeak: parsed.should_speak,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      comment: typeof parsed.comment === 'string' ? parsed.comment : '',
    }
  } catch {
    return null
  }
}
