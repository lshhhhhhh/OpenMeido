/**
 * Streaming filter that strips two kinds of garbage some models leak into
 * the user-visible text channel of a streamText() session.
 *
 *   1. `<think>...</think>` blocks — DeepSeek reasoner / Qwen thinking-mode /
 *      Anthropic extended thinking sometimes emit internal reasoning here.
 *
 *   2. Leaked tool-call narration — some models call a tool through the
 *      proper structured channel AND ALSO narrate the call as raw XML or
 *      fenced-XML in the text stream. We drop the narration:
 *        - `<tool_call>…</tool_call>` blocks (open + content + close)
 *        - `<arg_key>…</arg_key>` and `<arg_value>…</arg_value>` blocks
 *        - `\`\`\`html` / `\`\`\`xml` fenced blocks (assumed to be leaked
 *           tool-call XML — this character isn't a coding assistant)
 *
 * Streaming algorithm: instead of a fixed N-char holdback (which would
 * split tags), we sync on `<` and `` ` `` characters and hold back any
 * tail that could grow into one of those tokens. Everything before the
 * earliest unresolved sync point is safe to emit.
 *
 * State machine: { type: 'normal' | 'dropUntil'; close: string } where
 * dropUntil silently swallows everything until the named close marker
 * appears.
 *
 * Pure logic — lives in its own file so the smoke test can import it
 * without dragging Electron through tsx.
 */

export interface TextDeltaFilter {
  process(delta: string): string
  flush(): string
}

// `tagOpen` regex matches the OPENING tag of one of the markers we treat
// as "drop block" — everything from here to the matching close gets eaten.
// Order matters: <think>, <tool_call>, <arg_key>, <arg_value>.
const DROP_BLOCK_OPENERS: { open: RegExp; close: string }[] = [
  { open: /^<think>/i, close: '</think>' },
  { open: /^<tool_call>/i, close: '</tool_call>' },
  { open: /^<arg_key>/i, close: '</arg_key>' },
  { open: /^<arg_value>/i, close: '</arg_value>' },
]
const FENCE_OPEN_RE = /^```[ \t]*(html|xml)\b[^\n]*\n?/i
const FENCE_CLOSE = '```'

interface FilterState {
  // null = normal emit mode; string = drop everything until this marker.
  dropUntil: string | null
}

