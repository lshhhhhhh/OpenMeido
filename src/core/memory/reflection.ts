/**
 * L3 fact reflection. Periodically asks the LLM to distill stable facts
 * about the USER from a window of recent episodic memory, then upserts
 * those facts into the L3 store.
 *
 * Design choices:
 * - Cross-platform: this module knows nothing about Electron, the AI SDK,
 *   or which LLM provider is wired up. The host injects an `extract`
 *   function that takes a prompt + episode block and returns parsed JSON.
 * - The model gets a tight, schema'd prompt and is asked for either a
 *   bare array or `{"facts": [...]}`. We tolerate both, plus fenced code
 *   blocks (`\`\`\`json ... \`\`\``), to absorb the variance across
 *   providers — Gemini sometimes adds a preamble, LM Studio sometimes
 *   wraps in fences.
 * - On parse failure we retry up to 3 times. If all attempts fail we
 *   skip this reflection cycle — the next user turn will trigger another
 *   one, so eventual consistency is fine.
 */

import type { Episode, NewFact } from './types.js'

/**
 * Pluggable LLM extractor. Host wires this to whichever chat model is
 * configured. Should return the model's raw text — this module parses.
 *
 * The prompt the host receives is self-contained: full system text + the
 * episode block. The host only needs to forward it.
 */
export type ReflectionExtractor = (prompt: string) => Promise<string>

export interface ReflectionOptions {
  /** Maximum recent episodes to feed in one reflection call. */
  windowSize?: number
  /** How many times to retry on a parse failure before giving up this cycle. */
  maxRetries?: number
}

const DEFAULT_WINDOW = 12
const DEFAULT_RETRIES = 3

const PERSONAL_PROMPT_HEADER = `你是桌面伴侣的记忆整理助手。从下面这段最近对话里，提取关于**用户**的稳定事实，输出 JSON。

规则：
1. 只提取关于用户本身的客观事实，不要主观判断（×"用户脾气好"，○"用户养了一只猫"）。
2. 只提取在未来对话里仍然有用的稳定信息（姓名、宠物、爱好、职业、关系、所在地、设备、习惯）。
3. 不要提取一次性事件（"今天加班"、"刚吃了饭"）—— 这些属于 episodic 而非 fact。
4. key 用点分层级的全小写英文，例：user.profile.name / user.pets.cat.name / user.work.role
5. value 用简短的中文短语（不超过 30 字），不要完整句子。
6. confidence ∈ [0.0, 1.0]：用户明确说过 → 0.9-1.0；隐含推断 → 0.5-0.8；不确定 → 不要输出
7. 如果没有可提取的，输出空数组 []
8. 如果用户在对话中明确否定、撤回、纠正或驳回了某个已知事实（例如：用户说"我没有猫"、"别叫我小李了"），你必须将该事实的 key 提取出来，并将其 value 设置为 "DELETE"（必须是全大写），confidence 设为 1.0，以指示该事实应该被系统清除。

输出格式（**只输出 JSON，不要解释**）：
[
  {"key": "user.profile.name", "value": "小李", "confidence": 0.95},
  {"key": "user.pets.cat.name", "value": "阿黄", "confidence": 0.9}
]

或者：{"facts": [ ... 同样格式 ... ]}

`

/**
 * Build the full reflection prompt for a given episode window.
 *
 * `existingFactsBlock`, when provided, is fed in BEFORE the episode
 * window with a "you already know these" framing. Without it, the
 * model re-extracts the same facts every cycle (sometimes with
 * slightly different keys: `user.name` vs `user.profile.name`) and
 * the facts table accumulates near-duplicates that supersession
 * can't merge. With it, the model is steered to only emit NEW or
 * CONTRADICTING facts (or DELETE markers when retracted).
 *
 * Exported so callers can preview it (e.g., for debug logging).
 */
