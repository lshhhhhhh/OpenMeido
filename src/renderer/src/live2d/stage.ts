/**
 * Live2DStage — a thin, imperative TS class that owns one PIXI.Application
 * and one Live2D model. React never touches the PIXI tree after mount.
 *
 * Slice 1 scope: just init pixi, load a model, fit it once. Drag, expressions,
 * eye-tracking, mouth sync land in slice 2.
 *
 * Why a class (not a React component): pixi-live2d-display is imperative by
 * nature, and React 19 StrictMode double-mounts every effect. A plain class
 * with explicit destroy() is easier to reason about than dancing around React
 * lifecycle invariants — and matches how everyone bridges pixi.js / three.js
 * to React in practice.
 */

import * as PIXI from 'pixi.js'
// Import from the /cubism4 sub-entry, NOT the package root.
// The root entry loads both the Cubism 2 and Cubism 4 runtimes and throws if
// either is missing — we only have Cubism 4's runtime (live2dcubismcore.min.js)
// vendored in public/, so the root entry would crash at module-eval time.
import { Live2DModel } from 'pixi-live2d-display-lipsyncpatch/cubism4'

// Force WebGL 1, not WebGL 2. PIXI v7 prefers WebGL 2 by default, but Electron
// 33 (Chromium 130) returns a broken WebGL 2 context here — MAX_TEXTURE_IMAGE_UNITS
// reports 0, which crashes PIXI's BatchRenderer with "Invalid value of `0` passed
// to checkMaxIfStatementsInShader". A plain `getContext('webgl')` (v1) probe on
// the same renderer reports the correct 16/16384, so v1 is healthy. We keep
// multi-texture batching (NOT WEBGL_LEGACY), so Cubism's high-poly meshes still
// render with full 32-bit index support.
PIXI.settings.PREFER_ENV = PIXI.ENV.WEBGL

// pixi-live2d-display needs PIXI's Ticker to drive the model's update loop.
// registerTicker only has to be called once per page — repeated calls are
// no-ops, so this is safe at module scope.
Live2DModel.registerTicker(PIXI.Ticker)

/**
 * At runtime, Live2DModel extends PIXI.Container — but the lipsyncpatch
 * fork's bundled .d.ts predates pixi.js v7's Container type, so TS sees
 * Live2DModel as missing scale/x/y/parent/etc. Bridge it with an intersection.
 */
type Live2DDisplayable = Live2DModel & PIXI.Container

export type FitMode = 'portrait' | 'fit'

export interface Live2DStageOptions {
  host: HTMLElement
  modelPath: string
  fitMode?: FitMode
}

export class Live2DStage {
  private readonly app: PIXI.Application
  private readonly canvas: HTMLCanvasElement
  private readonly host: HTMLElement
  private readonly resizeObserver: ResizeObserver
  private model: Live2DDisplayable | null = null
  private fitMode: FitMode
  private destroyed = false

  constructor(opts: Live2DStageOptions) {
    this.fitMode = opts.fitMode ?? 'portrait'
    this.host = opts.host

    // Create OUR OWN canvas each time. Sharing a canvas across React
    // StrictMode mount → cleanup → re-mount cycles produces a stale WebGL
    // context on the second mount; Chromium returns a context whose
    // gl.getParameter(MAX_TEXTURE_IMAGE_UNITS) is 0, which crashes PIXI's
    // BatchRenderer init. Fresh canvas == fresh GL context == clean.
    this.canvas = document.createElement('canvas')
    this.canvas.style.display = 'block'
    this.canvas.style.width = '100%'
    this.canvas.style.height = '100%'
    opts.host.appendChild(this.canvas)

    this.app = new PIXI.Application({
      view: this.canvas,
      resizeTo: opts.host,
      backgroundAlpha: 0,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    })

    this.resizeObserver = new ResizeObserver(() => this.fit())
    this.resizeObserver.observe(opts.host)

    void this.loadModel(opts.modelPath)
  }

  private async loadModel(path: string): Promise<void> {
    try {
      const loaded = await Live2DModel.from(path, { autoHitTest: false, autoFocus: false })
      const model = loaded as unknown as Live2DDisplayable
      if (this.destroyed) {
        model.destroy()
        return
      }
      this.model = model
      this.app.stage.addChild(model)
      this.fit()
    } catch (err) {
      console.error('[Live2DStage] model load failed:', err, 'path:', path)
    }
  }

  private fit(): void {
    if (!this.model) return
    // Stage dimensions in CSS pixels (autoDensity scales the canvas backbuffer
    // by devicePixelRatio, but renderer.width/height stays in backbuffer units,
    // so divide by resolution to get layout pixels.)
    const sw = this.app.renderer.width / this.app.renderer.resolution
    const sh = this.app.renderer.height / this.app.renderer.resolution
    const mw = this.model.internalModel.originalWidth || 1
    const mh = this.model.internalModel.originalHeight || 1

    if (this.fitMode === 'portrait') {
      // Hug top edge, scale to fill width — head + upper body visible.
      this.model.scale.set(sw / mw)
      this.model.anchor.set(0.5, 0.0)
      this.model.x = sw / 2
      this.model.y = 0
    } else {
      // Letterbox the full model into the stage with a little margin.
      this.model.scale.set(Math.min(sw / mw, sh / mh) * 0.95)
      this.model.anchor.set(0.5, 0.5)
      this.model.x = sw / 2
      this.model.y = sh / 2
    }
  }

  setFitMode(mode: FitMode): void {
    this.fitMode = mode
    this.fit()
  }

  destroy(): void {
    this.destroyed = true
    this.resizeObserver.disconnect()
    // Pass removeView=true so PIXI also removes the canvas from the DOM,
    // and the GL context dies with it. Next mount will create a fresh canvas.
    this.app.destroy(true, { children: true, texture: true, baseTexture: true })
    this.model = null
  }
}
