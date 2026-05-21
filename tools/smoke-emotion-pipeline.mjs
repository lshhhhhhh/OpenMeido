#!/usr/bin/env node
/**
 * Unit-level test for the emotion → Live2D + activity-log pipeline.
 *
 * What it covers: the wiring downstream of the LLM classifier. Given an
 * already-classified emotion label, does `applyEmotion(...)`
 *   (a) broadcast the correct Live2DCommand,
 *   (b) push the correct entry into the activity ring,
 *   (c) for each sidecar branch (expression / motion / unmapped / null)?
 *
 * What it does NOT cover: the LLM classification itself — that lives in
 * smoke-emotion-classifier.mjs (which hits real Gemini/GLM/Kimi APIs).
 *
 * Why split: this test is offline + deterministic + sub-second, so it
 * runs on every typecheck pass. The LLM brain test is slower and
 * non-deterministic; it stays opt-in.
 *
 * Run: node --import tsx tools/smoke-emotion-pipeline.mjs
 */

import assert from 'node:assert/strict'

import { applyEmotion } from '../src/main/emotion-apply.ts'

// ---------- Fixtures ----------

/** Sidecar with both an expression mapping AND a motion mapping for the
 *  same emotion — applyEmotion should prefer expression. */
const sidecarWithExpression = {
  modelFile: 'fake.model3.json',
  emotionMapping: {
    开心: 'joy_face',
  },
  motionMapping: {
    开心: { group: 'Tap', index: 0 },
  },
}

/** Sidecar with only motions — applyEmotion should fall through. */
const sidecarMotionOnly = {
  modelFile: 'fake.model3.json',
  emotionMapping: {},
  motionMapping: {
    害羞: { group: 'Tap@Body', index: 0 },
  },
}

/** Sidecar with no mapping for the requested emotion. */
const sidecarEmpty = {
  modelFile: 'fake.model3.json',
  emotionMapping: {},
  motionMapping: {},
}

// ---------- Test harness ----------

const results = []
const check = (name, fn) => {
  try {
    const r = fn()
    if (r instanceof Promise) {
      return r
        .then(() => {
          results.push({ name, ok: true })
          console.log(`  ✅ ${name}`)
        })
        .catch((err) => {
          results.push({ name, ok: false, detail: err.message ?? String(err) })
          console.log(`  ❌ ${name}\n    ${err.message ?? err}`)
        })
    }
    results.push({ name, ok: true })
    console.log(`  ✅ ${name}`)
  } catch (err) {
    results.push({ name, ok: false, detail: err.message ?? String(err) })
    console.log(`  ❌ ${name}\n    ${err.message ?? err}`)
  }
}

/** Spy that records every command/event passed in. */
function makeSpies() {
  const sent = []
  const events = []
  return {
    send: (cmd) => sent.push(cmd),
    pushEvent: (e) => events.push(e),
    sent,
    events,
  }
}

// ---------- Cases ----------

console.log('████ applyEmotion → Live2DCommand + EmotionEvent ████\n')

await check('expression branch: broadcasts setExpression + pushes event', async () => {
  const s = makeSpies()
  await applyEmotion('开心', {
    send: s.send,
    pushEvent: s.pushEvent,
    sidecarFor: async () => sidecarWithExpression,
    modelName: 'fake',
  })
  assert.equal(s.sent.length, 1, 'expected exactly 1 command')
  assert.deepEqual(s.sent[0], { type: 'setExpression', name: 'joy_face' })
  assert.equal(s.events.length, 1, 'expected exactly 1 event')
  assert.equal(s.events[0].emotion, '开心')
  assert.equal(s.events[0].kind, 'expression')
  assert.equal(s.events[0].target, 'joy_face')
  assert.match(s.events[0].ts, /^\d{4}-\d{2}-\d{2}T/)
})

await check('motion branch: broadcasts playMotion + pushes event', async () => {
  const s = makeSpies()
  await applyEmotion('害羞', {
    send: s.send,
    pushEvent: s.pushEvent,
    sidecarFor: async () => sidecarMotionOnly,
    modelName: 'fake',
  })
  assert.equal(s.sent.length, 1)
  assert.deepEqual(s.sent[0], { type: 'playMotion', group: 'Tap@Body', index: 0 })
  assert.equal(s.events.length, 1)
  assert.equal(s.events[0].emotion, '害羞')
  assert.equal(s.events[0].kind, 'motion')
  assert.equal(s.events[0].target, 'Tap@Body[0]')
})

await check('expression preferred over motion when both present', async () => {
  const s = makeSpies()
  await applyEmotion('开心', {
    send: s.send,
    pushEvent: s.pushEvent,
    sidecarFor: async () => sidecarWithExpression,
    modelName: 'fake',
  })
  // Should NOT have fired playMotion.
  assert.equal(s.sent.filter((c) => c.type === 'playMotion').length, 0)
  assert.equal(s.sent.filter((c) => c.type === 'setExpression').length, 1)
})

await check('unmapped emotion: clears expression, does NOT push event', async () => {
  const s = makeSpies()
  await applyEmotion('得意', {
    send: s.send,
    pushEvent: s.pushEvent,
    sidecarFor: async () => sidecarEmpty,
    modelName: 'fake',
  })
  assert.equal(s.sent.length, 1)
  assert.deepEqual(s.sent[0], { type: 'setExpression', name: null })
  assert.equal(s.events.length, 0, 'no visible action → no activity log entry')
})

await check('null emotion: clears expression, does NOT push event', async () => {
  const s = makeSpies()
  await applyEmotion(null, {
    send: s.send,
    pushEvent: s.pushEvent,
    sidecarFor: async () => sidecarWithExpression,
    modelName: 'fake',
  })
  assert.equal(s.sent.length, 1)
  assert.deepEqual(s.sent[0], { type: 'setExpression', name: null })
  assert.equal(s.events.length, 0)
})

await check('missing sidecar: clears expression, does NOT push event', async () => {
  const s = makeSpies()
  await applyEmotion('开心', {
    send: s.send,
    pushEvent: s.pushEvent,
    sidecarFor: async () => null,
    modelName: 'missing',
  })
  assert.equal(s.sent.length, 1)
  assert.deepEqual(s.sent[0], { type: 'setExpression', name: null })
  assert.equal(s.events.length, 0)
})

// ---------- Summary ----------

const failed = results.filter((r) => !r.ok)
console.log(
  `\n${failed.length === 0 ? '✅' : '❌'} ${results.length - failed.length}/${results.length} assertions passed`,
)
if (failed.length > 0) {
  console.log('\nFailed:')
  for (const f of failed) console.log(`  · ${f.name} :: ${f.detail}`)
}
process.exit(failed.length === 0 ? 0 : 1)
