/**
 * Unit smoke test for src/main/openai-compat-body.ts.
 *
 * Verifies the per-provider body mutations (GLM web_search inject,
 * Kimi thinking-disable, DeepSeek reasoning_content fill) without
 * touching any network. Run: node --import tsx tools/smoke-openai-compat-body.mjs
 */
import { transformOpenAIBody, needsBodyTransform } from '../src/main/openai-compat-body.ts'

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name} :: ${detail}`)
  }
}

// ---- needsBodyTransform ----
check('no flags → no wrap', needsBodyTransform({}) === false)
check('any flag → wrap', needsBodyTransform({ isKimi: true }) === true)

// ---- GLM web_search inject into empty tools ----
{
  const body = {}
  transformOpenAIBody(body, { injectGlmSearch: true })
  check(
    'GLM injects web_search into missing tools',
    Array.isArray(body.tools) && body.tools.length === 1 && body.tools[0].type === 'web_search',
    JSON.stringify(body),
  )
}

// ---- GLM web_search appended to existing tools ----
{
  const body = { tools: [{ type: 'function', function: { name: 'foo' } }] }
  transformOpenAIBody(body, { injectGlmSearch: true })
  check(
    'GLM appends without overwriting existing tools',
    body.tools.length === 2 && body.tools[1].type === 'web_search',
    JSON.stringify(body),
  )
}

// ---- Kimi thinking disabled ----
{
  const body = {}
  transformOpenAIBody(body, { isKimi: true })
  check('Kimi forces thinking disabled', body.thinking?.type === 'disabled')
}

// ---- DeepSeek fills reasoning_content on assistant tool_calls ----
{
  const body = {
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', tool_calls: [{ id: 'a' }] },
      { role: 'tool', content: 'r' },
      { role: 'assistant', tool_calls: [{ id: 'b' }], reasoning_content: 'kept' },
      { role: 'assistant', content: 'no tools — left alone' },
    ],
  }
  transformOpenAIBody(body, { isDeepSeek: true })
  check('DeepSeek fills empty reasoning_content', body.messages[1].reasoning_content === '')
  check('DeepSeek leaves existing reasoning_content alone', body.messages[3].reasoning_content === 'kept')
  check(
    'DeepSeek does not add reasoning_content to non-tool-call assistant',
    body.messages[4].reasoning_content === undefined,
  )
}

// ---- Combined flags compose ----
{
  const body = { messages: [{ role: 'assistant', tool_calls: [{}] }] }
  transformOpenAIBody(body, { injectGlmSearch: true, isKimi: true, isDeepSeek: true })
  check('combined: GLM tool added', body.tools?.[0]?.type === 'web_search')
  check('combined: Kimi thinking disabled', body.thinking?.type === 'disabled')
  check('combined: DeepSeek filled reasoning_content', body.messages[0].reasoning_content === '')
}

// ---- No flag → no mutation ----
{
  const body = { messages: [{ role: 'assistant', tool_calls: [{}] }] }
  const snapshot = JSON.stringify(body)
  transformOpenAIBody(body, {})
  check('no flags → body unchanged', JSON.stringify(body) === snapshot)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
