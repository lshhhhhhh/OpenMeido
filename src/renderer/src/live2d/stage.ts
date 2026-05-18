/**
 * Live2DStage — imperative class that owns one PIXI.Application and one
 * Live2D model, plus all the product-polish behaviors: eye tracking, drag,
 * expression API, mouth amplitude API.
 *
 * React owns nothing inside this class. The renderer hands us a host <div>
 * and we manage the <canvas> + all DOM event listeners ourselves.
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

/**
 * The fields the lipsyncpatch d.ts is missing on internalModel.settings /
 * coreModel. These exist at runtime for any Cubism 4 model; the .d.ts is
 * just over-conservative. Narrow shape only — we don't model every field.
 */
interface CubismSettingsShape {
  expressions?: { Name: string; File: string }[]
  motions?: Record<string, unknown[]>
}
interface CubismCoreShape {
  setParameterValueById: (id: string, value: number) => void
}

export type FitMode = 'portrait' | 'fit'

export interface Live2DStageOptions {
  host: HTMLElement
  modelPath: string
  fitMode?: FitMode
  /** In 'portrait' mode, scale the model so it's this many canvas widths wide. >1 crops the body off. */
  portraitZoom?: number
  /** Cubism parameter id driving the mouth-open value (0–1). Default for most VTuber models. */
  mouthParamId?: string
  /** Auto-clear an emoted expression after this many ms. 0 = sticky. */
  expressionDecayMs?: number
}

/**
 * Public surface the React/UI side gets through a ref. Matches what
 * imouto-oss exposed on `window.imouto`, but typed.
 */
export interface Live2DController {
  setExpression(idOrName?: string | number, opts?: { decay?: boolean }): void
  clearExpression(): void
  randomExpression(): void
  playMotion(group: string, index?: number): void
  randomMotion(): void
  /** Amplitude driver for TTS lip-sync. Value clamped to [0, 1]. */
  setMouthOpen(value: number): void
  setFitMode(mode: FitMode): void
  resetPosition(): void
  /** Inspect available motions/expressions for debugging. */
  info(): {
    width: number
    height: number
    motions: string[]
    expressions: string[]
  } | null
}

export class Live2DStage implements Live2DController {
  private readonly app: PIXI.Application
  private readonly canvas: HTMLCanvasElement
  private readonly host: HTMLElement
  private readonly resizeObserver: ResizeObserver
  private model: Live2DDisplayable | null = null
  private fitMode: FitMode
  private portraitZoom: number
  private mouthParamId: string
  private expressionDecayMs: number
  private expressionTimer: ReturnType<typeof setTimeout> | null = null

  // Drag state.
  private userPos: { x: number; y: number } | null = null
  private hovered = false
  private dragging = false
  private dragOffset = { x: 0, y: 0 }
  private destroyed = false

  // Focus throttling. mousemove fires up to ~120Hz on high-refresh displays
  // and Cubism's hair physics resonates when the focus target updates that
  // fast with noisy mouse coords. Coalesce updates to one per animation frame.
  private pendingFocus: { x: number; y: number } | null = null
  private focusRafPending = false

  // Bound listener refs so removeEventListener can find them.
  private readonly onMouseMove = (e: MouseEvent): void => this.handleMouseMove(e)
  private readonly onMouseDown = (e: MouseEvent): void => this.handleMouseDown(e)
  private readonly onMouseUp = (): void => {
    this.dragging = false
  }
  private readonly onDoubleClick = (e: MouseEvent): void => this.handleDoubleClick(e)

  constructor(opts: Live2DStageOptions) {
    this.fitMode = opts.fitMode ?? 'portrait'
    this.portraitZoom = opts.portraitZoom ?? 1.6
    this.mouthParamId = opts.mouthParamId ?? 'ParamMouthOpenY'
    this.expressionDecayMs = opts.expressionDecayMs ?? 8000
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
    // Start with events disabled so empty stage area lets clicks pass to
    // the React layer underneath. handleMouseMove toggles this on hover.
    this.canvas.style.pointerEvents = 'none'
    opts.host.appendChild(this.canvas)

    this.app = new PIXI.Application({
      view: this.canvas,
      resizeTo: opts.host,
      backgroundAlpha: 0,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    })

    // Cap the renderer to 60 FPS. PIXI v7 has no max-FPS by default and
    // happily runs at 120/144 Hz on high-refresh displays, but Cubism's
    // physics step is tuned for ~60 Hz dt — at higher rates the spring
    // integration becomes unstable and hair / accessories visibly oscillate
    // even when the head is still.
    this.app.ticker.maxFPS = 60

    this.resizeObserver = new ResizeObserver(() => this.fit())
    this.resizeObserver.observe(opts.host)

    // mousemove on window so we keep tracking even when the cursor leaves
    // the canvas; mousedown only on the canvas (so the React panel below
    // still gets its own clicks).
    window.addEventListener('mousemove', this.onMouseMove)
    window.addEventListener('mouseup', this.onMouseUp)
    this.canvas.addEventListener('mousedown', this.onMouseDown)
    this.canvas.addEventListener('dblclick', this.onDoubleClick)

    void this.loadModel(opts.modelPath)
  }

