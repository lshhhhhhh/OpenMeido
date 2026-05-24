/**
 * Combined emotion + affinity classifier.
 *
 * Runs ONE lightweight LLM call after each chat exchange that returns:
 *   - the emotion ${persona.name} should display (drives Live2D)
 *   - the affinity delta the user's behavior earned with this persona
 *     (drives the relationship tier)
 *
 * Replaces what used to be two separate calls. Failure mode: if the JSON
 * parse fails we still try to extract an emotion label from the raw
 * output (robust regex), and default affinity_delta to 0 — better to
 * lose half the signal than both.
 *
 * The pure resolution-to-command logic lives in ./emotion-apply.ts so
 * unit tests can exercise it without electron / network. This file
 * does the LLM round-trip + wires production deps.
 */

import { runExtraction } from './chat-host.js'
import { broadcastLive2D } from './live2d-host.js'
import { getConfig } from './config.js'
import { resolvePersona } from '../shared/config.js'
import { getSidecar as live2dGetSidecar } from './live2d-models-host.js'
import { EMOTIONS, type Emotion } from '../shared/live2d-models.js'
import { buildCombinedClassifierPrompt } from '../shared/daily-prompts.js'
import { pushEmotionEvent } from './emotion-events.js'
import { applyEmotion } from './emotion-apply.js'
import { applyJudgement, currentTier } from './affinity-host.js'

/** Below this length we assume the reply is too short to carry useful
 *  emotion signal (e.g., "嗯", "好的"). Skip the round-trip. */
const MIN_TEXT_LEN_FOR_CLASSIFICATION = 6

interface JudgeResult {
  emotion: Emotion | null
  affinityDelta: number
  reason: string
}

/** Last emotion the classifier landed on, keyed by persona id. Fed into
 *  the next classifier prompt so the LLM avoids picking the same label
 *  twice in a row (which is a visual no-op on the Live2D side). */
const lastEmotionByPersona = new Map<string, Emotion>()

/**
 * Public entry — call after the chat stream finishes. Fire-and-forget;
 * errors are swallowed (logged only).
 *
 * `userText` is the most recent user message; needed for affinity
 * judgement (which is about the USER's behavior, not the maid's reply).
 * Pass empty string when called from greeting / proactive — those don't
 * have a user message to judge against and the affinity update is
 * skipped naturally because no delta makes sense.
 */
export async function classifyAndApply(
  assistantText: string,
  userText: string = '',
  opts: {
    /** Skip the setExpression broadcast — emotion was already applied
     *  upstream (e.g. main chat baked a `<emo>` tag the chat loop
     *  consumed). Affinity still runs. */
    skipEmotion?: boolean
    /** Skip the affinity judgment + write. Set this for work turns
     *  (email summary, file read, task add) where judging "user warmth"
     *  from a tool request would be noise. The classifier still runs
     *  for emotion unless skipEmotion is also true. */
    skipAffinity?: boolean
  } = {},
): Promise<void> {
  const trimmed = assistantText.trim()
  if (trimmed.length < MIN_TEXT_LEN_FOR_CLASSIFICATION) return

  const cfg = getConfig()
  const persona = resolvePersona(cfg.persona)
  const personaId = cfg.persona.preset
  const tier = currentTier(personaId)
  let raw: string
  try {
    raw = await runExtraction(
      buildCombinedClassifierPrompt({
        userText: userText.trim(),
        assistantText: trimmed,
        persona,
        validLabels: EMOTIONS,
        currentAffinity: tier.min, // approximation; engine has the precise value
        tierLabel: tier.zhLabel,
        lastEmotion: lastEmotionByPersona.get(personaId) ?? null,
      }),
      { feature: 'classifier' },
    )
  } catch (err) {
    console.warn('[classifier] LLM call failed:', err)
    return
  }
  const result = parseJudgeResult(raw)
  // "每句都有表情" intent: if the model disregards the prompt and emits
  // 中性 / unknown / parse-fails, don't blank the face — fall back to a
  // default positive label so the Live2D figure stays alive. 开心 is the
  // safest generic warm expression across all sidecar mappings.
  const emotion = result.emotion ?? '开心'
  lastEmotionByPersona.set(personaId, emotion)
  if (!opts.skipEmotion) {
    await applyEmotion(emotion, {
      send: broadcastLive2D,
      pushEvent: pushEmotionEvent,
      sidecarFor: live2dGetSidecar,
      modelName: cfg.live2d.activeModel,
      // Pass reply length so the auto-decay scales: short giggle clears
      // in ~3s, 30-char reply ~8s, long monologue up to 25s.
      textLength: trimmed.length,
    })
  }
  // Affinity only when we have user context (chat path) AND this isn't
  // a work-mode turn. Greeting / proactive emit assistant text with no
  // preceding user turn; tool-using turns are productivity tasks. In
  // both cases judging warmth would be noise.
  if (!opts.skipAffinity && userText.trim() && result.affinityDelta !== 0) {
    void applyJudgement(personaId, result.affinityDelta, result.reason)
  }
  console.log(
    `[classifier] → emotion=${result.emotion ?? '中性'} Δaffinity=${result.affinityDelta} (${result.reason})`,
  )
}

