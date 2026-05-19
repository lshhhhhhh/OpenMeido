/**
 * Streaming filter that strips garbage some models leak into the
 * user-visible text channel of a streamText() session.
 *
 *   1. Paired `<think>...</think>` blocks — DeepSeek reasoner / Qwen
 *      thinking-mode / Anthropic extended thinking sometimes emit internal
 *      reasoning here. The open AND close are present, so we just eat the
 *      block.
 *
 *   2. **Implicit thinking** — some models (GLM 4.6 / Qwen3 thinking on
 *      certain endpoints) emit reasoning text WITHOUT an opening `<think>`,
 *      followed by a bare `</think>` and then the real reply. We can't strip
 *      this preemptively (no opener to sync on), so we emit a *reset signal*
 *      when the bare close arrives: the consumer should discard everything
 *      it received since the last checkpoint. The chat loop calls
 *      `checkpoint()` after each tool-call so a step-2 implicit close
 *      doesn't wipe step-1's already-displayed content.
 *
 *   3. Leaked tool-call narration — some models call a tool through the
 *      proper structured channel AND ALSO narrate the call as raw XML or
 *      fenced-XML in the text stream. We drop the narration:
 *        - `<tool_call>…</tool_call>` blocks
 *        - `<arg_key>…</arg_key>` and `<arg_value>…</arg_value>` blocks
 *        - `\`\`\`html` / `\`\`\`xml` fenced blocks (assumed leaked XML)
 *
 * Streaming algorithm: sync on `<` and `` ` `` characters and hold back any
 * tail that could grow into one of those tokens. Everything before the
 * earliest unresolved sync point is safe to emit.
 *
 * Pure logic — lives in its own file so the smoke test can import it
 * without dragging Electron through tsx.
 */

/**
 * One filter output. `emit` is text to append to whatever the consumer is
 * accumulating; `resetLength` (when > 0) tells the consumer to first
 * truncate the last `resetLength` chars from its accumulator before
 * appending `emit`. Both fields can be set in the same output: the reset
 * always applies BEFORE the emit.
 */
export interface FilterOutput {
  emit: string
  resetLength?: number
}

export interface TextDeltaFilter {
  process(delta: string): FilterOutput
  flush(): FilterOutput
  /**
   * Mark the current emit position as a no-reset boundary. The chat loop
   * calls this after each tool-call event so a subsequent implicit `</think>`
   * only resets the current step's text, not prior steps' content.
   */
  checkpoint(): void
}

const DROP_BLOCK_OPENERS: { open: RegExp; close: string }[] = [
  { open: /^<think>/i, close: '</think>' },
  { open: /^<thinking>/i, close: '</thinking>' },
  { open: /^<tool_call>/i, close: '</tool_call>' },
  { open: /^<arg_key>/i, close: '</arg_key>' },
  { open: /^<arg_value>/i, close: '</arg_value>' },
]
// Bare close-tag that we treat as an implicit-thinking close. Matches
// `</think>` and `</thinking>` (case-insensitive). When the filter hits
// this in normal mode (no matching open was seen), the prefix is
// retroactively classified as reasoning and a reset is signaled.
const IMPLICIT_CLOSE_RE = /^<\/think(?:ing)?>/i
const FENCE_OPEN_RE = /^```[ \t]*(html|xml)\b[^\n]*\n?/i
const FENCE_CLOSE = '```'

interface FilterState {
  dropUntil: string | null
}

