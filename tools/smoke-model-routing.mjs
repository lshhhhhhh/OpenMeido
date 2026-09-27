#!/usr/bin/env node
/**
 * Offline smoke for the v0.4.0 LLM-plumbing fixes. No network, no Electron.
 *
 *   - lightweight-models: side-task model pick + fallback, vision
 *     routing, "model unavailable" detection, temperature constraints
 *   - config-migrations: retired-model remap, lenient parse
 *   - llm-errors: provider error → actionable Chinese message
 *   - kimi-search-stream: builtin $web_search round-trip spliced into one
 *     SSE stream
 *   - llm-fetch: transient 429 retry (but never on "no balance")
 *
 * Run: npm run test:model-routing
 */

const {
  pickSideTaskModel,
  supportsVision,
  isModelUnavailableError,
  resolveTemperature,
} = await import('../src/shared/lightweight-models.ts')
const { migrateRetiredModels, runConfigMigrations, parseConfigLenient } = await import(
  '../src/shared/config-migrations.ts'
)
const { configSchema, isLocalEndpoint, isBackendConfigured } = await import(
  '../src/shared/config.ts'
)
const { friendlyLlmError } = await import('../src/main/llm-errors.ts')
const { createKimiSearchFilter, buildFollowUpBody, wrapKimiSearchResponse } = await import(
  '../src/main/chat/kimi-search-stream.ts'
)
const { fetchWithTransientRetry } = await import('../src/main/llm-fetch.ts')

