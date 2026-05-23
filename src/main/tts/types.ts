/**
 * Shared TTS types. Every adapter returns the same shape so the renderer
 * never needs to know which engine produced the bytes.
 */

export interface TTSResult {
  /** Base64-encoded audio bytes — ready to decode in the renderer. */
  base64: string
  /** Tells the renderer which decoder hint to use; `audio/mpeg` (MP3) and
   *  `audio/wav` are both accepted by Web Audio's `decodeAudioData`. */
  mimeType: 'audio/mpeg' | 'audio/wav'
}

export interface TTSVoice {
  shortName: string
  locale: string
  gender: string
  friendlyName: string
}