  // -------------------- model lifecycle --------------------

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
    // Force PIXI to re-poll the host's dimensions NOW. PIXI normally syncs
    // via `resizeTo` on each ticker tick, but ResizeObserver fires between
    // layout and the next animation frame — without this call we'd read
    // stale renderer.width and rescale the model to the old canvas size,
    // leaving a transparent strip where the canvas grew.
    this.app.resize()
    const sw = this.app.renderer.width / this.app.renderer.resolution
    const sh = this.app.renderer.height / this.app.renderer.resolution
    const mw = this.model.internalModel.originalWidth || 1
    const mh = this.model.internalModel.originalHeight || 1

    let baseX: number
    let baseY: number
    if (this.fitMode === 'portrait') {
      // Zoom in so only the upper body fits in the canvas — lower body
      // falls below the visible area. Configurable via Live2DStageOptions;
      // 1.6 default. Head must still fit horizontally — avoid pushing past
      // ~1.8 unless the model's head/body width ratio is small.
      this.model.scale.set((sw / mw) * this.portraitZoom)
      this.model.anchor.set(0.5, 0.0)
      baseX = sw / 2
      baseY = 0
    } else {
      this.model.scale.set(Math.min(sw / mw, sh / mh) * 0.95)
      this.model.anchor.set(0.5, 0.5)
      baseX = sw / 2
      baseY = sh / 2
    }

