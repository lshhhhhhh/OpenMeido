/**
 * Smoke test: turn classification and L3 parallel memory context routing (Option B).
 *
 * Verifies that:
 *   1. classifyTurnType correctly categorizes turns as 'personal' (no tools),
 *      'work' (email, files, search), or 'neutral' (tasks, clipboard).
 *   2. bumpReflectionCounter only increments personal reflection counters and
 *      returns 'personal' when hitting the threshold (5), while completely bypassing
 *      work and neutral turns.
 *
 * Run: electron tools/smoke-turn-classification.mjs
 */
import { app } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

async function main() {
  const { register } = await import('tsx/esm/api')
  register()

  const { classifyTurnType } = await import('../src/main/chat.ts')
  const { openSqliteMemory } = await import('../src/main/storage/sqlite-memory-adapter.ts')
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

  // ---------- 1. Test classifyTurnType helper ----------
  console.log('\n[1: Unit testing classifyTurnType]')

  check('empty tool calls is personal', classifyTurnType([]) === 'personal')

  check('work tool call (readEmail) is work', classifyTurnType([{ toolName: 'readEmail' }]) === 'work')
  check('work tool call (google_search) is work', classifyTurnType([{ toolName: 'google_search' }]) === 'work')
  check('work tool call (readFile) is work', classifyTurnType([{ toolName: 'readFile' }]) === 'work')
  // presentTable counts as work — iterating on a structured table is
  // continuing a productivity flow, not personal chat. Fixed alongside
  // the UI 💼 indicator (was missing for table-only edit turns).
  check('work tool call (presentTable) is work', classifyTurnType([{ toolName: 'presentTable' }]) === 'work')

  check('neutral tool call (addTask) is neutral', classifyTurnType([{ toolName: 'addTask' }]) === 'neutral')
  check('neutral tool call (listTasks) is neutral', classifyTurnType([{ toolName: 'listTasks' }]) === 'neutral')
  check('neutral tool call (readClipboard) is neutral', classifyTurnType([{ toolName: 'readClipboard' }]) === 'neutral')

  check(
    'mixed work and neutral tool calls is work',
    classifyTurnType([{ toolName: 'listTasks' }, { toolName: 'readEmail' }]) === 'work'
  )
  // A presentTable-only turn following an earlier work turn (e.g. "再筛
  // 一下" / "只列出广告") would historically classify as neutral and
  // miss the 💼. Now it's work consistently.
  check(
    'presentTable-only turn (table edit) is work',
    classifyTurnType([{ toolName: 'presentTable' }]) === 'work'
  )

  // ---------- 2. Integration test Memory Service reflection counters ----------
  console.log('\n[2: DB integration testing Reflection Counters]')
  const dir = mkdtempSync(join(tmpdir(), 'openmeido-turn-class-'))
  const adapter = openSqliteMemory(dir, 512, 'maid')

  const svc = createMemoryService({
    adapter,
    getConfig: () => ({
      memory: { enabled: true, recentN: 10, topK: 3 },
      persona: { preset: 'maid', customs: [] },
    }),
    embed: async () => new Float32Array(512).fill(0.01),
    isNaiveMode: () => false,
  })

  // Check initial counters (both should be 0)
  const initial = await svc.getReflectionCounters()
  check('initial personal counter is 0', initial.personal === 0)
  check('initial work counter is 0', initial.work === 0)

  // Neutral turn should NOT increment anything
  console.log('  Testing neutral turn bumping...')
  const resNeutral = await svc.bumpReflectionCounter('neutral')
  check('neutral turn returns null', resNeutral === null)
  const afterNeutral = await svc.getReflectionCounters()
  check('personal counter unchanged after neutral', afterNeutral.personal === 0)
  check('work counter unchanged after neutral', afterNeutral.work === 0)

  // Work turn should NOT increment anything
  console.log('  Testing work turn bumping...')
  const resWork = await svc.bumpReflectionCounter('work')
  check('work turn returns null', resWork === null)
  const afterWork = await svc.getReflectionCounters()
  check('personal counter unchanged after work', afterWork.personal === 0)
  check('work counter unchanged after work', afterWork.work === 0)

  // Personal turn increments personal counter
  console.log('  Testing personal turns bumping (1 to 4)...')
  for (let i = 1; i <= 4; i++) {
    const res = await svc.bumpReflectionCounter('personal')
    check(`personal turn ${i} returns null`, res === null)
    const current = await svc.getReflectionCounters()
    check(`personal counter incremented to ${i}`, current.personal === i)
    check(`work counter stays 0`, current.work === 0)
  }

  // 5th personal turn triggers personal reflection and resets counter
  console.log('  Testing 5th personal turn threshold trigger...')
  const resTrigger = await svc.bumpReflectionCounter('personal')
  check('5th personal turn returns "personal" (triggered)', resTrigger === 'personal')
  const finalCounters = await svc.getReflectionCounters()
  check('personal counter reset to 0', finalCounters.personal === 0)
  check('work counter stays 0', finalCounters.work === 0)

  adapter.close()
  rmSync(dir, { recursive: true, force: true })
  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
}

app.whenReady().then(main).catch((err) => {
  console.error('crashed:', err)
  app.exit(1)
})
