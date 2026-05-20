#!/usr/bin/env node
/**
 * Quick existence-check for every (baseUrl, model) pair we ship in the
 * tier table. Sends a 1-token "hi" to each; reports OK / 4xx / network.
 *
 * Run: node --env-file=.env tools/probe-tier-models.mjs
 */

const TESTS = [
  // OpenAI
  { env: 'OPENAI_API_KEY', base: 'https://api.openai.com/v1', model: 'gpt-5.4-mini', tier: 'fast' },
  { env: 'OPENAI_API_KEY', base: 'https://api.openai.com/v1', model: 'gpt-5.5', tier: 'perf' },
  // Gemini (OpenAI-compat shim)
  { env: 'GEMINI_API_KEY', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.5-flash', tier: 'fast' },
  { env: 'GEMINI_API_KEY', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.1-pro-preview', tier: 'perf/vision' },
  // GLM
  { env: 'ZHIPU_API_KEY', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.6v-flash', tier: 'fast' },
  { env: 'ZHIPU_API_KEY', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.1', tier: 'perf' },
  { env: 'ZHIPU_API_KEY', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.6v', tier: 'vision' },
  // DeepSeek
  { env: 'DEEPSEEK_API_KEY', base: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash', tier: 'fast' },
  { env: 'DEEPSEEK_API_KEY', base: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro', tier: 'perf' },
  // Qwen (dashscope)
  { env: 'DASHSCOPE_API_KEY', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3-vl-flash', tier: 'fast' },
  { env: 'DASHSCOPE_API_KEY', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3-vl-plus', tier: 'perf/vision' },
  // Kimi 国际 (we have a .ai key)
  { env: 'MOONSHOT_API_KEY', base: 'https://api.moonshot.ai/v1', model: 'kimi-k2.5', tier: 'fast' },
  { env: 'MOONSHOT_API_KEY', base: 'https://api.moonshot.ai/v1', model: 'kimi-k2.6', tier: 'perf/vision' },
]

async function probe({ env, base, model, tier }) {
  const apiKey = process.env[env]
  if (!apiKey) return { model, tier, status: 'SKIP', detail: `${env} not set` }
  const isKimi = base.includes('moonshot')
  // OpenAI's gpt-5 series rejects the older `max_tokens` and requires
  // `max_completion_tokens`. Other providers still accept max_tokens, so
  // branch on host.
  const isOpenAI = base.includes('openai.com') && !base.includes('moonshot')
  const tokenLimitField = isOpenAI ? 'max_completion_tokens' : 'max_tokens'
  const body = {
    model,
    messages: [{ role: 'user', content: 'hi' }],
    [tokenLimitField]: 5,
    // Kimi requires temperature exactly 0.6 on certain models; harmless
    // for others, so pin it everywhere for a uniform probe.
    temperature: 0.6,
    ...(isKimi ? { thinking: { type: 'disabled' } } : {}),
  }
  try {
    const resp = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!resp.ok) {
      const txt = await resp.text()
      let msg = txt.slice(0, 200)
      try {
        const err = JSON.parse(txt)
        msg = err.error?.message ?? err.message ?? msg
      } catch {}
      return { model, tier, status: `HTTP ${resp.status}`, detail: msg }
    }
    const data = await resp.json()
    const reply = data.choices?.[0]?.message?.content ?? ''
    return { model, tier, status: 'OK', detail: `→ "${(reply || '').replace(/\n/g, ' ').slice(0, 40)}"` }
  } catch (err) {
    return { model, tier, status: 'ERROR', detail: err.message ?? String(err) }
  }
}

async function main() {
  console.log('Probing tier models — 1 message each, max_tokens=5\n')
  const results = []
  for (const t of TESTS) {
    process.stdout.write(`${t.model.padEnd(30)} (${t.tier.padEnd(11)}) ... `)
    const r = await probe(t)
    results.push(r)
    const icon = r.status === 'OK' ? '✅' : r.status === 'SKIP' ? '⏭ ' : '❌'
    console.log(`${icon} ${r.status} ${r.detail}`)
  }
  const failed = results.filter((r) => r.status !== 'OK' && r.status !== 'SKIP')
  const ok = results.filter((r) => r.status === 'OK')
  console.log(`\n${ok.length} ok · ${failed.length} fail · ${results.length - ok.length - failed.length} skip`)
}
main()
