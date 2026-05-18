import { useEffect, useRef, useState } from 'react'

import type { ChatEvent } from '../../shared/ipc'

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
      // Ignore stragglers from a previous send.
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
    <div
      style={{
        padding: 24,
        fontFamily: 'system-ui, sans-serif',
        maxWidth: 720,
        margin: '0 auto',
      }}
    >
      <h1 style={{ marginBottom: 4 }}>OpenMeido</h1>
      <p style={{ color: '#888', marginTop: 0 }}>Spike 2 — chat in Electron with streaming + tools.</p>

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
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
        <pre style={{ color: '#c00', whiteSpace: 'pre-wrap', marginTop: 16 }}>
          [error] {error}
        </pre>
      )}

      {toolCalls.length > 0 && (
        <div style={{ marginTop: 16, fontSize: 12, color: '#666' }}>
          {toolCalls.map((tc, i) => (
            <div key={i} style={{ borderLeft: '3px solid #ddd', padding: '4px 8px', marginBottom: 4 }}>
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
          marginTop: 16,
          padding: 16,
          background: '#f7f7f7',
          borderRadius: 6,
          minHeight: 80,
          whiteSpace: 'pre-wrap',
          lineHeight: 1.6,
        }}
      >
        {reply || (busy ? 'thinking…' : <span style={{ color: '#aaa' }}>reply appears here</span>)}
      </div>
    </div>
  )
}
