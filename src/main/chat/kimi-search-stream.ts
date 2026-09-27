/**
 * Kimi `$web_search` round-trip, hidden inside the SSE stream.
 *
 * Moonshot's `$web_search` is a `type: 'builtin_function'` tool. It is NOT
 * fully server-side: when the model decides to search, the stream ends with
 * `finish_reason: "tool_calls"` and a builtin_function tool_call whose
 * `arguments` carry an opaque `{search_result: {search_id}, usage}` blob.
 * The client must echo those arguments back as a `role: "tool"` message and
 * POST again; only the second response contains the grounded answer.
 * (Verified 2026-09 with kimi-k2.6 on api.moonshot.ai.)
 *
 * Vercel AI SDK can't take part in that exchange — its OpenAI-compat parser
 * rejects `type: 'builtin_function'`, and a builtin call isn't one of our
 * tools. So this module does the round-trip itself, below the SDK:
 *
 *   1. Filter each upstream SSE line: drop builtin_function tool_call
 *      entries (including their follow-up `arguments` chunks, which carry
 *      no `type`), remembering id/name/arguments.
 *   2. If the response finishes with only builtin calls, hold back the
 *      finish chunk + `[DONE]`, append the assistant tool_calls message and
 *      the echoing tool message to the request, re-POST, and splice the new
 *      response's lines into the same stream.
 *   3. The SDK sees one ordinary text stream: the search answer.
 *
 * A response that mixes builtin and ordinary function calls just has the
 * builtin entries stripped — the SDK runs our function tools as usual and
 * Kimi can search again on the next step.
 */

/** Max search round-trips per request. Kimi normally searches once. */
const MAX_SEARCH_ROUNDS = 3

interface BuiltinCall {
  id: string
  name: string
  args: string
}

/**
 * Stateful per-response line filter. One instance per upstream response —
 * builtin tool_call `arguments` arrive in later chunks keyed only by
 * `index`, so the filter has to remember which indexes were builtin.
 */
export function createKimiSearchFilter() {
  const builtinByIndex = new Map<number, BuiltinCall>()
  let sawFunctionCall = false
  let heldFinish = false
  let assistantText = ''

  function processLine(line: string): string | null {
    if (!line.startsWith('data: ')) return line
    const payload = line.slice(6)
    if (payload.trim() === '[DONE]') return heldFinish ? null : line
    if (payload.trim() === '') return line
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      return line // malformed JSON — pass through; parser will deal
    }
    if (!parsed || typeof parsed !== 'object') return line
    const choices = (parsed as { choices?: unknown[] }).choices
    if (!Array.isArray(choices)) return line

    let mutated = false
    for (const choice of choices) {
      if (!choice || typeof choice !== 'object') continue
      const c = choice as { delta?: Record<string, unknown>; finish_reason?: string | null }
      const delta = c.delta
      if (delta && typeof delta === 'object') {
        if (typeof delta.content === 'string') assistantText += delta.content
        const toolCalls = delta.tool_calls
        if (Array.isArray(toolCalls)) {
          const kept: unknown[] = []
          for (const tc of toolCalls) {
            const t = tc as {
              index?: number
              id?: string
              type?: string
              function?: { name?: string; arguments?: string }
            }
            const idx = typeof t?.index === 'number' ? t.index : -1
            if (t?.type === 'builtin_function') {
              builtinByIndex.set(idx, {
                id: t.id ?? `builtin_${idx}`,
                name: t.function?.name ?? '$web_search',
                args: t.function?.arguments ?? '',
              })
            } else if (!t?.type && builtinByIndex.has(idx)) {
              builtinByIndex.get(idx)!.args += t.function?.arguments ?? ''
            } else {
              if (t?.type === 'function') sawFunctionCall = true
              kept.push(tc)
            }
          }
          if (kept.length !== toolCalls.length) {
            mutated = true
            if (kept.length === 0) delete delta.tool_calls
            else delta.tool_calls = kept
          }
        }
      }
      if (c.finish_reason === 'tool_calls' && builtinByIndex.size > 0 && !sawFunctionCall) {
        heldFinish = true
        c.finish_reason = null
        mutated = true
      }
    }

    if (!mutated) return line
    // After stripping, drop the chunk unless something useful survived:
    // usage, a finish_reason, or any delta field besides a bare `role`.
    const keep =
      (parsed as { usage?: unknown }).usage != null ||
      choices.some((ch) => {
        const c = ch as { delta?: Record<string, unknown>; finish_reason?: string | null }
        if (c?.finish_reason) return true
        if (!c?.delta) return true
        return Object.keys(c.delta).some((k) => k !== 'role' && c.delta![k] != null)
      })
    return keep ? 'data: ' + JSON.stringify(parsed) : null
  }

  return {
    processLine,
    /** True once the response ended on builtin-only tool calls. */
    get needsFollowUp(): boolean {
      return heldFinish && builtinByIndex.size > 0
    },
    get builtinCalls(): BuiltinCall[] {
      return [...builtinByIndex.values()]
    },
    get assistantText(): string {
      return assistantText
    },
  }
}

