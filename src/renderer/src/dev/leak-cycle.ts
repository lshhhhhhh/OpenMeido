/**
 * Live2D / PIXI memory-leak cycle smoke (dev-only).
 *
 * Why a runtime test alongside the static audit:
 *   The static audit (tools/smoke-live2d-leak-audit.mjs) catches the
 *   common regression — "added a listener / timer / observer, forgot the
 *   matching release." It can't catch what's invisible to source-level
 *   inspection:
 *     - WebGL texture handles leaking inside Live2DModel
 *     - Cubism Core native heap not freed (csmReleaseMocInPlace)
 *     - PIXI BatchRenderer holding shader refs after destroy
 *     - hidden cache growth inside lipsyncpatch's Live2DFactory
 *   Those require an actual mount/destroy cycle against a real model.
 *
 * Usage (from DevTools console in dev):
 *   await window.__leakTest.run({ cycles: 10 })          // uses default model
 *   await window.__leakTest.run({ cycles: 20, modelPath: '/live2d-models/foo/foo.model3.json' })
 *
 * The cycle:
 *   1. Force a GC if exposed (Electron with --js-flags=--expose-gc).
 *   2. Sample baseline heap.
 *   3. For each cycle: create Live2DStage in a detached host div, await
 *      model load (up to 10s), destroy(), remove the host div.
 *   4. Sample heap after each cycle.
 *   5. Print a table + verdict.
 *
 * Verdict heuristics:
 *   - Cycles 0-1 are warm-up: caches fill, expected to grow.
 *   - Cycles 2-N should plateau. If usedJSHeapSize keeps climbing
 *     monotonically with a slope > 5MB/cycle, that's a leak signal.
 *   - canvas-element count after teardown should equal pre-cycle baseline.
 *
 * IMPORTANT: this module must NOT be imported in prod builds. It's
 * gated behind `import.meta.env.DEV` at the call site.
 */

import { Live2DStage } from '../live2d/stage'

interface CycleResult {
  cycle: number
  heapUsedMB: number
  heapDeltaMB: number
  canvasCount: number
  durationMs: number
}

interface PerformanceMemory {
  usedJSHeapSize: number
  totalJSHeapSize: number
  jsHeapSizeLimit: number
}

declare global {
  interface Performance {
    memory?: PerformanceMemory
  }
  interface Window {
    gc?: () => void
    __leakTest?: { run: (opts?: LeakRunOptions) => Promise<LeakReport> }
  }
}

interface LeakRunOptions {
  cycles?: number
  modelPath?: string
  loadTimeoutMs?: number
  /** Delay between cycles to let pending IO / GC settle (ms). */
  settleMs?: number
}

interface LeakReport {
  results: CycleResult[]
  verdict: 'pass' | 'warn' | 'fail'
  reason: string
}

function maybeGc(): void {
  // window.gc is only present if Electron is launched with
  // --js-flags="--expose-gc". When absent we fall through silently —
  // V8's lazy GC will still run between heap samples, but precision drops.
  try {
    window.gc?.()
  } catch {
    /* no-op */
  }
}

function heapMB(): number {
  const m = performance.memory?.usedJSHeapSize
  return m ? m / (1024 * 1024) : NaN
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Wait until the stage's underlying canvas has at least one Live2D model
 * rendered (any sprite addded to the PIXI stage). We don't have a public
 * "loaded" event on Live2DStage, so we poll its `info()` controller getter
 * — info() returns null until the model is fully attached.
 */
async function waitForModelReady(stage: Live2DStage, timeoutMs: number): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (stage.info()) return true
    await sleep(50)
  }
  return false
}

