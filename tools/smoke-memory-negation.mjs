/**
 * Smoke test: automatic memory negation and retraction pipeline.
 *
 * Verifies that:
 *   1. L3 reflection response parser successfully extracts facts containing "DELETE".
 *   2. upsertFact with a "DELETE" value successfully wipes/purges the matching key's active fact chain from SQLite.
 *   3. Follow-up upsertFact correctly creates the new fact, satisfying the "delete-then-replace" negation pipeline.
 *
 * Run: electron tools/smoke-memory-negation.mjs
 */
import { app } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

async function main() {
  // Setup tsx loader for TypeScript imports in Electron
  const { register } = await import('tsx/esm/api')
  register()
  const { openSqliteMemory } = await import('../src/main/storage/sqlite-memory-adapter.ts')
  const { parseReflectionResponse } = await import('../src/core/memory/reflection.ts')
  const { isRetractionOrCorrection } = await import('../src/main/chat.ts')
  const { createMemoryService } = await import('../src/core/memory/service.ts')

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

  // ---------- 1. Unit Test parseReflectionResponse with DELETE ----------
  console.log('\n[1: Unit testing prompt parse with DELETE]')
  const mockLLMOutput = `
  这里是提取出来的结果，请注意我识别出了用户想要清除一些旧信息：
  \`\`\`json
  [
    {"key": "user.profile.name", "value": "DELETE", "confidence": 1.0},
    {"key": "user.profile.name", "value": "小刘", "confidence": 1.0}
  ]
  \`\`\`
  `
  const parsed = parseReflectionResponse(mockLLMOutput)
  check('parseReflectionResponse returns non-null array', Array.isArray(parsed))
  check('parsed length is 2', parsed?.length === 2)
  check('first item key is user.profile.name', parsed?.[0]?.key === 'user.profile.name')
  check('first item value is DELETE', parsed?.[0]?.value === 'DELETE')
  check('second item value is 小刘', parsed?.[1]?.value === '小刘')

  // ---------- 2. DB Integration Test negation / retraction ----------
  console.log('\n[2: DB integration testing negation / retraction]')
  const dir = mkdtempSync(join(tmpdir(), 'openmeido-negation-'))
  const adapter = openSqliteMemory(dir, 4, 'maid')

  // Step A: Insert a personal fact "小李"
  console.log('  Step A: Inserting user.profile.name = "小李"')
  const fact1 = await adapter.upsertFact('maid', {
    key: 'user.profile.name',
    value: '小李',
    confidence: 1.0,
    sourceEpisodeIds: [1]
  })
  check('fact1 created', !!fact1)
  
  const activeFacts = await adapter.listActiveFacts('maid')
  check('activeFacts length is 1', activeFacts.length === 1)
  check('activeFacts[0] is 小李', activeFacts[0]?.value === '小李')

  // Step B: Send the "DELETE" action
  console.log('  Step B: Sending DELETE for user.profile.name')
  const deleteResult = await adapter.upsertFact('maid', {
    key: 'user.profile.name',
    value: 'DELETE',
    confidence: 1.0,
    sourceEpisodeIds: [2]
  })
  check('deleteResult returns fact object with value DELETE', deleteResult?.value === 'DELETE')

  const activeFactsAfterDelete = await adapter.listActiveFacts('maid')
  check('activeFacts is empty after DELETE', activeFactsAfterDelete.length === 0)

  // Step C: Send the new value "小刘"
  console.log('  Step C: Sending user.profile.name = "小刘"')
  const fact2 = await adapter.upsertFact('maid', {
    key: 'user.profile.name',
    value: '小刘',
    confidence: 1.0,
    sourceEpisodeIds: [3]
  })
  check('fact2 created', !!fact2)
  check('fact2 value is 小刘', fact2.value === '小刘')

  const activeFactsAfterAll = await adapter.listActiveFacts('maid')
  check('activeFacts length is 1 after insert', activeFactsAfterAll.length === 1)
  check('activeFacts[0] value is 小刘', activeFactsAfterAll[0]?.value === '小刘')

  // ---------- 3. Unit Test isRetractionOrCorrection ----------
  console.log('\n[3: Unit testing isRetractionOrCorrection]')
  check('Matches "不要叫我小李"', isRetractionOrCorrection('不要叫我小李') === true)
  check('Matches "别叫我小李了"', isRetractionOrCorrection('别叫我小李了') === true)
  check('Matches "我不是小李"', isRetractionOrCorrection('我不是小李') === true)
  check('Matches "记错了，我不叫小李"', isRetractionOrCorrection('记错了，我不叫小李') === true)
  check('Matches "Don\'t call me Xiao Li"', isRetractionOrCorrection("Don't call me Xiao Li") === true)
  check('Matches "stop calling me"', isRetractionOrCorrection("stop calling me") === true)
  check('Does not match "今天天气很好"', isRetractionOrCorrection('今天天气很好') === false)
  check('Does not match "总结一下最近的邮件"', isRetractionOrCorrection('总结一下最近的邮件') === false)

  // ---------- 4. Integration Test bumpReflectionCounter force-trigger ----------
  console.log('\n[4: Integration testing bumpReflectionCounter with force=true]')
  const mockConfig = {
    persona: { preset: 'maid' },
    memory: { recentN: 10 }
  }
  const memoryService = createMemoryService({
    adapter,
    getConfig: () => mockConfig
  })

  // Verify default counter works normally (first turn doesn't trigger)
  const norm1 = await memoryService.bumpReflectionCounter('personal', false)
  check('Normal personal turn does not trigger reflection', norm1 === null)

  // Verify force=true immediately triggers reflection
  const force1 = await memoryService.bumpReflectionCounter('personal', true)
  check('Forced personal turn immediately triggers reflection', force1 === 'personal')

  // Verify counter was reset after forced trigger
  const norm2 = await memoryService.bumpReflectionCounter('personal', false)
  check('Reflection counter is reset after forced reflection', norm2 === null)

  adapter.close()
  rmSync(dir, { recursive: true, force: true })
  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
}

app.whenReady().then(main).catch((err) => {
  console.error('crashed:', err)
  app.exit(1)
})
