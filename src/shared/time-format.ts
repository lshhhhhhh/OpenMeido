/**
 * Tiny shared time helpers. Lives in `shared/` so both the main process
 * (chat, greeting, proactive) and the renderer can use them without one
 * importing through the other.
 */

/**
 * Local wall-clock string in zh-CN format that the model can quote verbatim.
 *
 * Example: "2026年5月19日 周一 上午9点30分"
 *
 * Why this shape: ISO-UTC strings would force the model to do timezone
 * arithmetic. Small models skip that and just guess, producing wrong
 * times even when we hand them the answer. Pre-rendering the local
 * wall-clock string ourselves means the model just reads it.
 */
export function formatLocalNow(d: Date = new Date()): string {
  const date = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(d)
  const time = new Intl.DateTimeFormat('zh-CN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d)
  return `${date} ${time}`
}