let passed = 0
let failed = 0
function check(label, cond, extra = '') {
  if (cond) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`)
    failed++
  }
}

const KIMI_CN = 'https://api.moonshot.cn/v1'
const KIMI_AI = 'https://api.moonshot.ai/v1'
const GLM = 'https://open.bigmodel.cn/api/paas/v4'
const DS = 'https://api.deepseek.com/v1'
const LOCAL = 'http://127.0.0.1:1234/v1'
const ARK = 'https://ark.cn-beijing.volces.com/api/v3'

console.log('\n[pickSideTaskModel]')
check('kimi cn → kimi-k2.6 (turbo-preview retired)', pickSideTaskModel({ baseUrl: KIMI_CN, userModel: 'kimi-k2.6' }) === 'kimi-k2.6')
check('deepseek → deepseek-flash', pickSideTaskModel({ baseUrl: DS, userModel: 'deepseek-v4-pro' }) === 'deepseek-flash')
check('override wins', pickSideTaskModel({ baseUrl: GLM, userModel: 'glm-5.1', override: ' glm-4.7 ' }) === 'glm-4.7')
check(
  'unavailable lightweight → user model',
  pickSideTaskModel({ baseUrl: GLM, userModel: 'glm-5.1', unavailable: new Set(['glm-4.6v-flash']) }) === 'glm-5.1',
)
check('unknown host → user model', pickSideTaskModel({ baseUrl: LOCAL, userModel: 'qwen/qwen3-vl-30b' }) === 'qwen/qwen3-vl-30b')
check(
  'needVision + text-only override → host vision tier',
  pickSideTaskModel({ baseUrl: GLM, userModel: 'glm-5.1', override: 'glm-4.7', needVision: true }) === 'glm-4.6v',
)
check(
  'needVision + text-only override → user model when it can see',
  pickSideTaskModel({ baseUrl: GLM, userModel: 'glm-4.6v', override: 'glm-4.7', needVision: true }) === 'glm-4.6v',
)

console.log('\n[supportsVision]')
for (const [url, id, want] of [
  [GLM, 'glm-5.1', false],
  [GLM, 'glm-4.5-air', false],
  [GLM, 'glm-4.6v', true],
  [GLM, 'glm-4.6v-flash', true],
  [GLM, 'glm-5.3-flash', true],
  [GLM, 'glm-5v-turbo', true],
  [DS, 'deepseek-v4-pro', false],
  [DS, 'deepseek-flash', true],
  [KIMI_AI, 'kimi-k2.7-code-highspeed', false],
  [KIMI_AI, 'kimi-k3', true],
  ['https://api.openai.com/v1', 'gpt-5.5', true],
  [LOCAL, 'anything', true],
]) {
  check(`${id} @ ${new URL(url).host} → ${want}`, supportsVision(url, id) === want)
}

console.log('\n[isModelUnavailableError]')
const unavailable = [
  { statusCode: 404, message: 'The model `gpt-9` does not exist or you do not have access to it.' },
  { statusCode: 404, message: 'Not found the model kimi-k2.5 or Permission denied' },
  { statusCode: 400, message: 'Bad Request', responseBody: '{"error":{"code":"1211","message":"模型不存在，请检查模型代码。"}}' },
  { statusCode: 400, message: 'Model Not Exist' },
  { statusCode: 404, message: 'models/gemini-9-flash is not found for API version v1beta, or is not supported for generateContent.' },
  { statusCode: 400, message: 'The model kimi-k2-turbo-preview has been deprecated' },
]
for (const e of unavailable) check(`yes: ${e.message.slice(0, 50)}`, isModelUnavailableError(e))
const available = [
  { statusCode: 429, message: 'Rate limit reached for requests' },
  { statusCode: 401, message: 'Invalid Authentication' },
  { statusCode: 429, message: '{"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}' },
  { statusCode: 400, message: "messages.content.type 参数非法，取值范围 ['text']" },
  { statusCode: 404, message: 'Not Found' },
]
for (const e of available) check(`no: ${e.message.slice(0, 50)}`, !isModelUnavailableError(e))

console.log('\n[resolveTemperature]')
check('gpt-6-luna omits', resolveTemperature('gpt-6-luna', 0.2) === undefined)
check('gpt-5.6-sol omits', resolveTemperature('gpt-5.6-sol', 0.2) === undefined)
check('o3 omits', resolveTemperature('o3', 0.2) === undefined)
check('kimi-k3 pinned 0.6', resolveTemperature('kimi-k3', 0.2) === 0.6)
check('glm free', resolveTemperature('glm-5.1', 0.2) === 0.2)
check('claude-sonnet-5 omits', resolveTemperature('claude-sonnet-5', 0.2) === undefined)
check('claude-opus-4-7 omits', resolveTemperature('claude-opus-4-7', 0.2) === undefined)
check('claude-haiku-4-5 free', resolveTemperature('claude-haiku-4-5', 0.2) === 0.2)

console.log('\n[transformOpenAIBody quirks]')
{
  const { transformOpenAIBody } = await import('../src/main/openai-compat-body.ts')
  const t = (body, flags) => transformOpenAIBody(body, flags)
  check('side task on GLM → thinking disabled', t({ model: 'glm-4.6v-flash' }, { disableThinking: true }).thinking?.type === 'disabled')
  check('glm-5.3-flash always thinks → no disable', t({ model: 'glm-5.3-flash' }, { disableThinking: true }).thinking === undefined)
  check('gpt-6 → reasoning_effort none', t({ model: 'gpt-6-sol', tools: [{}] }, { isOpenAI: true }).reasoning_effort === 'none')
  check('gpt-6 keeps explicit effort', t({ model: 'gpt-6-sol', reasoning_effort: 'low' }, { isOpenAI: true }).reasoning_effort === 'low')
  check('gpt-5.5 untouched', t({ model: 'gpt-5.5' }, { isOpenAI: true }).reasoning_effort === undefined)
  check('openai never gets a thinking field', t({ model: 'gpt-6-luna' }, { isOpenAI: true }).thinking === undefined)
  check('qwen → enable_thinking false', t({ model: 'qwen3.7-plus' }, { isQwen: true }).enable_thinking === false)
}

console.log('\n[migrateRetiredModels]')
{
  const cases = [
    [KIMI_CN, 'kimi-k2-turbo-preview', 'kimi-k2.6'],
    [KIMI_CN, 'kimi-k2-0905-preview', 'kimi-k2.6'],
    [KIMI_AI, 'kimi-k2.5', 'kimi-k2.6'],
    [KIMI_AI, 'moonshot-v1-128k-vision-preview', 'kimi-k2.6'],
    [KIMI_AI, 'kimi-k3', 'kimi-k3'],
    [DS, 'deepseek-chat', 'deepseek-flash'],
    [DS, 'deepseek-v4-flash', 'deepseek-flash'],
    [DS, 'deepseek-reasoner', 'deepseek-v4-pro'],
    [DS, 'deepseek-v4-pro', 'deepseek-v4-pro'],
    [GLM, 'kimi-k2.5', 'kimi-k2.5'], // only remapped on its own host
    [ARK, 'doubao-1-5-vision-pro-250328', 'doubao-seed-2-1-pro-260915'],
    [ARK, 'doubao-1-5-vision-pro-32k-250115', 'doubao-seed-2-1-lite-260915'],
    [ARK, 'doubao-seed-2-0-lite-260215', 'doubao-seed-2-1-lite-260915'],
    [ARK, 'doubao-seed-2-1-pro-260915', 'doubao-seed-2-1-pro-260915'],
    ['https://api.openai.com/v1', 'gpt-5.5', 'gpt-5.5'], // not retired → untouched
  ]
  for (const [url, from, to] of cases) {
    const raw = { backend: { baseUrl: url, model: from } }
    migrateRetiredModels(raw)
    check(`${from} @ ${new URL(url).host} → ${to}`, raw.backend.model === to, raw.backend.model)
  }
  const raw = { backend: { baseUrl: KIMI_CN, model: 'kimi-k2.6', fastModel: 'kimi-k2-turbo-preview' } }
  check('fastModel remapped too', migrateRetiredModels(raw) && raw.backend.fastModel === 'kimi-k2.6')
  check('runConfigMigrations reports no-op', runConfigMigrations({ backend: { baseUrl: GLM, model: 'glm-5.1' } }) === false)
  check('runConfigMigrations reports change', runConfigMigrations({ backend: { baseUrl: DS, model: 'deepseek-chat' } }) === true)
}

console.log('\n[parseConfigLenient]')
{
  const good = configSchema.parse({})
  const r1 = parseConfigLenient(good)
  check('valid config → nothing dropped', r1.dropped.length === 0)

  const bad = JSON.parse(JSON.stringify(good))
  bad.backend.apiKey = 'sk-keep-me'
  bad.backend.model = 'glm-5.1'
  bad.proactive.mode = 'not-a-mode'
  bad.ui = 'garbage'
  const r2 = parseConfigLenient(bad)
  check('bad enum dropped by path', r2.dropped.includes('proactive.mode'), JSON.stringify(r2.dropped))
  check('rest of that section kept', r2.config.proactive.includeScreen === bad.proactive.includeScreen)
  check('API key survives', r2.config.backend.apiKey === 'sk-keep-me')
  check('non-object section reset', r2.dropped.includes('ui') && typeof r2.config.ui === 'object')
  check('garbage root → defaults', parseConfigLenient('nope').config.backend.baseUrl === good.backend.baseUrl)
}

console.log('\n[local endpoints]')
check('127.0.0.1 is local', isLocalEndpoint(LOCAL))
check('localhost is local', isLocalEndpoint('http://localhost:11434/v1'))
check('lookalike host is not', !isLocalEndpoint('https://localhost.evil.com/v1'))
{
  const b = configSchema.parse({}).backend
  check('LM Studio w/o key counts as configured', isBackendConfigured({ ...b, baseUrl: LOCAL, apiKey: '' }))
  check('cloud w/o key does not', !isBackendConfigured({ ...b, baseUrl: GLM, apiKey: '' }))
}

console.log('\n[friendlyLlmError]')
{
  const f = (err, baseUrl = GLM, modelId = 'glm-5.1') => friendlyLlmError(err, { baseUrl, modelId })
  const bal = f({ statusCode: 429, message: 'x', responseBody: '{"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}' })
  check('GLM 1113 → 余额不足 + free-model hint', bal.includes('余额不足') && bal.includes('glm-4.6v-flash'), bal)
  check('401 → API key', f({ statusCode: 401, message: 'Invalid Authentication' }, KIMI_CN).includes('API key'))
  check('Kimi 401 mentions cn/ai keys differ', f({ statusCode: 401, message: 'Invalid Authentication' }, KIMI_CN).includes('不通用'))
  check('1305 → busy', f({ statusCode: 429, message: '{"error":{"code":"1305","message":"该模型当前访问量过大"}}' }).includes('太忙'))
  check('retired model → 换一个模型', f({ statusCode: 404, message: 'Not found the model kimi-k2.5' }, KIMI_AI, 'kimi-k2.5').includes('换一个模型'))
  check('image on text model → 不能看图', f({ statusCode: 400, message: "messages.content.type 参数非法，取值范围 ['text']" }).includes('不能看图'))
  check('LM Studio down → LM Studio hint', f(new TypeError('fetch failed'), LOCAL).includes('LM Studio'))
  check('unknown error passes through', f(new Error('weird thing')) === 'weird thing')
}

console.log('\n[kimi $web_search filter]')
{
  const sse = (obj) => 'data: ' + JSON.stringify(obj)
  const filter = createKimiSearchFilter()
  const lines = [
    sse({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }),
    sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 't-1', type: 'builtin_function', function: { name: '$web_search', arguments: '' } }] } }] }),
    sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"search_result":{"search_id":"abc"}}' } }] } }] }),
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    'data: [DONE]',
  ]
  const out = lines.map((l) => filter.processLine(l))
  check('builtin call chunk dropped', out[1] === null)
  check('typeless arguments chunk dropped', out[2] === null, String(out[2]))
  check('finish_reason tool_calls held back', !out[3] || !out[3].includes('tool_calls'), String(out[3]))
  check('[DONE] held back', out[4] === null)
  check('needs follow-up', filter.needsFollowUp)
  check('arguments accumulated', filter.builtinCalls[0]?.args === '{"search_result":{"search_id":"abc"}}')
  const body = buildFollowUpBody({ model: 'kimi-k2.6', messages: [{ role: 'user', content: 'q' }] }, filter.builtinCalls, '')
  const [, asst, tool] = body.messages
  check('follow-up: assistant tool_calls echo', asst.role === 'assistant' && asst.tool_calls[0].type === 'builtin_function')
  check('follow-up: tool message echoes arguments', tool.role === 'tool' && tool.tool_call_id === 't-1' && tool.content.includes('abc'))

  const mixed = createKimiSearchFilter()
  mixed.processLine(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'f', type: 'function', function: { name: 'readFile', arguments: '{}' } }, { index: 1, id: 't', type: 'builtin_function', function: { name: '$web_search' } }] } }] }))
  const fin = mixed.processLine(sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }))
  check('mixed with function call → no follow-up, finish kept', !mixed.needsFollowUp && fin.includes('tool_calls'))
}

console.log('\n[kimi $web_search round-trip]')
{
  const enc = (s) => new TextEncoder().encode(s)
  const sseResponse = (text) =>
    new Response(new ReadableStream({ start(c) { c.enqueue(enc(text)); c.close() } }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  const first = sseResponse(
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"t-9","type":"builtin_function","function":{"name":"$web_search","arguments":"{\\"q\\":1}"}}]}}]}\n\n' +
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
  )
  let refetchBody = null
  const wrapped = wrapKimiSearchResponse(first, {
    body: { model: 'kimi-k2.6', stream: true, messages: [{ role: 'user', content: 'news?' }] },
    refetch: async (b) => {
      refetchBody = b
      return sseResponse(
        'data: {"choices":[{"index":0,"delta":{"content":"今天的新闻是"}}]}\n\n' +
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      )
    },
  })
  const text = await wrapped.text()
  check('re-POSTed with tool result', refetchBody?.messages?.at(-1)?.role === 'tool' && refetchBody.messages.at(-1).content === '{"q":1}')
  check('answer text streamed through', text.includes('今天的新闻是'))
  check('exactly one [DONE]', text.split('[DONE]').length === 2, text)
  check('no builtin_function leaks', !text.includes('builtin_function'))
  check('no tool_calls finish leaks', !text.includes('"tool_calls"'))
}

console.log('\n[fetchWithTransientRetry]')
{
  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return calls === 1
      ? new Response('{"error":{"code":"1305","message":"访问量过大"}}', { status: 429, headers: { 'retry-after': '0.01' } })
      : new Response('ok', { status: 200 })
  }
  const r = await fetchWithTransientRetry('https://x.test', { method: 'POST', body: '{}' })
  check('429 busy → retried → 200', r.status === 200 && calls === 2, `calls=${calls}`)

  calls = 0
  globalThis.fetch = async () => {
    calls++
    return new Response('{"error":{"code":"1113","message":"余额不足"}}', { status: 429 })
  }
  const r2 = await fetchWithTransientRetry('https://x.test', { method: 'POST', body: '{}' })
  check('429 no-balance → not retried', r2.status === 429 && calls === 1, `calls=${calls}`)
  globalThis.fetch = realFetch
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
