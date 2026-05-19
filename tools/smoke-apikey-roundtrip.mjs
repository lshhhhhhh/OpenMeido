#!/usr/bin/env node
/**
 * Pure-JS replication of the Settings-tab backend-switching logic, to
 * verify the per-baseUrl apiKey map survives provider switches and
 * subsequent saves. Covers the user-reported bug where switching
 * providers + saving permanently lost previously-entered keys.
 *
 * Run: npm run test:apikey-roundtrip
 */
import { configSchema } from '../src/shared/config.ts'

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

/**
 * Mirrors the chip click handler in Settings.tsx — switches baseUrl and
 * preserves the current key under the OLD baseUrl in the map. Returns
 * the updated backend object.
 */
function switchProvider(backend, newBaseUrl, suggestedModelForNew) {
  const map = { ...backend.apiKeys }
  if (backend.apiKey) map[backend.baseUrl] = backend.apiKey
  return {
    ...backend,
    baseUrl: newBaseUrl,
    apiKey: map[newBaseUrl] ?? '',
    apiKeys: map,
    model: suggestedModelForNew,
  }
}

/** Mirrors the API-Key onChange handler. */
function typeKey(backend, newKey) {
  const map = { ...backend.apiKeys, [backend.baseUrl]: newKey }
  return { ...backend, apiKey: newKey, apiKeys: map }
}

async function main() {
  // ---------- Default values ----------
  console.log('\n[schema defaults]')
  const fresh = configSchema.parse({})
  check('apiKey defaults to ""', fresh.backend.apiKey === '')
  check(
    'apiKeys defaults to {} (empty record)',
    typeof fresh.backend.apiKeys === 'object' &&
      Object.keys(fresh.backend.apiKeys).length === 0,
  )

  // ---------- Migration: old configs without apiKeys ----------
  console.log('\n[backward compat — old config without apiKeys field]')
  const oldConfig = configSchema.parse({
    backend: {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-old-key',
      model: 'gpt-5.4-mini',
    },
  })
  check('old config parses successfully', !!oldConfig)
  check(
    'apiKeys defaulted to {} when missing in input',
    Object.keys(oldConfig.backend.apiKeys).length === 0,
  )
  check('apiKey value preserved from old config', oldConfig.backend.apiKey === 'sk-old-key')

  // ---------- The actual user-reported bug scenario ----------
  console.log('\n[round-trip: A → B → A preserves both keys]')
  let backend = configSchema.parse({}).backend
  backend.baseUrl = 'https://api.openai.com/v1' // start on OpenAI
  // User types key for OpenAI
  backend = typeKey(backend, 'sk-openai-K1')
  check('after typing K1 on OpenAI: apiKey set', backend.apiKey === 'sk-openai-K1')
  check(
    'after typing K1: map has OpenAI entry',
    backend.apiKeys['https://api.openai.com/v1'] === 'sk-openai-K1',
  )

  // Switch to GLM
  backend = switchProvider(backend, 'https://open.bigmodel.cn/api/paas/v4', 'glm-4.6-flash')
  check('switching to GLM clears live apiKey', backend.apiKey === '')
  check(
    "GLM switch preserves OpenAI's key in map",
    backend.apiKeys['https://api.openai.com/v1'] === 'sk-openai-K1',
  )

  // Type GLM key
  backend = typeKey(backend, 'glm-K2')
  check('after typing K2 on GLM: apiKey set', backend.apiKey === 'glm-K2')
  check(
    'after typing K2: map has BOTH OpenAI and GLM entries',
    backend.apiKeys['https://api.openai.com/v1'] === 'sk-openai-K1' &&
      backend.apiKeys['https://open.bigmodel.cn/api/paas/v4'] === 'glm-K2',
  )

  // Switch BACK to OpenAI — the bug case the user reported
  backend = switchProvider(backend, 'https://api.openai.com/v1', 'gpt-5.4-mini')
  check(
    'switching back to OpenAI restores K1 from map',
    backend.apiKey === 'sk-openai-K1',
  )
  check(
    'after round-trip: GLM key still preserved',
    backend.apiKeys['https://open.bigmodel.cn/api/paas/v4'] === 'glm-K2',
  )

  // ---------- Save simulation: parsing the round-tripped object ----------
  console.log('\n[saved config round-trips through schema]')
  const saved = { ...configSchema.parse({}), backend }
  const reparsed = configSchema.parse(saved)
  check('reparsed apiKey === K1', reparsed.backend.apiKey === 'sk-openai-K1')
  check(
    'reparsed apiKeys has both entries',
    reparsed.backend.apiKeys['https://api.openai.com/v1'] === 'sk-openai-K1' &&
      reparsed.backend.apiKeys['https://open.bigmodel.cn/api/paas/v4'] === 'glm-K2',
  )

  // ---------- Edge: typing empty doesn't blow away the map entry ----------
  console.log('\n[edge: blanking the input clears that baseUrl only]')
  let edge = configSchema.parse({}).backend
  edge.baseUrl = 'https://api.openai.com/v1'
  edge = typeKey(edge, 'sk-K1')
  edge = typeKey(edge, '') // user blanks the field
  check('after blanking: live apiKey is empty', edge.apiKey === '')
  check(
    'after blanking: map entry for current baseUrl is also empty (not deleted)',
    edge.apiKeys['https://api.openai.com/v1'] === '',
  )

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('crashed:', err)
  process.exit(1)
})
