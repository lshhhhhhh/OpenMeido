import { useEffect, useRef } from 'react'

import { Live2DStage, type FitMode } from './stage'

interface Live2DCanvasProps {
  modelPath: string
  fitMode?: FitMode
  className?: string
  style?: React.CSSProperties
}

/**
 * React wrapper. Provides a host <div>; the Live2DStage class creates and
 * destroys its own <canvas> inside that div on each mount.
 *
 * Why React doesn't own the canvas: in StrictMode dev, every effect runs
 * mount → cleanup → re-mount. If we kept the same <canvas> across that
 * cycle, the second PIXI app would inherit a stale WebGL context whose
 * GL parameter queries return 0, crashing init. Letting PIXI own the
 * canvas means each mount gets a brand-new GL context.
 */
export function Live2DCanvas({ modelPath, fitMode, className, style }: Live2DCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const stage = new Live2DStage({ host, modelPath, fitMode })
    return () => stage.destroy()
  }, [modelPath, fitMode])

  return (
    <div
      ref={hostRef}
      className={className}
      style={{ width: '100%', height: '100%', overflow: 'hidden', ...style }}
    />
  )
}
