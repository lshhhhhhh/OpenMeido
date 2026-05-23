import type { ModelMessage } from 'ai'

import type { Episode } from '../../core/memory/types.js'

/**
 * Convert stored episodes into ModelMessage turns. Recent + recalled lists
 * are merged then sorted by id (creation order) so the model sees a coherent
 * timeline. Each recalled episode is silently included as a normal turn —
 * we deliberately don't mark them "from memory" to keep the model's voice
 * consistent.
 *
 * Speaker → role mapping:
 *   user      → { role: 'user', content: text-or-string }
 *   assistant → { role: 'assistant', content: [text, ...tool_calls] }
 *               If no toolParts, content is just the string.
 *   tool      → { role: 'tool', content: [...tool_results] }
 *               text is ignored (always empty for tool rows).
 *
 * Without this faithful replay, follow-up turns lose the tool_call_id ←→
 * tool_result_id linkage and the model has no way to reference past tool
 * outputs (the "open WWDC email" → AI re-lists instead of reading bug).
 */
export function episodesToMessages(
  episodes: Episode[],
  /** How many trailing image-bearing user turns get their images
   *  re-attached for the model. Older image-bearing turns are emitted
   *  as text-only. See cfg.memory.imageRecallTurns. */
  imageRecallTurns: number = 3,
): ModelMessage[] {
  // Drop silent screen-observation entries — they're "[obs] CS2 比赛,
  // Falcons 战队, ..." style private notes she wrote to herself about
  // what was on screen, NOT user-visible utterances. Including them in
  // chat replay would make the model think it had been speaking
  // observation lists aloud, confusing future turns. The notes still
  // flow into the screen-react path through a separate retrieval, and
  // L3 reflection picks them up to distill into facts.
  episodes = episodes.filter(
    (e) => !(e.speaker === 'assistant' && e.text.startsWith('[obs] ')),
  )
  const sorted = episodes.slice().sort((a, b) => a.id - b.id)

  // Decide which user episodes are "fresh enough" to replay their images.
  // We walk newest→oldest, keep the first N user turns that actually have
  // images, mark their episode ids. Older image-bearing turns lose their
  // images on replay (they keep only their text content).
  const replayImageEpisodeIds = new Set<number>()
  if (imageRecallTurns > 0) {
    let kept = 0
    for (let i = sorted.length - 1; i >= 0 && kept < imageRecallTurns; i--) {
      const e = sorted[i]!
      if (e.speaker === 'user' && e.images && e.images.length > 0) {
        replayImageEpisodeIds.add(e.id)
        kept++
      }
    }
  }

  // Build a tool_call_id → tool_result map by scanning ALL episodes. This
  // lets us emit each assistant's tool_calls and their matching tool
  // results adjacently — even if the row order in sqlite is wrong (e.g.,
  // an earlier persistence race wrote the tool row BEFORE the assistant
  // row, so id-sorted ordering would emit them out of OpenAI-spec order).
  //
  // Strict backends (Kimi, recent OpenAI) reject if an assistant message
  // with tool_calls isn't immediately followed by tool messages responding
  // to each call. The reorder below makes that adjacency invariant hold
  // regardless of how the rows landed.
  const resultByCallId = new Map<
    string,
    { toolCallId: string; toolName: string; output: unknown }
  >()
  // Track every tool_call_id that an assistant message claimed. Tool
  // results for ids NOT in this set are orphans (the call was never
  // persisted; we have a result but no caller). They get dropped.
  const claimedCallIds = new Set<string>()
  for (const e of sorted) {
    if (e.speaker === 'assistant') {
      for (const p of e.toolParts ?? []) {
        if (p.type === 'tool-call' && p.toolCallId) {
          claimedCallIds.add(p.toolCallId)
        }
      }
    } else if (e.speaker === 'tool') {
      for (const p of e.toolParts ?? []) {
        // Skip tool-result entries with empty toolCallId — past streaming
        // glitches occasionally persisted these and they're un-pairable.
        if (p.type === 'tool-result' && p.toolCallId) {
          resultByCallId.set(p.toolCallId, {
            toolCallId: p.toolCallId,
            toolName: p.toolName,
            output: p.output,
          })
        }
      }
    }
  }

  // Tool-result episodes we've already emitted as part of their owning
  // assistant message. The pass below skips them when it encounters them
  // in id order, since they were already paired up.
  const emittedResultIds = new Set<string>()

  const out: ModelMessage[] = []
  for (const e of sorted) {
    if (e.speaker === 'user') {
      // If this user turn is recent enough to keep its images, build a
      // multipart content array. Otherwise text-only (matches the
      // pre-image-cache behavior for older turns).
      if (replayImageEpisodeIds.has(e.id) && e.images && e.images.length > 0) {
        out.push({
          role: 'user',
          content: [
            { type: 'text' as const, text: e.text },
            ...e.images.map((img) => ({
              type: 'image' as const,
              image: Buffer.from(img.base64, 'base64'),
              mediaType: img.mimeType,
            })),
          ],
        } as ModelMessage)
      } else {
        out.push({ role: 'user', content: e.text })
      }
      continue
    }
    if (e.speaker === 'tool') {
      // Only emit if (a) results weren't already paired with their owning
      // assistant above, (b) the toolCallId is non-empty, (c) some
      // assistant actually claimed this call id. Without (c) the API
      // rejects with "tool_call_id is not found".
      const surviving = (e.toolParts ?? []).filter(
        (p): p is Extract<typeof p, { type: 'tool-result' }> =>
          p.type === 'tool-result' &&
          !!p.toolCallId &&
          claimedCallIds.has(p.toolCallId) &&
          !emittedResultIds.has(p.toolCallId),
      )
      if (surviving.length === 0) continue
      out.push({
        role: 'tool',
        content: surviving.map((r) => ({
          type: 'tool-result' as const,
          toolCallId: r.toolCallId,
          toolName: r.toolName,
          output: {
            type: 'json' as const,
            value: r.output as unknown as Parameters<
              typeof JSON.stringify
            >[0],
          },
        })),
      } as ModelMessage)
      continue
    }
    // Assistant: keep only tool_calls that (a) have a non-empty id and
    // (b) have a matching result somewhere on disk. Empty-id calls and
    // orphans both get downgraded to plain text so they don't poison
    // the next API call.
    const calls = (e.toolParts ?? []).filter(
      (p): p is Extract<typeof p, { type: 'tool-call' }> =>
        p.type === 'tool-call' &&
        !!p.toolCallId &&
        resultByCallId.has(p.toolCallId),
    )
    if (calls.length === 0) {
      out.push({ role: 'assistant', content: e.text })
      continue
    }
    const parts: ({ type: 'text'; text: string } | {
      type: 'tool-call'
      toolCallId: string
      toolName: string
      input: unknown
    })[] = []
    if (e.text) parts.push({ type: 'text', text: e.text })
    for (const c of calls) {
      parts.push({
        type: 'tool-call',
        toolCallId: c.toolCallId,
        toolName: c.toolName,
        input: c.input,
      })
    }
    out.push({ role: 'assistant', content: parts })

    // IMMEDIATELY emit the matching tool message — required by OpenAI
    // spec, enforced strictly by Kimi. We pull results from the lookup
    // map so reversed-row-order history still produces correct output.
    out.push({
      role: 'tool',
      content: calls.map((c) => {
        const r = resultByCallId.get(c.toolCallId)!
        emittedResultIds.add(c.toolCallId)
        return {
          type: 'tool-result' as const,
          toolCallId: r.toolCallId,
          toolName: r.toolName,
          output: {
            type: 'json' as const,
            value: r.output as unknown as Parameters<
              typeof JSON.stringify
            >[0],
          },
        }
      }),
    } as ModelMessage)
  }
  return out
}