export function createTextDeltaFilter(): TextDeltaFilter {
  const state: FilterState = { dropUntil: null }
  let buffer = ''

  /**
   * Could the tail of `s` be the start of a `<tag` or `\`\`\`fence` we'd
   * need to recognize on the next delta? If yes, we hold it back. Returns
   * an offset — `s.slice(0, offset)` is safe to release, `s.slice(offset)`
   * stays buffered.
   *
   * Worst-case prefix:
   *   - opening tag: `<arg_value>` is 11 chars; allow up to 11 of pending tail
   *   - fence open: `\`\`\`html\n` is 8 chars, but the lang word could be longer
   *     (we only match html/xml), so 12 is safe headroom
   *   - close marker for dropUntil: handled separately
   */
  const safeReleaseOffset = (s: string): number => {
    // Find any pending unmatched `<` — if the tag isn't recognized yet AND
    // there's no closing `>` after it, hold back from that `<`.
    const ltIdx = s.lastIndexOf('<')
    let cutoff = s.length
    if (ltIdx !== -1) {
      const rest = s.slice(ltIdx)
      // If we already see `>` inside `rest`, the tag is complete — we can
      // release everything (drainNormal will tokenize it). Otherwise hold.
      if (rest.indexOf('>') === -1 && rest.length < 16) {
        cutoff = Math.min(cutoff, ltIdx)
      }
    }
    // Pending backticks: if the tail contains 1-3 backticks not followed
    // by enough chars to disambiguate fence-or-not, hold back.
    const btIdx = s.lastIndexOf('`')
    if (btIdx !== -1) {
      const rest = s.slice(btIdx)
      // Look for the run of consecutive backticks at this position.
      let runEnd = btIdx
      while (runEnd < s.length && s[runEnd] === '`') runEnd++
      // If <3 backticks: could grow to a fence — hold back from runStart.
      // If exactly 3 backticks but no newline yet AND tail short — hold.
      const runLen = runEnd - btIdx
      const after = s.slice(runEnd)
      let runStart = btIdx
      // Find the actual start of this run (lastIndexOf returns last char).
      while (runStart > 0 && s[runStart - 1] === '`') runStart--
      const totalRun = runEnd - runStart
      if (totalRun < 3) {
        cutoff = Math.min(cutoff, runStart)
      } else if (totalRun === 3 && !after.includes('\n') && after.length < 8) {
        cutoff = Math.min(cutoff, runStart)
      }
    }
    return cutoff
  }

  /** Drop chars from buffer until the dropUntil marker is consumed. */
  const drainDrop = (): string => {
    while (state.dropUntil) {
      const at = buffer.indexOf(state.dropUntil)
      if (at === -1) {
        // Keep just a tail in case the marker straddles deltas.
        if (buffer.length > state.dropUntil.length) {
          buffer = buffer.slice(-state.dropUntil.length + 1)
        }
        return ''
      }
      // Consume up to & including the close marker.
      const wasFence = state.dropUntil === FENCE_CLOSE
      buffer = buffer.slice(at + state.dropUntil.length)
      if (wasFence) buffer = buffer.replace(/^\r?\n/, '')
      state.dropUntil = null
      // Re-enter normal drain.
      return drainNormal()
    }
    return ''
  }

  const drainNormal = (): string => {
    let out = ''
    while (state.dropUntil === null) {
      // Sync points: `<` or backtick run.
      const lt = buffer.indexOf('<')
      const bt = buffer.indexOf('`')
      const at =
        lt === -1 ? bt : bt === -1 ? lt : Math.min(lt, bt)
      if (at === -1) {
        // No special chars. Emit everything that's safe.
        const cutoff = safeReleaseOffset(buffer)
        out += buffer.slice(0, cutoff)
        buffer = buffer.slice(cutoff)
        return out
      }
      // Emit safe prefix before sync point.
      if (at > 0) {
        out += buffer.slice(0, at)
        buffer = buffer.slice(at)
      }
      // Decide what the sync char means.
      if (buffer[0] === '<') {
        // Try to match a known drop-block opener.
        let matched = false
        for (const { open, close } of DROP_BLOCK_OPENERS) {
          const m = open.exec(buffer)
          if (m) {
            buffer = buffer.slice(m[0].length)
            state.dropUntil = close
            matched = true
            break
          }
        }
        if (matched) {
          out += drainDrop()
          continue
        }
        // Generic tag — match and emit as-is (some user message might
        // contain HTML; only the specifically-named ones get stripped).
        const generic = /^<\/?[a-zA-Z_][a-zA-Z0-9_]*(?:\s[^>]*)?>/.exec(buffer)
        if (generic) {
          out += generic[0]
          buffer = buffer.slice(generic[0].length)
          continue
        }
        // Could be incomplete or just literal `<`. Wait if it looks
        // tag-like (no `>` yet AND short); else emit as text.
        if (!buffer.includes('>') && buffer.length < 32) return out
        out += '<'
        buffer = buffer.slice(1)
        continue
      }
      // buffer starts with backtick(s).
      // Count consecutive backticks at start.
      let n = 0
      while (n < buffer.length && buffer[n] === '`') n++
      if (n < 3) {
        // Could grow into ``` — wait if buffer length is just this run.
        if (buffer.length === n) return out
        // We have backtick(s) followed by something else — they're literal.
        out += buffer.slice(0, n)
        buffer = buffer.slice(n)
        continue
      }
      // 3+ backticks — try fence open regex.
      const fence = FENCE_OPEN_RE.exec(buffer)
      if (fence) {
        buffer = buffer.slice(fence[0].length)
        state.dropUntil = FENCE_CLOSE
        out += drainDrop()
        continue
      }
      // 3+ backticks but not html/xml. If buffer has a newline or is long
      // enough to know the language, emit the ``` as-is.
      const afterRun = buffer.slice(n)
      if (afterRun.includes('\n') || afterRun.length >= 8) {
        out += buffer.slice(0, n)
        buffer = buffer.slice(n)
        continue
      }
      // Otherwise wait for more.
      return out
    }
    return out
  }

  return {
    process(delta: string): string {
      buffer += delta
      return state.dropUntil ? drainDrop() : drainNormal()
    },
    flush(): string {
      // If we're still mid-drop, throw away the unfinished content.
      if (state.dropUntil) {
        buffer = ''
        return ''
      }
      // Emit whatever's left. Any straggling open <tag without close, or
      // 1-2 trailing backticks, becomes literal text — no future delta to
      // disambiguate.
      const tail = buffer
      buffer = ''
      return tail
    },
  }
}