/**
 * Single-line convenience wrapper (fresh filter per call) — keeps the old
 * pure-function contract for the smoke test.
 */
export function filterSseLine(line: string): string | null {
  return createKimiSearchFilter().processLine(line)
}

interface ChatRequestBody {
  messages?: unknown[]
  [k: string]: unknown
}

/** Request body for the next round: the assistant's builtin tool_calls
 *  plus one tool message per call echoing its arguments verbatim. */
export function buildFollowUpBody(
  body: ChatRequestBody,
  calls: BuiltinCall[],
  assistantText: string,
): ChatRequestBody {
  return {
    ...body,
    messages: [
      ...(body.messages ?? []),
      {
        role: 'assistant',
        content: assistantText,
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: 'builtin_function',
          function: { name: c.name, arguments: c.args },
        })),
      },
      ...calls.map((c) => ({
        role: 'tool',
        tool_call_id: c.id,
        name: c.name,
        content: c.args,
      })),
    ],
  }
}

/**
 * Wrap a streamed Kimi response. `followUp` supplies the parsed request
 * body and a way to re-POST it; without it, builtin calls are only
 * stripped (old behaviour).
 */
export function wrapKimiSearchResponse(
  response: Response,
  followUp?: {
    body: ChatRequestBody
    refetch: (body: ChatRequestBody) => Promise<Response>
  },
): Response {
  // Bail-outs: error responses (let the SDK see real errors), bodiless
  // responses, and non-streaming JSON (the chat path always streams).
  if (!response.body || !response.ok) return response
  const ct = response.headers.get('content-type') ?? ''
  if (!ct.toLowerCase().includes('text/event-stream')) return response

  const encoder = new TextEncoder()
  let current = response
  let body = followUp?.body
  let cancelled = false
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (let round = 0; ; round++) {
          const filter = createKimiSearchFilter()
          reader = current.body!.getReader()
          const decoder = new TextDecoder()
          let pending = '' // incomplete line carried across read() chunks
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            const text = pending + decoder.decode(value, { stream: true })
            // OpenAI-compat SSE puts each event on one `data:` line, so
            // splitting on `\n` is enough. Last segment = in-progress line.
            const lines = text.split('\n')
            pending = lines.pop() ?? ''
            const out: string[] = []
            for (const raw of lines) {
              const filtered = filter.processLine(raw)
              if (filtered !== null) out.push(filtered)
            }
            if (out.length > 0) controller.enqueue(encoder.encode(out.join('\n') + '\n'))
          }
          if (pending) {
            const filtered = filter.processLine(pending)
            if (filtered !== null) controller.enqueue(encoder.encode(filtered + '\n'))
          }
          if (cancelled) return

          if (!filter.needsFollowUp) break
          if (!followUp || !body || round + 1 >= MAX_SEARCH_ROUNDS) {
            // Can't (or won't) continue the search — end the stream cleanly
            // so the SDK finishes the step instead of hanging.
            controller.enqueue(
              encoder.encode(
                'data: ' +
                  JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
                  '\n\ndata: [DONE]\n\n',
              ),
            )
            break
          }
          body = buildFollowUpBody(body, filter.builtinCalls, filter.assistantText)
          console.log(`[kimi-search] search round ${round + 1} → re-POST with tool result`)
          current = await followUp.refetch(body)
          if (!current.ok || !current.body) {
            const detail = await current.text().catch(() => '')
            controller.enqueue(
              encoder.encode(
                'data: ' +
                  JSON.stringify({
                    error: {
                      message: `Kimi 联网搜索续传失败：${current.status} ${detail.slice(0, 200)}`,
                      type: 'kimi_search_followup_failed',
                    },
                  }) +
                  '\n\n',
              ),
            )
            break
          }
        }
        controller.close()
      } catch (err) {
        controller.error(err)
      }
    },
    cancel() {
      cancelled = true
      void reader?.cancel()
    },
  })

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}
