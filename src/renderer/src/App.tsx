import { useEffect, useRef, useState } from 'react'

import type { ChatEvent, ChatImageAttachment } from '../../shared/ipc'
import { resolvePersona } from '../../shared/config'
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
  /** Data URLs of attached images (one per screen, plus future paste/drop). */
  imageDataUrls?: string[]
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
  // Pending attachments for the NEXT send. Cleared after send fires.
  const [attachments, setAttachments] = useState<ChatImageAttachment[]>([])
  const [capturing, setCapturing] = useState(false)
  // LLM health — 'idle' (untested), 'ok' (last call succeeded), 'error'
  // (last call failed). Updates on chat events.
  const [llmStatus, setLlmStatus] = useState<'idle' | 'ok' | 'error'>('idle')
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
          setLlmStatus('ok')
          break
        case 'error':
          setError(event.error)
          setBusy(false)
          setLlmStatus('error')
          break
      }
    })
  }, [])

  // Autoscroll the message list to the bottom whenever it grows.
  useEffect(() => {
    const el = messageListRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, busy])

  // Main pushes LLM status after tests / chats. Mirrors into local state so
  // the title-bar pill turns green/red without waiting for the next chat.
  useEffect(() => {
    return window.api.chat.onStatus((status) => {
      setLlmStatus(status)
    })
  }, [])

  function send(): void {
    const text = input.trim()
    // Image-only sends are allowed: user can screenshot and hit Send with
    // no question, model will describe what it sees by default.
    if ((!text && attachments.length === 0) || busy) return
    setError(null)
    setBusy(true)
    const imageDataUrls = attachments.length
      ? attachments.map((a) => `data:${a.mimeType};base64,${a.base64}`)
      : undefined
    setMessages((prev) => [
      ...prev,
      { role: 'user', text, imageDataUrls },
      { role: 'assistant', text: '' },
    ])
    activeIdRef.current = window.api.chat.send(text, attachments.length ? attachments : undefined)
    setInput('')
    setAttachments([])
  }

  /** Capture every connected screen at once — let the model decide which is relevant. */
  async function captureScreen(): Promise<void> {
    if (capturing || busy) return
    setCapturing(true)
    setError(null)
    try {
      const shots = await window.api.screen.capture()
      setAttachments(
        shots.map((s) => ({ mimeType: s.mimeType, base64: s.base64, source: 'screenshot' })),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCapturing(false)
    }
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
      {/* Status bar — replaces a plain title bar with live model / persona /
          TTS indicators. Whole strip is drag-to-move (frameless window has
          no built-in chrome to grab); individual items inside are no-drag
          so clicks register. */}
      <div
        style={{
          ...dragRegion,
          height: 28,
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 8px 0 4px',
          background: 'rgba(255, 255, 255, 0.78)',
          backdropFilter: 'blur(10px)',
          borderBottom: '1px solid rgba(0, 0, 0, 0.06)',
          fontFamily: 'system-ui, sans-serif',
          fontSize: 11,
          color: '#444',
          userSelect: 'none',
        }}
      >
        <div
          style={{
            ...noDragRegion,
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            overflow: 'hidden',
            minWidth: 0,
          }}
        >
          <StatusPill
            dot={llmStatus === 'ok' ? '#3fb950' : llmStatus === 'error' ? '#f85149' : '#bbb'}
            label={config?.backend.model ?? '...'}
            title={`LLM 模型 · ${
              llmStatus === 'ok' ? '上次调用成功' : llmStatus === 'error' ? '上次调用失败' : '尚未测试'
            }`}
            onClick={() => setSettingsOpen(true)}
          />
          <StatusPill
            label={config ? resolvePersona(config.persona).name : '...'}
            title="当前人设（点击进设置切换）"
            onClick={() => setSettingsOpen(true)}
          />
          <StatusPill
            dot="#888"
            label="TTS off"
            title="语音合成尚未实现"
          />
        </div>
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

          {/* Pending-attachment preview — appears above the input row when
              the user has captured screenshots but not yet sent. Shows one
              thumbnail per screen so multi-monitor users can confirm. */}
          {attachments.length > 0 && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 6px',
                background: 'rgba(0,0,0,0.04)',
                borderRadius: 6,
                fontSize: 11,
                color: '#555',
              }}
            >
              {attachments.map((a, i) => (
                <img
                  key={i}
                  src={`data:${a.mimeType};base64,${a.base64}`}
                  alt={`screen ${i + 1}`}
                  style={{ width: 56, height: 32, objectFit: 'cover', borderRadius: 3 }}
                />
              ))}
              <span>
                {attachments.length === 1
                  ? '截屏已附加'
                  : `已附加 ${attachments.length} 屏`}
              </span>
              <button
                onClick={() => setAttachments([])}
                title="移除附件"
                style={{
                  marginLeft: 'auto',
                  border: 'none',
                  background: 'transparent',
                  color: '#999',
                  cursor: 'pointer',
                  fontSize: 14,
                }}
              >
                ×
              </button>
            </div>
          )}

          {/* Input row pinned to the bottom of the chat card. */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
            <button
              onClick={captureScreen}
              disabled={capturing || busy}
              title="截屏给妹妹看（多屏自动全截）"
              style={{
                padding: '4px 8px',
                background: attachments.length ? 'rgba(120,160,255,0.25)' : undefined,
                color: '#555',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {capturing ? (
                '…'
              ) : (
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
              )}
            </button>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
              placeholder={attachments.length ? '可以加一句问她（也可以直接 Send）' : '试试：提醒我五分钟后喝水'}
              disabled={busy}
              style={{ flex: 1, padding: '6px 10px', fontSize: 13 }}
            />
            <button
              onClick={send}
              disabled={busy || (!input.trim() && attachments.length === 0)}
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

/**
 * Single label-and-optional-dot status item in the top bar. Whole pill is
 * clickable when an onClick is passed (we use that to deep-link into the
 * matching Settings tab). Text truncates with ellipsis on narrow windows.
 */
function StatusPill({
  dot,
  label,
  title,
  onClick,
}: {
  dot?: string
  label: string
  title?: string
  onClick?: () => void
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={!onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        maxWidth: 110,
        padding: '2px 6px',
        background: 'transparent',
        border: 'none',
        borderRadius: 4,
        color: 'inherit',
        font: 'inherit',
        cursor: onClick ? 'pointer' : 'default',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
      }}
    >
      {dot !== undefined && (
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: 4,
            background: dot,
            flex: '0 0 auto',
          }}
        />
      )}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
    </button>
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
        {message.imageDataUrls && message.imageDataUrls.length > 0 && (
          <div style={{ display: 'flex', gap: 4, marginBottom: message.text ? 4 : 0 }}>
            {message.imageDataUrls.map((u, i) => (
              <img
                key={i}
                src={u}
                alt={`attachment ${i + 1}`}
                style={{
                  display: 'block',
                  maxWidth: 120,
                  maxHeight: 70,
                  borderRadius: 4,
                  objectFit: 'cover',
                }}
              />
            ))}
          </div>
        )}
        {message.text || (busy ? <span style={{ color: '#aaa' }}>thinking…</span> : '')}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div style={{ marginTop: 4, fontSize: 10, color: '#888' }}>
            {message.toolCalls.map((tc, i) => (
              <span
                key={i}
                // Full args/result are surfaced as a native tooltip — useful
                // when debugging but doesn't clutter the chat for the user.
                title={`args: ${JSON.stringify(tc.args)}${
                  tc.result !== undefined ? `\nresult: ${JSON.stringify(tc.result)}` : ''
                }`}
                style={{
                  display: 'inline-block',
                  marginRight: 4,
                  marginTop: 2,
                  padding: '1px 8px',
                  background: 'rgba(0,0,0,0.06)',
                  borderRadius: 8,
                  fontSize: 10,
                }}
              >
                🔧 {tc.name}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
