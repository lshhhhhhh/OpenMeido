/**
 * Per-provider lightweight text-only model picker for "side LLM tasks":
 *
 *   - emotion classification (every reply)
 *   - greeting line (once per launch)
 *   - reminder line (when a fire-at task triggers)
 *   - proactive observer (idle-remark gate + line)
 *   - notification gate (toast → speak or skip)
 *   - L3 reflection (extract facts from history)
 *
 * These tasks fire alongside or instead of the main chat. Using the
 * user's flagship model for each would double cost and add latency.
 * Lightweight tiers are plenty capable for classification or
 * 1-2 sentence generation.
 *
 * Lives in shared/ so both the main process (which actually invokes the
 * side calls) and the renderer (which might surface model info in
 * Settings) can read the mapping.
 *
 * Returns null when no good lightweight tier exists for the host —
 * e.g., LM Studio runs whatever model the user loaded, so we use that
 * for both chat and side tasks.
 */

const LIGHTWEIGHT_MODEL_BY_HOST: { match: (url: string) => boolean; model: string }[] = [
  { match: (u) => u.includes('openai.com'), model: 'gpt-5.4-mini' },
  { match: (u) => u.includes('googleapis.com'), model: 'gemini-2.5-flash' },
  { match: (u) => u.includes('anthropic.com'), model: 'claude-haiku-4-5' },
  { match: (u) => u.includes('bigmodel.cn'), model: 'glm-4.6v-flash' },
  { match: (u) => u.includes('deepseek.com'), model: 'deepseek-v4-flash' },
  { match: (u) => u.includes('dashscope.aliyuncs.com'), model: 'qwen3-vl-flash' },
  {
    match: (u) => u.includes('volces.com') || u.includes('ark.cn-beijing'),
    model: 'doubao-1-5-vision-pro-32k-250115',
  },
  // Kimi 国内 has kimi-k2-turbo-preview (text-only, cheap/fast); 国际 doesn't
  // expose that tier, so fall back to kimi-k2.5 there.
  { match: (u) => u.includes('moonshot.cn'), model: 'kimi-k2-turbo-preview' },
  { match: (u) => u.includes('moonshot.ai'), model: 'kimi-k2.5' },
]

export function lightweightModel(baseUrl: string): string | null {
  for (const entry of LIGHTWEIGHT_MODEL_BY_HOST) {
    if (entry.match(baseUrl)) return entry.model
  }
  return null
}
