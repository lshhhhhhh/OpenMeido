import { useEffect, useRef, useState } from 'react'

import type { ChatEvent } from '../../shared/ipc'
import { Live2DCanvas } from './live2d/Live2DCanvas'
import type { Live2DController } from './live2d/stage'
import { Settings } from './Settings'
import { useConfig } from './useConfig'

interface ToolCall {
  name: string
  args: unknown
  result?: unknown
}

interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
  toolCalls?: ToolCall[]
}

// `-webkit-app-region` isn't in @types/react's CSSProperties yet. Bridge it.
type AppRegionStyle = React.CSSProperties & { WebkitAppRegion?: 'drag' | 'no-drag' }

const DEFAULT_CHAT_HEIGHT = 180
const MIN_CHAT_HEIGHT = 100
const MIN_LIVE2D_HEIGHT = 120

export default function App() {
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [chatHeight, setChatHeight] = useState(DEFAULT_CHAT_HEIGHT)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const activeIdRef = useRef<string | null>(null)
  const live2dRef = useRef<Live2DController>(null)
  const messageListRef = useRef<HTMLDivElement>(null)
  const config = useConfig()

  // Append a text delta or a tool event to the LAST assistant message. We
  // create that message synchronously in send() so by the time stream events
  // arrive, there's always a tail to append to.
  function patchLastAssistant(patch: (m: ChatMessage) => ChatMessage): void {
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      if (!last || last.role !== 'assistant') return prev
      return [...prev.slice(0, -1), patch(last)]
    })
  }

  useEffect(() => {
    return window.api.chat.onEvent((event: ChatEvent) => {
      if (event.messageId !== activeIdRef.current) return

      switch (event.type) {
        case 'text':
          patchLastAssistant((m) => ({ ...m, text: m.text + event.delta }))
          break
        case 'tool-call':
          patchLastAssistant((m) => ({
            ...m,
            toolCalls: [...(m.toolCalls ?? []), { name: event.toolName, args: event.args }],
          }))
          break
        case 'tool-result':
          patchLastAssistant((m) => {
            const tc = (m.toolCalls ?? []).slice()
            for (let i = tc.length - 1; i >= 0; i--) {
              if (tc[i]!.name === event.toolName && tc[i]!.result === undefined) {
                tc[i] = { ...tc[i]!, result: event.result }
                break
              }
            }
            return { ...m, toolCalls: tc }
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

  // Autoscroll the message list to the bottom whenever it grows.
  useEffect(() => {
    const el = messageListRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, busy])

  function send(): void {
    const text = input.trim()
    if (!text || busy) return
    setError(null)
    setBusy(true)
    setMessages((prev) => [
      ...prev,
      { role: 'user', text },
      { role: 'assistant', text: '' },
    ])
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
        <div style={{ ...noDragRegion, display: 'flex', gap: 6, alignItems: 'center' }}>
          <button
            onClick={() => setSettingsOpen(true)}
            title="设置"
            style={{
              width: 26,
              height: 22,
              border: 'none',
              borderRadius: 6,
              background: 'rgba(0,0,0,0.18)',
              color: '#444',
              fontSize: 16,
              lineHeight: '22px',
              cursor: 'pointer',
              padding: 0,
              fontWeight: 600,
            }}
          >
            ⚙
          </button>
          <button
            onClick={() => window.close()}
            title="Close"
            style={{
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
      </div>

      {/* Live2D stage — fills the bulk of the window, transparent BG so the
          desktop shows through everywhere except where the character renders. */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {config && (
          <Live2DCanvas
            ref={live2dRef}
            modelPath={config.live2d.modelPath}
            fitMode="portrait"
            portraitZoom={config.live2d.portraitZoom}
          />
        )}
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

      {/* Chat panel — translucent card at the bottom, no-drag so the input
          and buttons receive normal clicks instead of starting a window drag.
          Height is controlled by chatHeight + the resize strip below.
          Rounded top corners make the top edge look like an intentional card
          boundary, not a frame. */}
      <div
        style={{
          ...noDragRegion,
          flex: '0 0 auto',
          height: chatHeight,
          background: 'rgba(255, 255, 255, 0.88)',
          backdropFilter: 'blur(8px)',
          borderRadius: '14px 14px 0 0',
          display: 'flex',
          flexDirection: 'column',
          fontFamily: 'system-ui, sans-serif',
          overflow: 'hidden',
        }}
      >
        {/* Resize strip — lives INSIDE the chat panel's top so its 6px height
            inherits the white background instead of cutting a transparent
            gap between Live2D and chat. Hit zone is taller than the visible
            handle so the grab is forgiving. */}
        <div
          onMouseDown={startSplitterDrag}
          title="拖动以调整聊天区高度"
          style={{
            ...noDragRegion,
            flex: '0 0 auto',
            height: 8,
            cursor: 'ns-resize',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {/* Tiny pill so users can see the handle exists; subtle enough not
              to dominate. */}
          <div
            style={{
              width: 32,
              height: 3,
              borderRadius: 2,
              background: 'rgba(0,0,0,0.18)',
            }}
          />
        </div>

        <div
          style={{
            padding: '4px 12px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            flex: 1,
            minHeight: 0,
          }}
        >
          {/* Message history — scrollable, takes all remaining vertical room. */}
          <div
            ref={messageListRef}
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              fontSize: 13,
              lineHeight: 1.45,
            }}
          >
            {messages.length === 0 && !busy && (
              <div style={{ color: '#999', fontSize: 12 }}>开始聊天吧 ✨</div>
            )}
            {messages.map((m, i) => (
              <MessageBubble key={i} message={m} busy={busy && i === messages.length - 1} />
            ))}
            {error && (
              <pre style={{ color: '#c00', whiteSpace: 'pre-wrap', margin: 0, fontSize: 12 }}>
                [error] {error}
              </pre>
            )}
          </div>

          {/* Input row pinned to the bottom of the chat card. */}
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
            <button
              onClick={send}
              disabled={busy || !input.trim()}
              style={{ padding: '6px 14px' }}
            >
              {busy ? '…' : 'Send'}
            </button>
          </div>
        </div>
      </div>

      {settingsOpen && config && (
        <Settings initial={config} onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  )
}

function MessageBubble({ message, busy }: { message: ChatMessage; busy: boolean }) {
  const isUser = message.role === 'user'
  return (
    <div style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
      <div
        style={{
          maxWidth: '85%',
          padding: '6px 10px',
          borderRadius: 10,
          background: isUser ? 'rgba(120, 160, 255, 0.18)' : 'rgba(0, 0, 0, 0.05)',
          whiteSpace: 'pre-wrap',
        }}
      >
        {message.text || (busy ? <span style={{ color: '#aaa' }}>thinking…</span> : '')}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div style={{ marginTop: 4, fontSize: 11, color: '#666' }}>
            {message.toolCalls.map((tc, i) => (
              <div
                key={i}
                style={{ borderLeft: '3px solid #ccc', padding: '2px 6px', marginTop: 2 }}
              >
                <b>{tc.name}</b> {JSON.stringify(tc.args)}
                {tc.result !== undefined && (
                  <div style={{ color: '#888' }}>→ {JSON.stringify(tc.result)}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
