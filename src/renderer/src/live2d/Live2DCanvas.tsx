import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'

import { Live2DStage, type FitMode, type Live2DController } from './stage'

interface Live2DCanvasProps {
  modelPath: string
  fitMode?: FitMode
  portraitZoom?: number
  className?: string
  style?: React.CSSProperties
}

/**
 * React wrapper around Live2DStage. The class owns the canvas + WebGL
 * context; React owns a host <div> and forwards a typed controller ref so
 * the parent component can call `ref.current.setExpression(...)` etc.
 *
 * Why React doesn't own the canvas: in StrictMode dev, every effect runs
 * mount → cleanup → re-mount. If we kept the same <canvas> across that
 * cycle, the second PIXI app would inherit a stale WebGL context whose
 * GL parameter queries return 0, crashing init. Letting PIXI own the
 * canvas means each mount gets a brand-new GL context.
 */
export const Live2DCanvas = forwardRef<Live2DController | null, Live2DCanvasProps>(
  function Live2DCanvas({ modelPath, fitMode, portraitZoom, className, style }, ref) {
    const hostRef = useRef<HTMLDivElement>(null)
    const stageRef = useRef<Live2DStage | null>(null)

    // Forward all controller calls to whatever Live2DStage instance is
    // currently mounted. Returning null methods when no stage exists keeps
    // callers from crashing during the brief window before useEffect runs.
    useImperativeHandle(
      ref,
      (): Live2DController => ({
        setExpression: (idOrName, opts) => stageRef.current?.setExpression(idOrName, opts),
        clearExpression: () => stageRef.current?.clearExpression(),
        randomExpression: () => stageRef.current?.randomExpression(),
        playMotion: (group, index) => stageRef.current?.playMotion(group, index),
        randomMotion: () => stageRef.current?.randomMotion(),
        setMouthOpen: (v) => stageRef.current?.setMouthOpen(v),
        setFitMode: (m) => stageRef.current?.setFitMode(m),
        resetPosition: () => stageRef.current?.resetPosition(),
        isOverModel: (cx, cy) => stageRef.current?.isOverModel(cx, cy) ?? 'outside',
        info: () => stageRef.current?.info() ?? null,
      }),
      [],
    )

    // Mount-time stage creation. Only modelPath is in the dep array — fitMode
    // and portraitZoom are pushed in via separate effects below to avoid a
    // costly full PIXI/model reload when the user just tweaks zoom.
    useEffect(() => {
      const host = hostRef.current
      if (!host) return
      const stage = new Live2DStage({ host, modelPath, fitMode, portraitZoom })
      stageRef.current = stage
      return () => {
        stage.destroy()
        stageRef.current = null
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [modelPath])

    // Live-tunable props.
    useEffect(() => {
      if (fitMode) stageRef.current?.setFitMode(fitMode)
    }, [fitMode])
    useEffect(() => {
      if (portraitZoom !== undefined) stageRef.current?.setPortraitZoom(portraitZoom)
    }, [portraitZoom])

    return (
      <div
        ref={hostRef}
        className={className}
        style={{ width: '100%', height: '100%', overflow: 'hidden', ...style }}
      />
    )
  },
)