/**
 * Backward-compat shim. Anything that used the old name keeps working
 * during the transition; once all callers migrate to classifyAndApply
 * with explicit userText this can be removed.
 */
export async function classifyAndApplyEmotion(text: string): Promise<void> {
  return classifyAndApply(text, '')
}

/**
 * Parse the JSON judge output. Tolerant of:
 *   - fenced blocks: ```json\n{...}\n```
 *   - embedded JSON in prose: "Here's my answer: {...}"
 *   - bare JSON
 *   - JSON with extra keys (we ignore them)
 *
 * If JSON parsing fails entirely, fall back to: regex-extracting an
 * emotion label from the raw text and returning delta=0. Better to keep
 * the face working than to lose both signals.
 */
function parseJudgeResult(raw: string): JudgeResult {
  // 1. Try strict JSON modes.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const tryStrings = [fenced?.[1], extractFirstJsonObject(raw), raw].filter(
    (s): s is string => typeof s === 'string',
  )
  for (const s of tryStrings) {
    try {
      const obj = JSON.parse(s) as Record<string, unknown>
      const emotion = parseEmotionLabel(typeof obj.emotion === 'string' ? obj.emotion : '')
      const rawDelta = typeof obj.affinity_delta === 'number' ? obj.affinity_delta : 0
      const reason =
        typeof obj.reason === 'string' ? obj.reason.slice(0, 50) : ''
      return { emotion, affinityDelta: clampToTwo(rawDelta), reason }
    } catch {
      /* try next form */
    }
  }
  // 2. Fallback: regex-extract emotion only.
  const emotion = parseEmotionLabel(raw)
  return { emotion, affinityDelta: 0, reason: '(parse failed)' }
}

function clampToTwo(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n > 2) return 2
  if (n < -2) return -2
  return Math.trunc(n)
}

/** Find the first top-level {...} block in a string, balancing braces. */
function extractFirstJsonObject(s: string): string | null {
  const start = s.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]!
    if (inString) {
      if (escape) {
        escape = false
      } else if (c === '\\') {
        escape = true
      } else if (c === '"') {
        inString = false
      }
      continue
    }
    if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return null
}

/**
 * Pull a clean emotion label out of arbitrary text. Tolerates extra
 * whitespace, quotes, punctuation. Unknown outputs → null (= 中性).
 */
function parseEmotionLabel(raw: string): Emotion | null {
  const stripped = raw
    .trim()
    .replace(/^["'「『]+|["'」』]+$/g, '')
    .replace(/[.。!！?？:：,，]+$/g, '')
    .trim()
  if (!stripped) return null
  if ((EMOTIONS as readonly string[]).includes(stripped)) {
    return stripped as Emotion
  }
  for (const e of EMOTIONS) {
    if (stripped.includes(e)) return e
  }
  return null
}

/** Exported for tests. */
export const __testing = { parseEmotionLabel, parseJudgeResult, extractFirstJsonObject }