export async function runLeakCycle(opts: LeakRunOptions = {}): Promise<LeakReport> {
  const cycles = opts.cycles ?? 10
  const modelPath = opts.modelPath ?? '/live2d-models/haitu_vts/haitu_vts.model3.json'
  const loadTimeout = opts.loadTimeoutMs ?? 10_000
  const settleMs = opts.settleMs ?? 250

  if (!performance.memory) {
    console.warn(
      '[leak-test] performance.memory unavailable — heap deltas will be NaN. ' +
        'Launch with --enable-precise-memory-info if you need numbers.',
    )
  }

  maybeGc()
  await sleep(settleMs)
  const baseline = heapMB()
  const baselineCanvases = document.querySelectorAll('canvas').length

  console.log(
    `[leak-test] starting ${cycles} cycles, model=${modelPath}, baseline heap=${baseline.toFixed(1)}MB, canvases=${baselineCanvases}`,
  )

  const results: CycleResult[] = []
  let lastHeap = baseline

  for (let i = 0; i < cycles; i++) {
    const t0 = performance.now()
    const host = document.createElement('div')
    host.style.position = 'fixed'
    host.style.left = '-10000px'
    host.style.top = '0'
    host.style.width = '400px'
    host.style.height = '600px'
    host.style.pointerEvents = 'none'
    document.body.appendChild(host)

    const stage = new Live2DStage({ host, modelPath })
    const ready = await waitForModelReady(stage, loadTimeout)
    if (!ready) {
      console.warn(`[leak-test] cycle ${i}: model not ready within ${loadTimeout}ms — destroying anyway`)
    }
    stage.destroy()
    host.remove()

    maybeGc()
    await sleep(settleMs)
    const heap = heapMB()
    const dur = performance.now() - t0
    const result: CycleResult = {
      cycle: i,
      heapUsedMB: Number(heap.toFixed(1)),
      heapDeltaMB: Number((heap - lastHeap).toFixed(1)),
      canvasCount: document.querySelectorAll('canvas').length,
      durationMs: Math.round(dur),
    }
    results.push(result)
    lastHeap = heap
    console.log(
      `[leak-test] cycle ${i}: heap=${result.heapUsedMB}MB Δ=${result.heapDeltaMB}MB canvases=${result.canvasCount} (${result.durationMs}ms)`,
    )
  }

  console.table(results)

  // ---- Verdict ----
  // Skip the first 2 cycles (warm-up: bge cache, font cache, shader compile).
  // Then check the slope of usedJSHeapSize over cycles 2..N — if it's
  // climbing > 5MB/cycle on average AND monotonic in >=70% of steps,
  // call it a leak. Otherwise pass.
  let verdict: LeakReport['verdict'] = 'pass'
  let reason = 'no monotonic heap growth detected'

  const trailingCanvases = results[results.length - 1]!.canvasCount
  if (trailingCanvases > baselineCanvases) {
    verdict = 'fail'
    reason = `${trailingCanvases - baselineCanvases} orphan canvas element(s) remain in DOM after teardown`
  } else if (!Number.isNaN(baseline) && results.length > 3) {
    const tail = results.slice(2)
    const monotonicSteps = tail
      .slice(1)
      .filter((r, i) => r.heapUsedMB > tail[i]!.heapUsedMB + 0.5).length
    const slope = (tail[tail.length - 1]!.heapUsedMB - tail[0]!.heapUsedMB) / (tail.length - 1)
    const monotonicFraction = tail.length > 1 ? monotonicSteps / (tail.length - 1) : 0
    if (slope > 5 && monotonicFraction > 0.7) {
      verdict = 'fail'
      reason = `heap climbs ~${slope.toFixed(1)}MB/cycle and is monotonic in ${(monotonicFraction * 100).toFixed(0)}% of steps`
    } else if (slope > 2) {
      verdict = 'warn'
      reason = `heap drifting up ~${slope.toFixed(1)}MB/cycle (sub-threshold; could be cache fill or could be a slow leak)`
    }
  } else if (Number.isNaN(baseline)) {
    verdict = 'warn'
    reason = 'no performance.memory available — only canvas-count check ran'
  }

  console.log(
    `[leak-test] verdict: ${verdict.toUpperCase()} — ${reason}\n  baseline=${baseline.toFixed(1)}MB, final=${lastHeap.toFixed(1)}MB, total Δ=${(lastHeap - baseline).toFixed(1)}MB`,
  )
  return { results, verdict, reason }
}

/** Auto-installs window.__leakTest in dev. Call once from main.tsx. */
export function installDevLeakTest(): void {
  window.__leakTest = { run: runLeakCycle }
  console.log('[leak-test] window.__leakTest.run() installed — call from DevTools to cycle')
}
