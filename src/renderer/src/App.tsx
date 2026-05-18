import { useEffect, useRef, useState } from 'react'

import type { ChatEvent } from '../../shared/ipc'
import { Live2DCanvas } from './live2d/Live2DCanvas'
import type { Live2DController } from './live2d/stage'

const MODEL_PATH = '/live2d-models/haitu_vts/海兔1.model3.json'

interface ToolCall {
  name: string
  args: unknown
  result?: unknown
}

// `-webkit-app-region` isn't in @types/react's CSSProperties yet. Bridge it.
type AppRegionStyle = React.CSSProperties & { WebkitAppRegion?: 'drag' | 'no-drag' }

const DEFAULT_CHAT_HEIGHT = 180
const MIN_CHAT_HEIGHT = 100
const MIN_LIVE2D_HEIGHT = 120

export default function App() {
  const [input, setInput] = useState('')
  const [reply, setReply] = useState('')
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [chatHeight, setChatHeight] = useState(DEFAULT_CHAT_HEIGHT)
  const activeIdRef = useRef<string | null>(null)
  const live2dRef = useRef<Live2DController>(null)

  useEffect(() => {
    return window.api.chat.onEvent((event: ChatEvent) => {
      if (event.messageId !== activeIdRef.current) return

      switch (event.type) {
        case 'text':
          setReply((r) => r + event.delta)
          break
        case 'tool-call':
          setToolCalls((tc) => [...tc, { name: event.toolName, args: event.args }])
          break
        case 'tool-result':
          setToolCalls((tc) => {
            const next = [...tc]
            for (let i = next.length - 1; i >= 0; i--) {
              if (next[i]!.name === event.toolName && next[i]!.result === undefined) {
                next[i] = { ...next[i]!, result: event.result }
                break
              }
            }
            return next
          })
          break
        case 'done':
          setBusy(false)
          break
        case 'error':
          setError(event.error)
          setBusy(false)
          break
      }
    })
  }, [])

  function send(): void {
    const text = input.trim()
    if (!text || busy) return
    setReply('')
    setToolCalls([])
    setError(null)
    setBusy(true)
    activeIdRef.current = window.api.chat.send(text)
    setInput('')
  }

  // Vertical splitter between Live2D and chat. Drag up → chat grows,
  // Live2D shrinks. State is clamped so neither pane disappears.
  function startSplitterDrag(e: React.MouseEvent): void {
    e.preventDefault()
    const startY = e.clientY
    const startH = chatHeight
    const maxH = window.innerHeight - MIN_LIVE2D_HEIGHT - 24 /* top drag bar */
    const onMove = (ev: MouseEvent): void => {
      // Dragging upward (clientY decreases) increases chat height.
      const dy = startY - ev.clientY
      setChatHeight(Math.max(MIN_CHAT_HEIGHT, Math.min(maxH, startH + dy)))
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const dragRegion: AppRegionStyle = { WebkitAppRegion: 'drag' }
  const noDragRegion: AppRegionStyle = { WebkitAppRegion: 'no-drag' }

  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        // Window is `transparent: true, frame: false`, so the whole root must
        // also be transparent to let the desktop show through.
        background: 'transparent',
      }}
    >
      {/* Title bar — visible band at the top of the frameless window so users
          can see where to grab to drag the window. Translucent so the desktop
          still shows faintly through. */}
      <div
        style={{
          ...dragRegion,
          height: 28,
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 10px',
          background: 'rgba(255, 255, 255, 0.78)',
          backdropFilter: 'blur(10px)',
          borderBottom: '1px solid rgba(0, 0, 0, 0.06)',
          fontFamily: 'system-ui, sans-serif',
          fontSize: 12,
          color: '#555',
          userSelect: 'none',
        }}
      >
        <span>OpenMeido</span>
        <button
          onClick={() => window.close()}
          title="Close"
          style={{
            ...noDragRegion,
            width: 20,
            height: 20,
            border: 'none',
            borderRadius: 10,
            background: 'rgba(0,0,0,0.25)',
            color: 'white',
            fontSize: 13,
            lineHeight: '20px',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          ×
        </button>
      </div>

      {/* Live2D stage — fills the bulk of the window, transparent BG so the
          desktop shows through everywhere except where the character renders. */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <Live2DCanvas ref={live2dRef} modelPath={MODEL_PATH} fitMode="portrait" />
        {/* Slice 2 test controls — floating top-left, no-drag so they're clickable. */}
        <div
          style={{
            ...noDragRegion,
            position: 'absolute',
            top: 4,
            left: 8,
            display: 'flex',
            gap: 4,
            fontSize: 11,
          }}
        >
          <button onClick={() => live2dRef.current?.randomExpression()}>随机表情</button>
          <button onClick={() => live2dRef.current?.clearExpression()}>清</button>
          <button onClick={() => live2dRef.current?.randomMotion()}>随机动作</button>
          <button onClick={() => live2dRef.current?.resetPosition()}>复位</button>
        </div>
      </div>

      {/* Invisible vertical resizer — 6px hit zone, no visual chrome. Cursor
          turns into ns-resize when hovering between panes, which is the only
          hint users get that the boundary is draggable. */}
      <div
        onMouseDown={startSplitterDrag}
        title="拖动以调整聊天区高度"
        style={{
          ...noDragRegion,
          flex: '0 0 auto',
          height: 6,
          cursor: 'ns-resize',
          background: 'transparent',
        }}
      />

      {/* Chat panel — translucent card at the bottom, no-drag so the input
          and buttons receive normal clicks instead of starting a window drag.
          Height is controlled by chatHeight state and the splitter above. */}
      <div
        style={{
          ...noDragRegion,
          flex: '0 0 auto',
          height: chatHeight,
          padding: 12,
          background: 'rgba(255, 255, 255, 0.88)',
          backdropFilter: 'blur(8px)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          fontFamily: 'system-ui, sans-serif',
          overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            placeholder="试试：提醒我五分钟后喝水"
            disabled={busy}
            style={{ flex: 1, padding: '6px 10px', fontSize: 13 }}
          />
          <button onClick={send} disabled={busy || !input.trim()} style={{ padding: '6px 14px' }}>
            {busy ? '…' : 'Send'}
          </button>
        </div>

        {error && (
          <pre style={{ color: '#c00', whiteSpace: 'pre-wrap', margin: 0, fontSize: 12 }}>
            [error] {error}
          </pre>
        )}

        {toolCalls.length > 0 && (
          <div style={{ fontSize: 11, color: '#666' }}>
            {toolCalls.map((tc, i) => (
              <div
                key={i}
                style={{ borderLeft: '3px solid #ddd', padding: '3px 6px', marginBottom: 3 }}
              >
                <div>
                  <b>{tc.name}</b> {JSON.stringify(tc.args)}
                </div>
                {tc.result !== undefined && <div>→ {JSON.stringify(tc.result)}</div>}
              </div>
            ))}
          </div>
        )}

        {(reply || busy) && (
          <div
            style={{
              padding: 8,
              background: 'rgba(0, 0, 0, 0.04)',
              borderRadius: 6,
              maxHeight: 140,
              overflowY: 'auto',
              whiteSpace: 'pre-wrap',
              lineHeight: 1.5,
              fontSize: 13,
            }}
          >
            {reply || 'thinking…'}
          </div>
        )}
      </div>
    </div>
  )
}
