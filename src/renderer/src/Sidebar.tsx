/**
 * Sidebar — live view over OpenMeido's structured data layer.
 *
 * Two sections (after the reminders+todos merge):
 *   - 📝 待办 (expanded) — all tasks: pure TODOs and time-scheduled
 *     reminders share the same list. Items with a fireAt show a clock
 *     icon + countdown; everything else is a plain checkbox row.
 *     Fired reminders STAY in the list (with a "已响" marker) until the
 *     user manually checks them off — major UX win over the old design
 *     where fired reminders auto-disappeared.
 *   - 📋 最近活动 (collapsed) — recent tool calls derived from
 *     memory.episodes.tool_data.
 *
 * Each section subscribes to its source's broadcast channel and refetches
 * on receipt, so the UI stays in sync without polling.
 *
 * Layout: position:fixed on the right edge. When closed, collapses to a
 * thin strip with a [◀]/[▶] toggle. Overlay (not push) so the existing
 * window doesn't have to reflow.
 */

import { useEffect, useRef, useState } from 'react'

interface Task {
  id: number
  createdAt: string
  text: string
  doneAt: string | null
  fireAt: string | null
  notifiedAt: string | null
  dueAt: string | null
  sessionId: string | null
}

interface ToolActivity {
  episodeId: number
  ts: string
  kind: 'call' | 'result'
  toolName: string
  summary: string
}

interface AppRegionStyle extends React.CSSProperties {
  WebkitAppRegion?: 'drag' | 'no-drag'
}
const noDrag: AppRegionStyle = { WebkitAppRegion: 'no-drag' }

