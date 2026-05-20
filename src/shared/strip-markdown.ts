/**
 * Markdown-formatting stripper. Shared between TTS (so the synthesizer
 * doesn't read "星号" out loud for `**bold**`) and the chat bubble (so
 * the user doesn't see literal asterisks/hashes/pipes when the model
 * helpfully tries to format a list).
 *
 * Strips, doesn't render — we don't want a markdown view, just clean
 * plain text with formatting markers removed. The structure (line
 * breaks, indentation) survives.
 *
 * Conservative on identifier-style underscores (snake_case_var,
 * URL_PARAM) so the italic regex doesn't mangle them.
 */

export function stripMarkdown(text: string): string {
  let s = text
  // Fenced code blocks first (multi-line): keep content, drop ```
  s = s.replace(/```[\w-]*\n?([\s\S]*?)\n?```/g, '$1')
  // Inline code spans: keep content, drop backticks
  s = s.replace(/`([^`\n]+)`/g, '$1')
  // Images: keep alt text
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  // Links: keep the visible text, drop the URL
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  // Bold (**x** / __x__) and italic (*x* / _x_).
  // Italic regex avoids alphanumeric_underscore neighbors so
  // "snake_case_var" stays intact; CJK / punctuation neighbors work
  // (which is the common case in maid replies like "**很重要**").
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '$1')
  s = s.replace(/__([^_\n]+)__/g, '$1')
  s = s.replace(/(^|[^A-Za-z0-9_])\*([^*\n]+)\*(?=[^A-Za-z0-9_]|$)/g, '$1$2')
  s = s.replace(/(^|[^A-Za-z0-9_])_([^_\n]+)_(?=[^A-Za-z0-9_]|$)/g, '$1$2')
  // Strikethrough
  s = s.replace(/~~([^~\n]+)~~/g, '$1')
  // Line-leading markers: headings, blockquotes, list bullets, ordered-list
  // numbers. Match only at line start so "- 1." mid-sentence stays intact.
  s = s.replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
  s = s.replace(/^[ \t]*>[ \t]?/gm, '')
  s = s.replace(/^[ \t]*[-*+][ \t]+/gm, '')
  s = s.replace(/^[ \t]*\d+\.[ \t]+/gm, '')
  // Horizontal rules: --- / *** / ___ on their own line
  s = s.replace(/^[ \t]*([-*_])[ \t]*\1[ \t]*\1[-*_ \t]*$/gm, '')
  // Table pipes → space (tables read as columns is meaningless inline)
  s = s.replace(/\|/g, ' ')
  // Collapse runs of blank lines to a single newline so prosody / visual
  // spacing doesn't pile up.
  s = s.replace(/\n{3,}/g, '\n\n')
  return s
}