export function buildReflectionPrompt(
  episodes: Episode[],
  existingFactsBlock?: string,
): string {
  const renderEpisode = (e: Episode): string => {
    const who =
      e.speaker === 'user' ? '用户' : e.speaker === 'tool' ? '工具结果' : '助手'
    const toolHint =
      e.toolParts && e.toolParts.length > 0
        ? ` [工具: ${e.toolParts
            .map((p) => ('toolName' in p ? p.toolName : '?'))
            .join(',')}]`
        : ''
    return `[${who}${toolHint}] ${e.text}`
  }
  const block = episodes.map(renderEpisode).join('\n')
  const knownBlock = existingFactsBlock?.trim()
    ? `\n[已知事实 — 不要重复抽取这些，只输出新增或矛盾的]\n${existingFactsBlock.trim()}\n`
    : ''
  return `${PERSONAL_PROMPT_HEADER}${knownBlock}\n最近对话：\n${block}\n`
}

/**
 * Strip optional fences / preamble and parse. Accepts:
 *   - bare JSON array
 *   - bare {"facts": [...]} object
 *   - ```json … ``` fenced block
 *   - object with surrounding prose (extract the first balanced JSON value)
 * Returns null on any failure so the caller can retry.
 */
export function parseReflectionResponse(raw: string): NewFact[] | null {
  if (!raw) return null
  let text = raw.trim()
  // Strip fenced code if present.
  const fenced = text.match(/```(?:json)?\s*([\s\S]+?)```/i)
  if (fenced) text = fenced[1]!.trim()

  const candidates: string[] = [text]
  // If text contains prose, try to isolate the first array or object.
  const arrayMatch = text.match(/\[\s*[\s\S]*\]/)
  const objMatch = text.match(/\{[\s\S]*\}/)
  if (arrayMatch) candidates.push(arrayMatch[0])
  if (objMatch) candidates.push(objMatch[0])

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c)
      const items = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { facts?: unknown }).facts)
          ? (parsed as { facts: unknown[] }).facts
          : null
      if (!items) continue
      const facts: NewFact[] = []
      for (const item of items) {
        if (!item || typeof item !== 'object') continue
        const obj = item as { key?: unknown; value?: unknown; confidence?: unknown }
        if (typeof obj.key !== 'string' || typeof obj.value !== 'string') continue
        const key = obj.key.trim()
        const value = obj.value.trim()
        if (!key || !value) continue
        const conf =
          typeof obj.confidence === 'number' && Number.isFinite(obj.confidence)
            ? Math.max(0, Math.min(1, obj.confidence))
            : 0.7
        facts.push({ key, value, confidence: conf })
      }
      return facts
    } catch {
      /* try next candidate */
    }
  }
  return null
}

/**
 * Run one reflection pass against the given episode window. Returns the
 * extracted facts (already shape-validated). Empty array on no signal,
 * null on extractor failure after all retries.
 */
export async function reflect(
  episodes: Episode[],
  extract: ReflectionExtractor,
  opts: ReflectionOptions & {
    existingFactsBlock?: string
  } = {},
): Promise<NewFact[] | null> {
  const windowSize = opts.windowSize ?? DEFAULT_WINDOW
  const maxRetries = opts.maxRetries ?? DEFAULT_RETRIES
  const window = episodes.slice(-windowSize)
  if (window.length === 0) return []
  const prompt = buildReflectionPrompt(window, opts.existingFactsBlock)
  let lastErr: unknown
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const raw = await extract(prompt)
      const parsed = parseReflectionResponse(raw)
      if (parsed) {
        // Tag every fact with the source episode ids so we can audit later.
        const ids = window.map((e) => e.id)
        return parsed.map((f) => ({ ...f, sourceEpisodeIds: ids }))
      }
    } catch (err) {
      lastErr = err
    }
  }
  if (lastErr) console.warn('[reflection] extract failed:', lastErr)
  return null
}

/**
 * Render the fact set into a system-prompt block. Skips low-confidence
 * facts so noisy guesses don't poison the model's worldview. Returns an
 * empty string when there's nothing to inject (no leading "[]" or header
 * — caller can concatenate without worrying about extra whitespace).
 */
export function renderFactsBlock(
  facts: { key: string; value: string; confidence: number }[],
  minConfidence = 0.5,
  header = '[关于用户的已知事实]',
): string {
  const usable = facts.filter((f) => f.confidence >= minConfidence)
  if (usable.length === 0) return ''
  const lines = usable.map((f) => `- ${f.key}: ${f.value}`).join('\n')
  return `${header}\n${lines}\n`
}
