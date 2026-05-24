/**
 * Kimi `$web_search` response stream filter.
 *
 * Moonshot's Kimi K2 supports a server-side web search via a special
 * `type: 'builtin_function'` tool. When the model triggers it:
 *   1. Stream emits a tool_call chunk with `type: 'builtin_function'`,
 *      `function.name: '$web_search'`.
 *   2. Moonshot's server INTERNALLY executes the search.
 *   3. Model continues streaming the final answer text grounded on
 *      the results — no client-side tool execution needed.
 *
 * The Vercel AI SDK's OpenAI-compat parser strictly validates
 * `tool_calls[].type === 'function'` and throws on anything else.
 * That breaks the whole stream the moment Moonshot emits the
 * `builtin_function` marker, even though we don't NEED to handle
 * the tool call (server already did).
 *
 * Fix: wrap the response body and strip `builtin_function` entries
 * from tool_calls arrays in each SSE chunk before they reach the
 * SDK. The model's actual content chunks flow through untouched.
 * If a chunk only carried the builtin_function marker, we drop the
 * whole chunk; if it carried other deltas alongside, we drop just
 * that entry.
 */

/**
 * Wraps a fetch Response so its SSE stream has any
 * `type: 'builtin_function'` tool_calls stripped before downstream
 * parsers see them. Returns a new Response with the same status/headers
 * but a filtered body. Pass non-SSE responses through unchanged.
 */
export function wrapKimiSearchResponse(response: Response): Response {
  // Bail-outs: error responses (let the SDK see real errors) and
  // responses without a body (e.g. HEAD, 204).
  if (!response.body || !response.ok) return response

  // Confirm we're looking at an event-stream. Non-streaming responses
  // (chat.completions without stream:true) get their tool_calls inside
  // a JSON body; we don't handle those here because the chat path
  // always uses streaming.
  const ct = response.headers.get('content-type') ?? ''
  if (!ct.toLowerCase().includes('text/event-stream')) return response

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let pending = '' // incomplete line carried across read() chunks

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read()
        if (done) {
          // Flush whatever's left even though it's an incomplete
          // line — better than dropping the tail of the stream.
          if (pending.length > 0) {
            controller.enqueue(encoder.encode(pending))
            pending = ''
          }
          controller.close()
          return
        }
        const text = pending + decoder.decode(value, { stream: true })
        // SSE messages can carry a multi-line `data:` payload separated
        // by `\n\n`. For OpenAI-compat each event is a single `data:` line,
        // so splitting on `\n` is sufficient — and lets us scan/filter
        // line-by-line cleanly. The last segment is the in-progress line.
        const lines = text.split('\n')
        pending = lines.pop() ?? ''
        const out: string[] = []
        for (const raw of lines) {
          const filtered = filterSseLine(raw)
          if (filtered !== null) out.push(filtered)
        }
        if (out.length > 0) {
          controller.enqueue(encoder.encode(out.join('\n') + '\n'))
        }
      } catch (err) {
        controller.error(err)
      }
    },
    cancel() {
      void reader.cancel()
    },
  })

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

/**
 * Inspect a single SSE line. Returns:
 *   - the original line if it's untouched (non-data, [DONE], no
 *     builtin_function entries)
 *   - a rewritten line if some builtin_function entries needed
 *     removal but other content survives
 *   - null if the whole line should be dropped (delta carried ONLY
 *     a builtin_function marker, nothing else)
 *
 * Exported for unit testing.
 */
export function filterSseLine(line: string): string | null {
  if (!line.startsWith('data: ')) return line
  const payload = line.slice(6)
  if (payload === '[DONE]' || payload.trim() === '') return line
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return line // malformed JSON — pass through; parser will deal
  }
  if (!parsed || typeof parsed !== 'object') return line
  const choices = (parsed as { choices?: unknown[] }).choices
  if (!Array.isArray(choices)) return line

  let chunkBecameEmpty = true
  let mutated = false
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') continue
    const delta = (choice as { delta?: Record<string, unknown> }).delta
    if (!delta || typeof delta !== 'object') {
      // No delta = could be a finish_reason chunk; preserve.
      chunkBecameEmpty = false
      continue
    }
    const toolCalls = delta.tool_calls
    if (Array.isArray(toolCalls)) {
      const filtered = toolCalls.filter(
        (tc) =>
          !(
            tc &&
            typeof tc === 'object' &&
            (tc as { type?: unknown }).type === 'builtin_function'
          ),
      )
      if (filtered.length !== toolCalls.length) {
        mutated = true
        if (filtered.length === 0) delete delta.tool_calls
        else delta.tool_calls = filtered
      }
    }
    // Anything else in the delta (content / role / finish_reason etc)
    // means this chunk still carries useful info.
    if (Object.keys(delta).length > 0) chunkBecameEmpty = false
  }

  if (!mutated) return line
  if (chunkBecameEmpty) return null
  return 'data: ' + JSON.stringify(parsed)
}
