/**
 * Classify a chat turn type based on the tool calls invoked during that turn.
 */
export function classifyTurnType(calls: { toolName: string }[]): 'personal' | 'work' | 'neutral' {
  if (calls.length === 0) return 'personal'

  const workTools = [
    'listMailFolders',
    'listRecentEmails',
    'readEmail',
    'draftEmailReply',
    'readFile',
    'readWebPage',
    'google_search'
  ]

  const hasWork = calls.some(c => workTools.includes(c.toolName))
  if (hasWork) return 'work'

  return 'neutral'
}

/**
 * Detect if a user message clearly negates, retracts, or corrects a
 * previously-stated fact about themselves. When matched, the chat layer
 * bypasses the N-turn reflection threshold and runs reflection
 * immediately so the model's next reply doesn't repeat the stale fact.
 *
 * Pattern design — each rule MUST be specific to "the user is talking
 * about themselves / their identity / their info", not just generic
 * verbs like 忘记 or 改 that appear in everyday speech:
 *
 *   ✗ /忘记/        → "我忘记带钥匙了" — not a retraction
 *   ✗ /改一下/      → "改一下这封邮件" — not a retraction
 *   ✓ /忘了?我(的|是|不是)/ → "忘记我的猫名字" / "忘了我是小李"
 *   ✓ /改一下我的/   → "改一下我的名字"
 *
 * False positives cost an extra DeepSeek reflection call (~1-2KB
 * prompt, ~$0.0005). Cheap but accumulates if every message trips it.
 * Worth being precise.
 */
export function isRetractionOrCorrection(text: string): boolean {
  const patterns = [
    // ---- 自指 + 称呼撤回 ----
    /不要?叫我/, // "不要叫我X" / "不叫我X"
    /别叫我/,
    /我不叫/,
    /我(并)?不是\S/, // "我不是X" / "我并不是X" — require a non-space char after (avoid bare "我不是。")
    /我并非/,
    /我(的)?(真)?(实|名|姓名|名字)(是|不是|不叫)/, // "我的名字不是X" / "我真名是X"

    // ---- 显式撤回/纠正 + 自指 ----
    /忘[了记](掉|记)?(我|关于我)/, // "忘记我的名字" / "忘了我是X" — REQUIRES 我/关于我 after
    /忘掉(关于)?我/,
    /删(掉|除)?(我|关于我)/,
    /清(除|空)(我|关于我)/,
    /不要记(住|得|得了)?(我|关于我)/,
    /纠正(一下)?(我|关于我)/,
    /改(一下)?(我的|关于我的)/, // "改一下我的名字" — NOT "改一下这封邮件"
    /记错了/, // standalone admission — almost always self-referential in context
    /别记了/,

    // ---- English equivalents — same self-reference principle ----
    /don['']?t call me/i,
    /stop calling me/i,
    /forget (about )?my\b/i, // "forget my name" — NOT "forget the meeting"
    /forget (about )?me/i,
    /delete (my|me)\b/i,
    /clear my\b/i,
    /my name is(n['']t| not)/i, // "my name is not X"
    /i['']?m not\b/i, // "I'm not X" — generic, but combined with reflection context still useful
    /remember(ed)?( that)? wrong/i,
  ]
  return patterns.some((r) => r.test(text))
}
