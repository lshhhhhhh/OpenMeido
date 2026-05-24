import { EMOTIONS, type Emotion } from '../../shared/live2d-models.js'
import { applyEmotion } from '../emotion-apply.js'
import { broadcastLive2D } from '../live2d-host.js'
import { getSidecar as live2dGetSidecar } from '../live2d-models-host.js'
import { pushEmotionEvent } from '../emotion-events.js'
import { getConfig } from '../config.js'

/**
 * One-shot text cleaner for persistence — strips `<think>` blocks and stray
 * tool-call XML from a complete string. Separate from the streaming
 * createTextDeltaFilter() because that one's stateful for live streaming;
 * here we have the full text in hand and can use plain regexes.
 */
export function cleanInlineText(s: string): string {
  return s
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:html|xml)?\s*<\/?(?:tool_call|arg_key|arg_value)[\s\S]*?```/gi, '')
    .replace(/<\/?(?:tool_call|arg_key|arg_value)(?:\s[^>]*)?>/gi, '')
    // Same orphan-trailing-backticks fix as the streaming filter — if a
    // reply persists with stray "``" / "```" at the end, both the chat
    // bubble and the replayed history would surface them. Strip 2+
    // backticks at the tail; preserve single backtick (inline code).
    .replace(/[ \t\r\n]*`{2,}[ \t\r\n]*$/, '')
    .trim()
}

/**
 * Pull the model's self-classified emotion out of its raw output. The
 * model is instructed to bake `<emo>X</emo>` at the end of its final
 * reply; this regex extracts the label and validates it against the
 * known vocabulary. Returns null when the tag is missing or holds an
 * unknown label (caller falls back to the post-reply classifier).
 */
const BAKED_EMOTION_RE = /<emo>\s*([^<>\s]+)\s*<\/emo>/i
export function extractBakedEmotion(raw: string): Emotion | null {
  const m = raw.match(BAKED_EMOTION_RE)
  if (!m) return null
  const label = m[1]!.trim()
  if ((EMOTIONS as readonly string[]).includes(label)) return label as Emotion
  return null
}

/** Apply a baked emotion the same way the classifier would. Mirrors
 *  classifier deps so behavior stays consistent. `textLength` scales
 *  the auto-decay duration — pass the assistant reply's character
 *  count (excluding tool noise) so the face matches the spoken length. */
export async function applyBakedEmotion(
  emotion: Emotion,
  _personaId: string,
  textLength?: number,
): Promise<void> {
  const cfg = getConfig()
  await applyEmotion(emotion, {
    send: broadcastLive2D,
    pushEvent: pushEmotionEvent,
    sidecarFor: live2dGetSidecar,
    modelName: cfg.live2d.activeModel,
    textLength,
  })
}
