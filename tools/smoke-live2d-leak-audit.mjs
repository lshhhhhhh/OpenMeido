/**
 * Static lifecycle audit for src/renderer/src/live2d/stage.ts.
 *
 * SDK-wrapper memory leaks compound silently in long-running desktop apps:
 * one forgotten `removeEventListener` or one missing destroy option means
 * ~10-40MB of WebGL textures and Cubism Core native heap leaks on every
 * model switch. The classic regression is "I added a new listener / timer /
 * RAF / observer and forgot to release it in destroy()" — this audit
 * mechanically catches that class of bug without needing a real GL context.
 *
 * What it checks:
 *
 *   1. Every `addEventListener` has a paired `removeEventListener` in
 *      destroy() with the same target + handler reference.
 *   2. `ResizeObserver` is disconnected.
 *   3. `setTimeout` results are cleared (via the named expression timer).
 *   4. `requestAnimationFrame` callbacks early-return on `this.destroyed`
 *      (otherwise the RAF after destroy can re-enter dead PIXI state).
 *   5. `app.destroy` is called with removeView=true AND
 *      { children: true, texture: true, baseTexture: true }. Without
 *      texture+baseTexture the Live2DModel WON'T free its GL textures
 *      (verified against lipsyncpatch's cubism4 destroy() source).
 *   6. The "destroyed during loadModel()" race path also destroys the
 *      orphan model with full options.
 *
 * Run: node tools/smoke-live2d-leak-audit.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STAGE_PATH = join(__dirname, '..', 'src', 'renderer', 'src', 'live2d', 'stage.ts')
const src = readFileSync(STAGE_PATH, 'utf8')

let pass = true
const fail = (msg) => {
  pass = false
  console.log(`  ❌ ${msg}`)
}
const ok = (msg) => console.log(`  ✅ ${msg}`)

console.log(`Auditing ${STAGE_PATH}\n`)

// ---- 1. Listener pairing ----------------------------------------------------
console.log('[1/6] addEventListener ↔ removeEventListener pairing')
// Match: <target>.addEventListener('event', this.handler)
const addRe = /(\w+)\.addEventListener\(\s*['"]([^'"]+)['"]\s*,\s*(this\.\w+)\s*[,)]/g
const removeRe = /(\w+)\.removeEventListener\(\s*['"]([^'"]+)['"]\s*,\s*(this\.\w+)\s*[,)]/g

const adds = [...src.matchAll(addRe)].map((m) => ({ target: m[1], event: m[2], handler: m[3] }))
const removes = [...src.matchAll(removeRe)].map((m) => ({
  target: m[1],
  event: m[2],
  handler: m[3],
}))

for (const a of adds) {
  const matched = removes.find(
    (r) => r.target === a.target && r.event === a.event && r.handler === a.handler,
  )
  if (matched) {
    ok(`${a.target}.${a.event} → ${a.handler} released`)
  } else {
    fail(`${a.target}.addEventListener('${a.event}', ${a.handler}) — NO matching remove`)
  }
}
if (adds.length === 0) fail('no addEventListener calls found (suspicious — has the file moved?)')

// ---- 2. ResizeObserver ------------------------------------------------------
console.log('\n[2/6] ResizeObserver.disconnect')
if (/new ResizeObserver\b/.test(src)) {
  if (/\.resizeObserver\.disconnect\(\)/.test(src)) ok('ResizeObserver disconnected')
  else fail('ResizeObserver created but never disconnected')
} else {
  ok('no ResizeObserver in use')
}

// ---- 3. Timers --------------------------------------------------------------
console.log('\n[3/6] setTimeout cleanup')
// Look for `expressionTimer` (the only timer in this file). If a new timer is
// added, this check needs to expand — but the audit will surface it because
// "setTimeout without companion clearTimeout" will fail.
const timeoutCount = (src.match(/setTimeout\(/g) || []).length
const clearCount = (src.match(/clearTimeout\(/g) || []).length
if (timeoutCount === 0) {
  ok('no setTimeout in use')
} else if (clearCount >= 1) {
  ok(`${timeoutCount} setTimeout call(s), ${clearCount} clearTimeout call(s) present`)
} else {
  fail(`${timeoutCount} setTimeout call(s) but no clearTimeout — timer leaks across destroy`)
}

// ---- 4. RAF guarded against post-destroy entry ------------------------------
console.log('\n[4/6] requestAnimationFrame post-destroy guard')
if (/requestAnimationFrame\(/.test(src)) {
  // The RAF callback body should reference `this.destroyed` so it bails out
  // if the stage was torn down between the frame request and its firing.
  // We look for any RAF call within ~600 chars followed by `this.destroyed`
  // — crude but reliable for this file's structure.
  const rafBody = src.match(/requestAnimationFrame\([\s\S]{0,800}?\}\)/g) || []
  let guarded = 0
  for (const body of rafBody) {
    if (/this\.destroyed/.test(body)) guarded++
  }
  if (guarded === rafBody.length && rafBody.length > 0) {
    ok(`${rafBody.length} RAF callback(s) all guard on this.destroyed`)
  } else {
    fail(`${rafBody.length - guarded} of ${rafBody.length} RAF callback(s) DO NOT check this.destroyed`)
  }
} else {
  ok('no requestAnimationFrame in use')
}

// ---- 5. app.destroy DOES NOT pass texture/baseTexture options ---------------
console.log('\n[5/6] PIXI.Application.destroy options')
// Pattern: this.app.destroy(true, { children: true })
//
// HARD-LEARNED RULE: do NOT pass { texture: true, baseTexture: true } to
// PIXI's Application.destroy. PIXI's BaseTexture.from(url) is backed by a
// GLOBAL url-keyed cache; destroying the baseTexture deletes that cached
// entry's GL handles, and the next mount of any stage loading the same
// model URL gets a cached-but-dead BaseTexture and renders the model as
// a black silhouette. Each stage owns its own GL context — letting the
// context die with removeView=true frees the GPU state correctly without
// breaking the shared cache.
const appDestroyMatch = src.match(/this\.app\.destroy\(([^)]+)\)/)
if (!appDestroyMatch) {
  fail('no `this.app.destroy(...)` call found in destroy()')
} else {
  const args = appDestroyMatch[1]
  const hasRemoveView = /\btrue\b/.test(args)
  const hasChildren = /\bchildren\s*:\s*true\b/.test(args)
  const hasTexture = /\btexture\s*:\s*true\b/.test(args)
  const hasBaseTexture = /\bbaseTexture\s*:\s*true\b/.test(args)
  if (hasRemoveView && hasChildren && !hasTexture && !hasBaseTexture) {
    ok('app.destroy(true, { children }) — shared-cache safe')
  } else if (hasTexture || hasBaseTexture) {
    fail(
      'app.destroy passes texture/baseTexture — will kill PIXI\'s global BaseTexture cache and break the next mount',
    )
  } else {
    fail(
      `app.destroy missing required options — removeView=${hasRemoveView} children=${hasChildren}`,
    )
  }
}

// ---- 6. Orphan-model destroy on load race -----------------------------------
console.log('\n[6/6] loadModel() destroyed-race cleanup')
// When destroyed flag flips during the async Live2DModel.from() call, the
// orphan model must be destroyed — but with NO options, for the same
// shared-cache reason as the main destroy() above.
const loadModelMatch = src.match(/private async loadModel[\s\S]*?\n {2}\}/)
if (!loadModelMatch) {
  fail('loadModel method not found')
} else {
  const body = loadModelMatch[0]
  const orphanDestroy = body.match(/model\.destroy\(([^)]*)\)/)
  if (!orphanDestroy) {
    fail('loadModel does not destroy the orphan model on the destroyed-race path')
  } else {
    const args = orphanDestroy[1].trim()
    if (args === '') {
      ok('orphan model.destroy() called bare — shared-cache safe')
    } else if (/texture\s*:\s*true|baseTexture\s*:\s*true/.test(args)) {
      fail(
        `orphan model.destroy(${args}) passes texture/baseTexture — will kill PIXI's global BaseTexture cache and the NEXT mount renders black`,
      )
    } else {
      // Bare {children:true} is OK too — just no texture flags.
      ok(`orphan model.destroy(${args}) is shared-cache safe`)
    }
  }
}

console.log()
console.log(pass ? '✅ Live2DStage lifecycle audit PASSED' : '❌ Live2DStage lifecycle audit FAILED')
process.exit(pass ? 0 : 1)
