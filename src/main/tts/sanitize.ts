import { stripMarkdown } from '../../shared/strip-markdown.js'

/**
 * Pre-TTS text cleanup:
 *   1. Strip model-internal tags (`<think>` etc.) — their CONTENT must
 *      never be read aloud. The cloud providers also choke on stray tags
 *      inside the prompt. This is not SSML safety: any other `<`, `&`
 *      (e.g. `张三 <a@b.com>`, `R&D`) survives here as plain text and is
 *      XML-escaped exactly once in `edge.ts` (escapeSsmlText) — only Edge
 *      wraps text in SSML, so escaping here would make the cloud engines
 *      read `&amp;` aloud.
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