export function createTextDeltaFilter(): TextDeltaFilter {
  const state: FilterState = { dropUntil: null }
  let buffer = ''
  /**
   * Chars the consumer has accumulated since the last checkpoint. When an
   * implicit `</think>` is detected, this many chars need to be rolled
   * back. Includes everything we've emitted from prior process() calls
   * plus what we're about to emit in the current pass.
   */
  let emittedSinceCheckpoint = 0
  /**
   * Reset length to attach to the NEXT FilterOutput. Drains-set this when
   * they see an implicit close; the public method copies it into the
   * return value and zeroes it for the next call.
   */
  let pendingReset = 0

  const safeReleaseOffset = (s: string): number => {
    const ltIdx = s.lastIndexOf('<')
    let cutoff = s.length
    if (ltIdx !== -1) {
      const rest = s.slice(ltIdx)
      if (rest.indexOf('>') === -1 && rest.length < 16) {
        cutoff = Math.min(cutoff, ltIdx)
      }
    }
    const btIdx = s.lastIndexOf('`')
    if (btIdx !== -1) {
      let runEnd = btIdx
      while (runEnd < s.length && s[runEnd] === '`') runEnd++
      let runStart = btIdx
      while (runStart > 0 && s[runStart - 1] === '`') runStart--
      const totalRun = runEnd - runStart
      const after = s.slice(runEnd)
      if (totalRun < 3) {
        cutoff = Math.min(cutoff, runStart)
      } else if (totalRun === 3 && !after.includes('\n') && after.length < 8) {
        cutoff = Math.min(cutoff, runStart)
      }
    }
    return cutoff
  }

  const drainDrop = (): string => {
    while (state.dropUntil) {
      const at = buffer.indexOf(state.dropUntil)
      if (at === -1) {
        if (buffer.length > state.dropUntil.length) {
          buffer = buffer.slice(-state.dropUntil.length + 1)
        }
        return ''
      }
      const wasFence = state.dropUntil === FENCE_CLOSE
      buffer = buffer.slice(at + state.dropUntil.length)
      if (wasFence) buffer = buffer.replace(/^\r?\n/, '')
      state.dropUntil = null
      return drainNormal()
    }
    return ''
  }

  const drainNormal = (): string => {
    let out = ''
    while (state.dropUntil === null) {
      const lt = buffer.indexOf('<')
      const bt = buffer.indexOf('`')
      const at = lt === -1 ? bt : bt === -1 ? lt : Math.min(lt, bt)
      if (at === -1) {
        const cutoff = safeReleaseOffset(buffer)
        out += buffer.slice(0, cutoff)
        buffer = buffer.slice(cutoff)
        return out
      }
      if (at > 0) {
        out += buffer.slice(0, at)
        buffer = buffer.slice(at)
      }
      if (buffer[0] === '<') {
        // Implicit-thinking close — bare `</think>` without a matching open.
        // Signals "everything emitted since checkpoint was reasoning, throw
        // it away". We swallow the tag, reset our running counter, and tell
        // the caller how many chars to roll back.
        const implicit = IMPLICIT_CLOSE_RE.exec(buffer)
        if (implicit && state.dropUntil === null) {
          buffer = buffer.slice(implicit[0].length)
          // Reset length = everything previously emitted + what we built up
          // in this same drainNormal pass before hitting the tag. Both are
          // about to vanish from the consumer's accumulator.
          pendingReset += emittedSinceCheckpoint + out.length
          emittedSinceCheckpoint = 0
          out = ''
          continue
        }
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
        const generic = /^<\/?[a-zA-Z_][a-zA-Z0-9_]*(?:\s[^>]*)?>/.exec(buffer)
        if (generic) {
          out += generic[0]
          buffer = buffer.slice(generic[0].length)
          continue
        }
        if (!buffer.includes('>') && buffer.length < 32) return out
        out += '<'
        buffer = buffer.slice(1)
        continue
      }
      // backtick(s)
      let n = 0
      while (n < buffer.length && buffer[n] === '`') n++
      if (n < 3) {
        if (buffer.length === n) return out
        out += buffer.slice(0, n)
        buffer = buffer.slice(n)
        continue
      }
      const fence = FENCE_OPEN_RE.exec(buffer)
      if (fence) {
        buffer = buffer.slice(fence[0].length)
        state.dropUntil = FENCE_CLOSE
        out += drainDrop()
        continue
      }
      const afterRun = buffer.slice(n)
      if (afterRun.includes('\n') || afterRun.length >= 8) {
        out += buffer.slice(0, n)
        buffer = buffer.slice(n)
        continue
      }
      return out
    }
    return out
  }

  const consume = (raw: string): FilterOutput => {
    const resetLength = pendingReset
    pendingReset = 0
    emittedSinceCheckpoint += raw.length
    return resetLength > 0 ? { emit: raw, resetLength } : { emit: raw }
  }

  return {
    process(delta: string): FilterOutput {
      buffer += delta
      const raw = state.dropUntil ? drainDrop() : drainNormal()
      return consume(raw)
    },
    flush(): FilterOutput {
      if (state.dropUntil) {
        buffer = ''
        // Still surface any pending reset — the prefix WAS shown to the user
        // and we promised to take it back.
        const resetLength = pendingReset
        pendingReset = 0
        return resetLength > 0 ? { emit: '', resetLength } : { emit: '' }
      }
      const tail = buffer
      buffer = ''
      return consume(tail)
    },
    checkpoint(): void {
      // Future implicit-close events shouldn't undo content emitted before
      // this point. Zero the counter; pendingReset alone determines reset
      // semantics from here forward.
      emittedSinceCheckpoint = 0
    },
  }
}