    // User-dragged position overrides auto-fit until they double-click reset.
    if (this.userPos) {
      this.model.x = this.userPos.x
      this.model.y = this.userPos.y
    } else {
      this.model.x = baseX
      this.model.y = baseY
    }
  }

  // -------------------- mouse handling --------------------

  /** Convert viewport (clientX/Y) coords to canvas-local coords. */
  private toCanvasCoords(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect()
    return { x: clientX - rect.left, y: clientY - rect.top }
  }

  private isInsideModel(canvasX: number, canvasY: number): boolean {
    if (!this.model) return false
    const b = this.model.getBounds()
    return canvasX >= b.x && canvasX <= b.x + b.width && canvasY >= b.y && canvasY <= b.y + b.height
  }

  private handleMouseMove(e: MouseEvent): void {
    if (!this.model) return
    const { x, y } = this.toCanvasCoords(e.clientX, e.clientY)

    // 1) eye + head tracking. CLAMP to canvas bounds — when the mouse is
    //    over the chat area below, raw (x, y) becomes negative / oversized
    //    and Cubism interprets that as a max-angle head turn, which sets
    //    the hair physics into a resonance loop. Throttle to one update
    //    per RAF so 120Hz mousemoves don't fight the physics tick.
    const rect = this.canvas.getBoundingClientRect()
    const cx = Math.max(0, Math.min(rect.width, x))
    const cy = Math.max(0, Math.min(rect.height, y))
    this.queueFocusUpdate(cx, cy)

    // 2) drag in progress
    if (this.dragging) {
      this.userPos = { x: x - this.dragOffset.x, y: y - this.dragOffset.y }
      this.model.x = this.userPos.x
      this.model.y = this.userPos.y
      return
    }

    // 3) hover state — toggle pointer-events so empty canvas area lets
    // clicks pass through to the chat layer below.
    const over = this.isInsideModel(x, y)
    if (over !== this.hovered) {
      this.hovered = over
      this.canvas.style.pointerEvents = over ? 'auto' : 'none'
      this.canvas.style.cursor = over ? 'move' : 'default'
    }
  }

  private queueFocusUpdate(x: number, y: number): void {
    this.pendingFocus = { x, y }
    if (this.focusRafPending) return
    this.focusRafPending = true
    requestAnimationFrame(() => {
      this.focusRafPending = false
      if (this.destroyed || !this.model || !this.pendingFocus) return
      try {
        this.model.focus(this.pendingFocus.x, this.pendingFocus.y)
      } catch {
        /* model not ready yet */
      }
    })
  }

  private handleMouseDown(e: MouseEvent): void {
    if (e.button !== 0 || !this.model) return
    const { x, y } = this.toCanvasCoords(e.clientX, e.clientY)
    if (!this.isInsideModel(x, y)) return
    this.dragging = true
    this.dragOffset = { x: x - this.model.x, y: y - this.model.y }
    e.preventDefault()
  }

  private handleDoubleClick(e: MouseEvent): void {
    if (!this.model) return
    const { x, y } = this.toCanvasCoords(e.clientX, e.clientY)
    if (!this.isInsideModel(x, y)) return
    this.userPos = null
    this.fit()
  }

  // -------------------- public controller API --------------------

  setExpression(idOrName?: string | number, opts?: { decay?: boolean }): void {
    if (!this.model) return
    try {
      this.model.expression(idOrName)
    } catch (err) {
      console.warn('[Live2DStage] expression failed:', err)
      return
    }
    if (opts?.decay !== false) this.scheduleExpressionDecay()
  }

  clearExpression(): void {
    this.clearExpressionTimer()
    if (!this.model) return
    try {
      // Calling expression() with no arg clears the current one.
      this.model.expression()
    } catch (err) {
      console.warn('[Live2DStage] clearExpression failed:', err)
    }
  }

  randomExpression(): void {
    if (!this.model) return
    const settings = this.model.internalModel.settings as unknown as CubismSettingsShape
    const exprs = settings.expressions
    if (!exprs?.length) return
    const i = Math.floor(Math.random() * exprs.length)
    this.setExpression(i)
  }

  playMotion(group: string, index?: number): void {
    if (!this.model) return
    try {
      this.model.motion(group, index)
    } catch (err) {
      console.warn('[Live2DStage] motion failed:', err)
    }
  }

  randomMotion(): void {
    if (!this.model) return
    const settings = this.model.internalModel.settings as unknown as CubismSettingsShape
    const motionMap = settings.motions
    const groups = motionMap ? Object.keys(motionMap) : []
    if (!groups.length) return
    const g = groups[Math.floor(Math.random() * groups.length)]!
    this.playMotion(g)
  }

  setMouthOpen(value: number): void {
    if (!this.model) return
    const v = Math.max(0, Math.min(1, Number(value) || 0))
    const core = this.model.internalModel.coreModel as unknown as CubismCoreShape
    try {
      core.setParameterValueById(this.mouthParamId, v)
    } catch {
      /* parameter id wrong for this model — silently skip */
    }
  }

  setFitMode(mode: FitMode): void {
    this.fitMode = mode
    this.userPos = null
    this.fit()
  }

  setPortraitZoom(zoom: number): void {
    this.portraitZoom = zoom
    this.fit()
  }

  resetPosition(): void {
    this.userPos = null
    this.fit()
  }

  info(): ReturnType<Live2DController['info']> {
    if (!this.model) return null
    const s = this.model.internalModel.settings as unknown as CubismSettingsShape
    return {
      width: this.model.internalModel.originalWidth,
      height: this.model.internalModel.originalHeight,
      motions: s.motions ? Object.keys(s.motions) : [],
      expressions: (s.expressions ?? []).map((e) => e.Name),
    }
  }

  // -------------------- internals --------------------

  private clearExpressionTimer(): void {
    if (this.expressionTimer !== null) {
      clearTimeout(this.expressionTimer)
      this.expressionTimer = null
    }
  }

  private scheduleExpressionDecay(): void {
    this.clearExpressionTimer()
    if (this.expressionDecayMs <= 0) return
    this.expressionTimer = setTimeout(() => {
      this.clearExpression()
    }, this.expressionDecayMs)
  }

  destroy(): void {
    this.destroyed = true
    this.clearExpressionTimer()
    this.resizeObserver.disconnect()
    window.removeEventListener('mousemove', this.onMouseMove)
    window.removeEventListener('mouseup', this.onMouseUp)
    this.canvas.removeEventListener('mousedown', this.onMouseDown)
    this.canvas.removeEventListener('dblclick', this.onDoubleClick)
    // Pass removeView=true so PIXI also removes the canvas from the DOM,
    // and the GL context dies with it. Next mount will create a fresh canvas.
    this.app.destroy(true, { children: true, texture: true, baseTexture: true })
    this.model = null
  }
}