function relativeTime(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return iso
  const dMs = t - now
  const dSec = Math.round(dMs / 1000)
  const sign = dSec < 0 ? '前' : '后'
  const abs = Math.abs(dSec)
  if (abs < 60) return abs === 0 ? '现在' : `${abs}秒${sign}`
  if (abs < 3600) return `${Math.round(abs / 60)}分钟${sign}`
  if (abs < 86400) return `${Math.round(abs / 3600)}小时${sign}`
  if (abs < 86400 * 7) return `${Math.round(abs / 86400)}天${sign}`
  const d = new Date(t)
  return `${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

function Section({
  title,
  badge,
  defaultOpen = true,
  children,
}: {
  title: string
  badge?: number
  defaultOpen?: boolean
  children: React.ReactNode
}): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div style={{ borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          ...noDrag,
          width: '100%',
          textAlign: 'left',
          padding: '8px 10px',
          background: 'transparent',
          border: 'none',
          fontSize: 12,
          fontWeight: 600,
          color: '#444',
          cursor: 'pointer',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span>
          <span style={{ marginRight: 4, fontSize: 10 }}>{open ? '▼' : '▶'}</span>
          {title}
          {badge !== undefined && badge > 0 && (
            <span
              style={{
                marginLeft: 6,
                background: '#5b8def',
                color: 'white',
                fontSize: 10,
                borderRadius: 8,
                padding: '0 6px',
                fontWeight: 500,
              }}
            >
              {badge}
            </span>
          )}
        </span>
      </button>
      {open && <div style={{ padding: '0 10px 8px' }}>{children}</div>}
    </div>
  )
}

export function Sidebar({
  open,
  onToggle,
  refreshActivityToken,
}: {
  open: boolean
  onToggle: () => void
  refreshActivityToken: number
}): React.ReactElement {
  const [tasks, setTasks] = useState<Task[]>([])
  const [activity, setActivity] = useState<ToolActivity[]>([])
  const [newTaskText, setNewTaskText] = useState('')

  const reloadTasks = async (): Promise<void> => {
    setTasks((await window.api.tasks.listAll(5)) as Task[])
  }
  const reloadActivity = async (): Promise<void> => {
    setActivity((await window.api.memory.recentToolActivity(15)) as ToolActivity[])
  }

  useEffect(() => {
    void reloadTasks()
    void reloadActivity()
    const offTasks = window.api.tasks.onChanged(() => void reloadTasks())
    return () => {
      offTasks()
    }
  }, [])

  useEffect(() => {
    void reloadActivity()
  }, [refreshActivityToken])

  // Re-render every 30s so countdown labels stay fresh.
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  const newTaskRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (open) newTaskRef.current?.focus()
  }, [open])

  async function submitNewTask(): Promise<void> {
    const text = newTaskText.trim()
    if (!text) return
    await window.api.tasks.add(text, null, null)
    setNewTaskText('')
    void reloadTasks()
  }

  const active = tasks.filter((t) => t.doneAt === null)
  const done = tasks.filter((t) => t.doneAt !== null)

  if (!open) {
    return (
      <button
        onClick={onToggle}
        title="展开侧边栏 — 查看任务 / 最近活动"
        style={{
          ...noDrag,
          position: 'absolute',
          right: 0,
          top: 28,
          bottom: 0,
          width: 18,
          background: 'rgba(255,255,255,0.55)',
          backdropFilter: 'blur(8px)',
          border: 'none',
          borderLeft: '1px solid rgba(0,0,0,0.08)',
          cursor: 'pointer',
          fontSize: 11,
          color: '#666',
          padding: 0,
          writingMode: 'vertical-rl',
        }}
      >
        ◀ 侧栏
      </button>
    )
  }

  return (
    <div
      style={{
        ...noDrag,
        position: 'absolute',
        right: 0,
        top: 28,
        bottom: 0,
        width: 260,
        background: 'rgba(255,255,255,0.92)',
        backdropFilter: 'blur(12px)',
        borderLeft: '1px solid rgba(0,0,0,0.08)',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'system-ui, sans-serif',
        fontSize: 12,
        color: '#333',
        boxShadow: '-2px 0 8px rgba(0,0,0,0.05)',
      }}
    >
      <div
        style={{
          flex: '0 0 auto',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '6px 10px',
          borderBottom: '1px solid rgba(0,0,0,0.08)',
          background: 'rgba(255,255,255,0.6)',
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 600, color: '#555' }}>侧栏</span>
        <button
          onClick={onToggle}
          title="收起"
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            fontSize: 12,
            color: '#666',
            padding: '2px 6px',
          }}
        >
          ▶
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {/* ===== Unified tasks (reminders + TODOs) ===== */}
        <Section title="📝 待办" badge={active.length} defaultOpen>
          {/* Quick-add input */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
            <input
              ref={newTaskRef}
              type="text"
              value={newTaskText}
              onChange={(e) => setNewTaskText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitNewTask()
              }}
              placeholder="加一条…"
              style={{
                flex: 1,
                padding: '3px 6px',
                fontSize: 11,
                border: '1px solid rgba(0,0,0,0.12)',
                borderRadius: 3,
                background: 'rgba(255,255,255,0.7)',
              }}
            />
            <button
              onClick={() => void submitNewTask()}
              disabled={!newTaskText.trim()}
              style={{
                padding: '3px 8px',
                fontSize: 11,
                cursor: newTaskText.trim() ? 'pointer' : 'default',
                opacity: newTaskText.trim() ? 1 : 0.4,
              }}
            >
              +
            </button>
          </div>

          {active.length === 0 && done.length === 0 ? (
            <div style={{ color: '#999', fontStyle: 'italic', fontSize: 11 }}>
              清单为空。说"记一下 X"或"提醒我 5 分钟后 Y"。
            </div>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {active.map((t) => (
                <li
                  key={t.id}
                  style={{
                    display: 'flex',
                    gap: 6,
                    padding: '3px 0',
                    alignItems: 'flex-start',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={false}
                    onChange={async () => {
                      await window.api.tasks.markDone(t.id)
                    }}
                    style={{ marginTop: 2 }}
                  />
                  <div style={{ flex: 1, minWidth: 0, color: '#333' }}>
                    <div>{t.text}</div>
                    {t.fireAt && (
                      <div style={{ fontSize: 10, color: t.notifiedAt ? '#a00' : '#888' }}>
                        ⏰ {relativeTime(t.fireAt)}
                        {t.notifiedAt && ' · 已响'}
                      </div>
                    )}
                    {!t.fireAt && t.dueAt && (
                      <div style={{ fontSize: 10, color: '#888' }}>
                        截止 {relativeTime(t.dueAt)}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={async () => {
                      await window.api.tasks.remove(t.id)
                    }}
                    title="删除"
                    style={{
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      color: '#bbb',
                      fontSize: 12,
                      padding: 0,
                      lineHeight: 1,
                    }}
                  >
                    ×
                  </button>
                </li>
              ))}
              {done.length > 0 && (
                <li
                  style={{
                    marginTop: 6,
                    paddingTop: 6,
                    borderTop: '1px dashed rgba(0,0,0,0.08)',
                    fontSize: 10,
                    color: '#999',
                  }}
                >
                  最近完成
                </li>
              )}
              {done.map((t) => (
                <li
                  key={t.id}
                  style={{
                    display: 'flex',
                    gap: 6,
                    padding: '2px 0',
                    alignItems: 'flex-start',
                    opacity: 0.55,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={true}
                    onChange={async () => {
                      await window.api.tasks.markActive(t.id)
                    }}
                    style={{ marginTop: 2 }}
                  />
                  <div
                    style={{
                      flex: 1,
                      minWidth: 0,
                      textDecoration: 'line-through',
                      color: '#666',
                    }}
                  >
                    {t.text}
                  </div>
                  <button
                    onClick={async () => {
                      await window.api.tasks.remove(t.id)
                    }}
                    title="删除"
                    style={{
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      color: '#bbb',
                      fontSize: 12,
                      padding: 0,
                      lineHeight: 1,
                    }}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="📋 最近活动" defaultOpen={false}>
          {activity.length === 0 ? (
            <div style={{ color: '#999', fontStyle: 'italic', fontSize: 11 }}>
              暂无工具调用记录
            </div>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {activity.map((a, i) => (
                <li
                  key={`${a.episodeId}-${i}`}
                  style={{
                    padding: '3px 0',
                    borderBottom: '1px dotted rgba(0,0,0,0.05)',
                    fontSize: 11,
                  }}
                >
                  <div>
                    <span style={{ color: a.kind === 'call' ? '#3a73d0' : '#888' }}>
                      {a.kind === 'call' ? '→' : '←'}
                    </span>{' '}
                    <span style={{ fontWeight: 500 }}>{a.toolName}</span>
                  </div>
                  <div
                    style={{
                      fontSize: 10,
                      color: '#888',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                    title={a.summary}
                  >
                    {a.summary}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  )
}
