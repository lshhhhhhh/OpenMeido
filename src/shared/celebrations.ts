/**
 * Pure detection for "user just hit a setup milestone, fire the +5
 * celebration UX" events.
 *
 * Two milestones:
 *   - 'ai':  backend.apiKey empty → non-empty for the first time.
 *            Doesn't consult env-var fallback — the celebration is
 *            specifically for "you explicitly typed it into Settings",
 *            which is the user action we want to reward.
 *   - 'tts': tts.backend was 'edge' (default) → now one of the advanced
 *            backends (sovits / minimax / volcengine) AND that backend
 *            has its required credentials filled in. Without the
 *            credentials check we'd celebrate the dropdown-change
 *            BEFORE the user finishes wiring it up.
 *
 * Each celebration is one-shot per install via the matching flag in
 * config.onboarding. After the flag flips true, the user can rotate
 * keys / switch backends freely without re-triggering.
 *
 * Lives in shared/ (not main/) so the smoke test can exercise every
 * branch without booting Electron.
 */

import type { Config } from './config.js'

export type CelebrationKind = 'ai' | 'tts'

/**
 * Does the chosen advanced TTS backend have its required credentials
 * filled? Each backend has different required fields — we ask only
 * about the new backend, not the old one. (The user's previous backend
 * config may be partially populated for some unrelated reason.)
 */
export function hasRequiredAdvancedTtsFields(tts: Config['tts']): boolean {
  switch (tts.backend) {
    case 'edge':
      // edge needs no creds (it's the freebie default), but this branch
      // shouldn't be reached for the celebration check because the
      // check filters out edge before calling us.
      return false
    case 'sovits':
      return !!tts.sovits.refAudio.trim() && !!tts.sovits.refText.trim()
    case 'minimax':
      return !!tts.minimax.apiKey.trim() && !!tts.minimax.groupId.trim()
    case 'volcengine':
      return !!tts.volcengine.appid.trim() && !!tts.volcengine.accessToken.trim()
  }
}

/**
 * Diff two configs and decide which celebrations should fire on this
 * setConfig call. Returns the list of triggered kinds — empty when
 * nothing happened. Caller is responsible for flipping the matching
 * flags + actually performing the celebration side effects.
 */
export function detectCelebrationTriggers(
  prev: Config,
  next: Config,
): CelebrationKind[] {
  const triggers: CelebrationKind[] = []

  // AI: apiKey transitions empty → non-empty AND flag not yet flipped.
  // Trim because users sometimes paste a key with trailing whitespace
  // and we don't want that to count as "set".
  const prevKeyEmpty = !prev.backend.apiKey.trim()
  const nextKeyFilled = !!next.backend.apiKey.trim()
  if (prevKeyEmpty && nextKeyFilled && !prev.onboarding.aiSetupCelebrated) {
    triggers.push('ai')
  }

  // TTS: edge → non-edge AND new backend's required fields are populated
  // AND flag not yet flipped.
  if (
    prev.tts.backend === 'edge' &&
    next.tts.backend !== 'edge' &&
    hasRequiredAdvancedTtsFields(next.tts) &&
    !prev.onboarding.advancedTtsCelebrated
  ) {
    triggers.push('tts')
  }

  return triggers
}
