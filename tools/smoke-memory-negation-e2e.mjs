#!/usr/bin/env electron
/**
 * Real-LLM end-to-end test for the DELETE pipeline.
 *
 * smoke-memory-negation.mjs already verifies the adapter side: given the
 * marker `value: "DELETE"`, the supersession chain is wiped. What it
 * does NOT verify is that a real LLM, when shown:
 *
 *   - the existing-facts block: "- user.profile.name: 小李"
 *   - and the user's retraction message: "别叫我小李了，我叫小刘"
 *
 * will actually produce `{key: "user.profile.name", value: "DELETE", ...}`
 * with the SAME key as the existing fact. The whole DELETE design assumes
 * the model picks the exact key, but nothing test-asserts that until now.
 *
 * This test:
 *   1. Seeds a known personal fact via the adapter.
 *   2. Adds conversational episodes simulating a retraction.
 *   3. Runs the FULL reflectOnce() pipeline against DeepSeek (deepseek-chat,
 *      non-reasoning, ~1500 input tokens → ~100 output tokens ≈ $0.0005).
 *   4. Asserts that the old fact value is gone from listActiveFacts.
 *
 * Run: DEEPSEEK_API_KEY=xxx electron tools/smoke-memory-negation-e2e.mjs
 */

import { app } from 'electron'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { generateText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'

// Inline .env loader — electron doesn't honor --env-file.
function loadEnv() {
  try {
    const raw = readFileSync(join(process.cwd(), '.env'), 'utf-8')
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i.exec(line)
      if (!m) continue
      const key = m[1]
      let val = m[2]
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      if (!(key in process.env)) process.env[key] = val
    }
  } catch (err) {
    console.warn('[smoke] .env not loaded:', err.message)
  }
}
loadEnv()

async function main() {
  const { register } = await import('tsx/esm/api')
  register()

  const { openSqliteMemory } = await import('../src/main/storage/sqlite-memory-adapter.ts')
  const { createMemoryService } = await import('../src/core/memory/service.ts')

  if (!process.env.DEEPSEEK_API_KEY) {
    console.error('DEEPSEEK_API_KEY not set in .env')
    app.exit(1)
    return
  }

  const ds = createOpenAI({
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: process.env.DEEPSEEK_API_KEY,
  })
  const model = ds.chat('deepseek-chat')

  /** ReflectionExtractor — what the host wires into MemoryService. */
  const extract = async (prompt) => {
    const t0 = Date.now()
    const { text } = await generateText({ model, prompt, temperature: 0.2 })
    console.log(`    [LLM] ${Date.now() - t0}ms, raw output:\n      ${text.replace(/\n/g, '\n      ').slice(0, 600)}`)
    return text
  }

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

  // ---------- Setup ----------
  const dir = mkdtempSync(join(tmpdir(), 'openmeido-negation-e2e-'))
  const adapter = openSqliteMemory(dir, 512, 'maid')

  const svc = createMemoryService({
    adapter,
    getConfig: () => ({
      memory: { enabled: true, recentN: 10, topK: 3, imageRecallTurns: 0 },
      persona: { preset: 'maid', customs: [] },
    }),
    embed: async () => new Float32Array(512).fill(0.01),
    isNaiveMode: () => false,
    reflectExtractor: extract,
  })

  // ---------- Scenario 1: name retraction ----------
  console.log('\n[Scenario 1: "别叫我小李了，我叫小刘"]')

  // Seed a known fact directly via the adapter.
  await adapter.upsertFact(
    'maid',
    { key: 'user.profile.name', value: '小李', confidence: 1.0, sourceEpisodeIds: [] },
    'personal',
  )
  const seeded = await adapter.listActiveFacts('maid', 50, 'personal')
  check('seeded fact present before reflection', seeded.some(f => f.key === 'user.profile.name' && f.value === '小李'))

  // Simulate a conversation that ends with the user retracting + replacing
  // their name. The model will see the existing fact and the conversation.
  await svc.addEpisode('user', '我们之前聊过我的名字')
  await svc.addEpisode('assistant', '嗯，您是小李吧？我记得的。')
  await svc.addEpisode('user', '别叫我小李了，我叫小刘')
  await svc.addEpisode('assistant', '好的小刘，记下来了。')

  // Run the real reflection pass.
  console.log('  Running reflectOnce against deepseek-chat...')
  const n = await svc.reflectOnce()
  check('reflectOnce returned a non-negative count', typeof n === 'number' && n >= 0, `got ${n}`)

  const after = await adapter.listActiveFacts('maid', 50, 'personal')
  console.log('  Facts after reflection:')
  for (const f of after) console.log(`    · ${f.key}: ${f.value}  (conf ${f.confidence})`)

  // PRIMARY ASSERTION: the old value should not still be active.
  const stillHasOldName = after.some(f => f.value === '小李')
  check(
    'old value "小李" no longer in active facts (DELETE pipeline worked)',
    !stillHasOldName,
    `still found 小李: ${JSON.stringify(after.filter(f => f.value === '小李'))}`,
  )

  // SECONDARY ASSERTION: ideally the new name landed somewhere too.
  const hasNewName = after.some(f => f.value === '小刘')
  if (hasNewName) {
    console.log('  (bonus) new name 小刘 was also extracted into active facts')
  } else {
    console.log('  (note) new name 小刘 NOT yet captured — this is fine, will happen on next reflection cycle')
  }

  // ---------- Cleanup ----------
  adapter.close()
  rmSync(dir, { recursive: true, force: true })

  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
}

app.whenReady().then(main).catch((err) => {
  console.error('crashed:', err)
  app.exit(1)
})
