#!/usr/bin/env node
/**
 * Unit test for the presence gating logic.
 *
 * `isActivelyPresent({ windowVisible, windowMinimized, systemIdleSec })`
 * returns true only when:
 *   - the window is visible (not hidden via hotkey, not minimized)
 *   - the system is not idle (last user input within 5 minutes)
 *
 * The ACTUAL accumulation logic + LLM-free affinity bump path require
 * an electron runtime to exercise (powerMonitor, BrowserWindow). Those
 * stay manual-test territory; here we cover just the pure gate.
 *
 * Run: node --import tsx tools/smoke-presence-gate.mjs
 */

import assert from 'node:assert/strict'

import { isActivelyPresent } from '../src/shared/presence-gate.ts'
import { PRESENCE_SCORE_CEILING } from '../src/shared/affinity.ts'

const results = []
const check = (name, fn) => {
  try {
    fn()
    results.push({ name, ok: true })
    console.log(`  ✅ ${name}`)
  } catch (err) {
    results.push({ name, ok: false, detail: err.message ?? String(err) })
    console.log(`  ❌ ${name}\n    ${err.message ?? err}`)
  }
}

console.log('████ Presence gate ████\n')

check('window visible + recent input → present', () => {
  assert.equal(
    isActivelyPresent({
      windowVisible: true,
      windowMinimized: false,
      systemIdleSec: 30,
    }),
    true,
  )
})
check('window hidden → not present', () => {
  assert.equal(
    isActivelyPresent({
      windowVisible: false,
      windowMinimized: false,
      systemIdleSec: 30,
    }),
    false,
  )
})
check('window minimized → not present', () => {
  assert.equal(
    isActivelyPresent({
      windowVisible: true,
      windowMinimized: true,
      systemIdleSec: 30,
    }),
    false,
  )
})
check('system idle beyond threshold → not present', () => {
  // 600s = 10 min, well past the 300s threshold
  assert.equal(
    isActivelyPresent({
      windowVisible: true,
      windowMinimized: false,
      systemIdleSec: 600,
    }),
    false,
  )
})
check('idle exactly at threshold → present', () => {
  assert.equal(
    isActivelyPresent({
      windowVisible: true,
      windowMinimized: false,
      systemIdleSec: 300,
    }),
    true,
  )
})
check('idle just over threshold → not present', () => {
  assert.equal(
    isActivelyPresent({
      windowVisible: true,
      windowMinimized: false,
      systemIdleSec: 301,
    }),
    false,
  )
})

console.log('\n████ Score ceiling ████\n')

check('ceiling is 40 (Lv.3 floor) — passive cannot reach 亲近+', () => {
  assert.equal(PRESENCE_SCORE_CEILING, 40)
})

const failed = results.filter((r) => !r.ok)
console.log(
  `\n${failed.length === 0 ? '✅' : '❌'} ${results.length - failed.length}/${results.length} assertions passed`,
)
process.exit(failed.length === 0 ? 0 : 1)
