import { stripMarkdown } from '../../shared/strip-markdown.js'

/**
 * Pre-TTS text cleanup:
 *   1. Strip XML/HTML-looking tags (`<think>` etc.) — they'd otherwise
 *      end up inside the SSML envelope Edge TTS builds, and the service
 *      returns a binary garbage payload when SSML is malformed. The
 *      cloud providers also choke on stray tags inside the prompt.
 *   2. Strip markdown formatting via the shared helper. Without this,
 *      TTS literally reads "星号" / "井号" / "竖线" out loud — sounds
 *      terrible. Shared with the chat-bubble display path so audio and
 *      visible text stay consistent.
 */
export function sanitizeForTTS(text: string): string {
  const noTags = text
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/<\/?(?:think|thinking|tool_call|arg_key|arg_value)(?:\s[^>]*)?>/gi, '')
  return stripMarkdown(noTags).trim()
}
