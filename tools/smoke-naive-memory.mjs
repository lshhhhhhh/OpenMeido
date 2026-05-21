/**
 * Smoke test for naive memory mode.
 *
 * Verifies that when isNaiveMode() returns true:
 *   - addEpisode persists the row but skips the embed call (no error
 *     bubbles up when embed throws)
 *   - retrieve returns the recent window but no semantic recalls
 *   - flipping naiveMode → false makes embeds resume normally
 *
 * Runs in Electron because the real sqlite-memory-adapter needs the
 * better-sqlite3 native binding.
 *
 * Run: npm run test:naive-memory
 */
import { app } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

async function main() {
  const { register } = await import('tsx/esm/api')
  register()
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

  const dir = mkdtempSync(join(tmpdir(), 'openmeido-naive-'))
  const adapter = openSqliteMemory(dir, 512, 'maid')

  let naive = true
  let embedCalls = 0
  const failingEmbed = async () => {
    embedCalls++
    throw new Error('embed should not be called in naive mode')
  }
  const realEmbed = async () => {
    embedCalls++
    return new Float32Array(512).fill(0.01)
  }

  let useReal = false
  const svc = createMemoryService({
    adapter,
    getConfig: () => ({
      memory: { enabled: true, recentN: 10, topK: 3 },
      persona: { preset: 'maid', customs: [] },
    }),
    embed: async (text) => (useReal ? realEmbed(text) : failingEmbed(text)),
    isNaiveMode: () => naive,
  })

  // ---------- naive mode: addEpisode skips embed, succeeds ----------
  console.log('\n[naive mode: addEpisode skips embed]')
  embedCalls = 0
  const id1 = await svc.addEpisode('user', '今天天气真好')
  check('addEpisode returned a row id (not null)', typeof id1 === 'number' && id1 > 0)
  check('embed was NOT called', embedCalls === 0)
  const all = await adapter.recent('maid', 10)
  check(`row was persisted (got ${all.length})`, all.length === 1)
  check('persisted row has correct text', all[0]?.text === '今天天气真好')

  // ---------- naive mode: retrieve returns recent only, no embed ----------
  console.log('\n[naive mode: retrieve skips semantic search]')
  embedCalls = 0
  const { recent, recalled } = await svc.retrieve('天气')
  check('embed was NOT called during retrieve', embedCalls === 0)
  check(`recent returned (got ${recent.length})`, recent.length >= 1)
  check('recalled is empty (no semantic search)', recalled.length === 0)

  // ---------- flip to full mode → embed gets called again ----------
  console.log('\n[exit naive mode: embed resumes]')
  naive = false
  useReal = true
  embedCalls = 0
  const id2 = await svc.addEpisode('user', '主人，我饿了')
  check('addEpisode after flip returned a row id', typeof id2 === 'number' && id2 > 0)
  check(`embed was called once (got ${embedCalls})`, embedCalls === 1)
  // retrieve should now run embed and call searchByEmbedding (even if it
  // returns nothing — the point is it tries)
  embedCalls = 0
  const result2 = await svc.retrieve('饿')
  check(`embed called during full-mode retrieve (got ${embedCalls})`, embedCalls === 1)
  void result2

  // ---------- naive-era rows aren't in semantic recall ----------
  console.log('\n[naive-era rows are persisted but un-recallable]')
  embedCalls = 0
  const result3 = await svc.retrieve('天气')
  // recent includes the naive-era row (recent-N picks by id desc)
  check(
    'recent-N includes the naive-era row',
    result3.recent.some((e) => e.text === '今天天气真好'),
  )
  // recalled does NOT include the naive-era row (it has no embedding)
  check(
    'recalled does NOT include the naive-era row (no embedding stored for it)',
    !result3.recalled.some((e) => e.text === '今天天气真好'),
  )

  // ---------- toolParts persistence works in naive mode ----------
  console.log('\n[naive mode: toolParts still persist]')
  naive = true
  embedCalls = 0
  const toolParts = [
    {
      type: 'tool-call',
      toolCallId: 'call_abc',
      toolName: 'listRecentEmails',
      input: { limit: 5 },
    },
  ]
  const id3 = await svc.addEpisode('assistant', 'looking', toolParts)
  check('addEpisode with tool_parts returned id', typeof id3 === 'number' && id3 > 0)
  const allAfter = await adapter.recent('maid', 10)
  const row = allAfter.find((r) => r.id === id3)
  check(
    'persisted row has tool_parts',
    row?.toolParts && row.toolParts.length === 1 && row.toolParts[0]?.toolName === 'listRecentEmails',
  )

  adapter.close()
  rmSync(dir, { recursive: true, force: true })
  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
}

app.whenReady().then(main).catch((err) => {
  console.error('crashed:', err)
  app.exit(1)
})
