import { useEffect, useRef, useState } from 'react'

import type { ChatEvent } from '../../shared/ipc'
import { Live2DCanvas } from './live2d/Live2DCanvas'

const MODEL_PATH = '/live2d-models/haitu_vts/海兔1.model3.json'

interface ToolCall {
  name: string
  args: unknown
  result?: unknown
}

export default function App() {
  const [input, setInput] = useState('')
  const [reply, setReply] = useState('')
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const activeIdRef = useRef<string | null>(null)

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

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Live2D stage — fills upper portion. */}
      <div style={{ flex: '1 1 60%', minHeight: 0, background: '#f0e6f0' }}>
        <Live2DCanvas modelPath={MODEL_PATH} fitMode="portrait" />
      </div>

      {/* Chat panel — fixed-ish lower portion. */}
      <div
        style={{
          flex: '1 1 40%',
          minHeight: 0,
          padding: 16,
          borderTop: '1px solid #ddd',
          background: '#fff',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          fontFamily: 'system-ui, sans-serif',
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
            style={{ flex: 1, padding: '8px 10px', fontSize: 14 }}
          />
          <button onClick={send} disabled={busy || !input.trim()} style={{ padding: '8px 16px' }}>
            {busy ? '…' : 'Send'}
          </button>
        </div>

        {error && (
          <pre style={{ color: '#c00', whiteSpace: 'pre-wrap', margin: 0 }}>
            [error] {error}
          </pre>
        )}

        {toolCalls.length > 0 && (
          <div style={{ fontSize: 12, color: '#666' }}>
            {toolCalls.map((tc, i) => (
              <div
                key={i}
                style={{ borderLeft: '3px solid #ddd', padding: '4px 8px', marginBottom: 4 }}
              >
                <div>
                  <b>{tc.name}</b> {JSON.stringify(tc.args)}
                </div>
                {tc.result !== undefined && <div>→ {JSON.stringify(tc.result)}</div>}
              </div>
            ))}
          </div>
        )}

        <div
          style={{
            flex: 1,
            padding: 12,
            background: '#f7f7f7',
            borderRadius: 6,
            overflowY: 'auto',
            whiteSpace: 'pre-wrap',
            lineHeight: 1.6,
          }}
        >
          {reply || (busy ? 'thinking…' : <span style={{ color: '#aaa' }}>reply appears here</span>)}
        </div>
      </div>
    </div>
  )
}
