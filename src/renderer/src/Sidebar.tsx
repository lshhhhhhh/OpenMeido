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

/** User-facing tool labels for the 最近活动 feed. Anything not listed
 *  falls back to the raw tool name — better than hiding work entirely. */
const TOOL_LABELS: Record<string, string> = {
  addTask: '增加待办',
  listTasks: '查看清单',
  markTaskDone: '完成待办',
  setLive2DExpression: '换表情',
  readClipboard: '看剪贴板',
  readWebPage: '查网页',
  readFile: '读文件',
  listRecentEmails: '看邮件',
  readEmail: '读邮件',
  google_search: '联网搜索',
}
function toolLabelZh(name: string): string {
  return TOOL_LABELS[name] ?? name
}

/** Extract the user-meaningful "what about" out of a tool's input JSON.
 *  Returns '' when there's nothing worth showing for that tool. */
function toolDetailZh(toolName: string, summary: string): string {
  // summary is the JSON.stringify'd input; parse and pick the field that
  // a non-dev user would care about. Fall back to the raw summary so we
  // don't lose information for unknown tools.
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(summary) as Record<string, unknown>
  } catch {
    return summary
  }
  const pick = (k: string): string => {
    const v = obj[k]
    return typeof v === 'string' ? v : ''
  }
  switch (toolName) {
    case 'addTask':
      return pick('text')
    case 'markTaskDone':
      return typeof obj.id === 'number' ? `#${obj.id}` : ''
    case 'setLive2DExpression':
      return pick('expression') || pick('name')
    case 'readWebPage':
      return pick('url')
    case 'readFile':
      return pick('path') || pick('filepath')
    case 'readEmail':
      return typeof obj.id === 'string' || typeof obj.id === 'number'
        ? `#${obj.id}`
        : ''
    case 'google_search':
      return pick('query') || pick('q')
    case 'listTasks':
    case 'listRecentEmails':
    case 'readClipboard':
      return ''
    default:
      return summary.length > 40 ? summary.slice(0, 40) + '…' : summary
  }
}

/** Match shared/affinity.ts tier breakpoints. Duplicated rather than
 *  imported so the renderer bundle doesn't pull a Node-typed module. */
function tierLabelFor(score: number): string {
  if (score >= 80) return 'Lv.5'
  if (score >= 60) return 'Lv.4'
  if (score >= 40) return 'Lv.3'
  if (score >= 20) return 'Lv.2'
  return 'Lv.1'
}

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
  onSendChat,
  personaName,
}: {
  open: boolean
  onToggle: () => void
  refreshActivityToken: number
  /**
   * Send the text in the quick-add input as a chat message to the maid.
   * Routes through the same chat pipeline as the main input box — the
   * AI then decides whether to add a task, ask a clarifying question,
   * or just respond. The sidebar deliberately does NOT call tasks.add
   * directly anymore: typing here should feel like talking to her.
   */
  onSendChat: (text: string) => void
  /** Resolved persona name for inline UI strings (placeholder text etc).
   *  Falls back to "她" if config isn't loaded yet. */
  personaName?: string
}): React.ReactElement {
  const [tasks, setTasks] = useState<Task[]>([])
  const [activity, setActivity] = useState<ToolActivity[]>([])
  const [newTaskText, setNewTaskText] = useState('')
  const [affinity, setAffinity] = useState<{
    score: number
    tierLabel: string
    reason: string | null
  } | null>(null)

  const reloadTasks = async (): Promise<void> => {
    setTasks((await window.api.tasks.listAll(5)) as Task[])
  }
  const reloadActivity = async (): Promise<void> => {
    setActivity((await window.api.memory.recentToolActivity(15)) as ToolActivity[])
  }
  const reloadAffinity = async (): Promise<void> => {
    const rec = await window.api.affinity.get()
    if (!rec) return
    setAffinity({
      score: rec.score,
      tierLabel: tierLabelFor(rec.score),
      reason: rec.lastReason,
    })
  }

  useEffect(() => {
    void reloadTasks()
    void reloadActivity()
    void reloadAffinity()
    const offTasks = window.api.tasks.onChanged(() => void reloadTasks())
    const offAff = window.api.affinity.onChanged((info) =>
      setAffinity({
        score: info.score,
        tierLabel: info.tier.zhLabel,
        reason: info.reason,
      }),
    )
    const offSwitch = window.api.affinity.onPersonaSwitched(() => void reloadAffinity())
    return () => {
      offTasks()
      offAff()
      offSwitch()
    }
  }, [])

  useEffect(() => {
    void reloadActivity()
  }, [refreshActivityToken])

  // Re-render every 1s so countdown labels stay fresh — at 30s users could
  // watch "5秒后" sit unchanged for half a minute and assume the UI was stuck.
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), 1_000)
    return () => clearInterval(t)
  }, [])

  const newTaskRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (open) newTaskRef.current?.focus()
  }, [open])

  function submitNewTask(): void {
    const text = newTaskText.trim()
    if (!text) return
    // Route through chat instead of adding a row directly. The model
    // will call the addTask tool when appropriate, ask follow-up
    // questions when ambiguous ("提醒我喝水" → "什么时候提醒？"), or
    // just chat back. Listing/refresh happens automatically because
    // chat.ts persists tool_calls and broadcasts tasks:changed.
    onSendChat(text)
    setNewTaskText('')
  }

  const active = tasks.filter((t) => t.doneAt === null)
  const done = tasks.filter((t) => t.doneAt !== null)

  // Shared style for the toggle strip — used in both closed and open states.
  // The strip stays glued to the right edge of the Live2D pane: when closed
  // that's `right: 0` of the small window; when open the window grows by
  // 260px to the right, so the strip lives on the LEFT edge of the sidebar
  // content (= the same screen X). Achieved by flex order in the open case
  // (strip first → content second).
  const stripStyle = {
    ...noDrag,
    width: 18,
    background: 'rgba(255,255,255,0.55)',
    backdropFilter: 'blur(8px)',
    border: 'none',
    borderLeft: '1px solid rgba(0,0,0,0.08)',
    cursor: 'pointer',
    fontSize: 11,
    color: '#666',
    padding: 0,
    writingMode: 'vertical-rl' as const,
  }

  if (!open) {
    return (
      <button
        onClick={onToggle}
        title="展开侧边栏 — 查看任务 / 最近活动"
        style={{
          ...stripStyle,
          position: 'absolute',
          // Flush right edge — sidebar glues to the window border.
          // Only the LEFT side gets rounded so it reads as a card
          // peeking out from the right edge.
          right: 0,
          top: 28,
          bottom: 0,
          // Above the chat panel (z:1) and bg layer (z:0) so the strip
          // remains clickable across its full height — without this,
          // the chat panel covers the bottom segment of the strip.
          zIndex: 2,
          borderTopLeftRadius: 10,
          borderBottomLeftRadius: 10,
          borderLeft: 'none',
          boxShadow: '-2px 0 8px rgba(0, 0, 0, 0.06)',
        }}
      >
        ▶ 侧栏
      </button>
    )
  }

  return (
    <div
      style={{
        ...noDrag,
        position: 'absolute',
        // Flush right edge — sidebar glues to the window border.
        // Only the LEFT side is rounded so it reads as a card peeking
        // out from the right (matching the collapsed strip's look).
        right: 0,
        top: 28,
        bottom: 0,
        width: 260,
        // Same zIndex bump as the collapsed strip — keeps the OPENED
        // sidebar above the chat panel (z:1) and the Live2D pane.
        // Without this the open sidebar receives clicks but they tunnel
        // through to the Live2D pane behind it.
        zIndex: 2,
        display: 'flex',
        flexDirection: 'row',
        fontSize: 12,
        color: '#333',
        borderTopLeftRadius: 16,
        borderBottomLeftRadius: 16,
        overflow: 'hidden',
        boxShadow: '-4px 0 16px rgba(0, 0, 0, 0.08)',
      }}
    >
      <button onClick={onToggle} title="收起侧栏" style={{ ...stripStyle, flex: '0 0 18px' }}>
        ◀ 侧栏
      </button>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          background: 'rgba(255,255,255,0.92)',
          backdropFilter: 'blur(12px)',
          overflowY: 'auto',
        }}
      >
        {/* ===== Affinity bar (relationship state with active persona) ===== */}
        {affinity && (
          <div
            title={affinity.reason ?? '还没有判定记录'}
            style={{
              padding: '8px 10px',
              borderBottom: '1px solid rgba(0,0,0,0.06)',
              fontSize: 11,
              color: '#333',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                marginBottom: 4,
                fontWeight: 500,
              }}
            >
              <span>❤️ 好感度</span>
              <span
                style={{ color: '#888', cursor: 'help' }}
                title={`${affinity.score.toFixed(2)} / 100`}
              >
                {Math.round(affinity.score)} · {affinity.tierLabel}
              </span>
            </div>
            <div
              style={{
                height: 4,
                borderRadius: 2,
                background: 'rgba(0,0,0,0.08)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${Math.max(2, affinity.score)}%`,
                  height: '100%',
                  background: 'linear-gradient(90deg, #f6a4b3, #d4768a)',
                  transition: 'width 400ms ease',
                }}
              />
            </div>
            {affinity.reason && (
              <div
                style={{
                  marginTop: 4,
                  fontSize: 10,
                  color: '#999',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {affinity.reason}
              </div>
            )}
          </div>
        )}

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
                if (e.key === 'Enter') submitNewTask()
              }}
              placeholder={`和${personaName ?? '她'}说一句…`}
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
              onClick={() => submitNewTask()}
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
          {(() => {
            // Only show call rows — result rows are noise to a non-dev user
            // ("← addTask {ok:true,id:42}" reads like a debug log). The call
            // alone is enough to communicate "the maid did X".
            const calls = activity.filter((a) => a.kind === 'call')
            if (calls.length === 0)
              return (
                <div style={{ color: '#999', fontStyle: 'italic', fontSize: 11 }}>
                  最近没有做什么呢
                </div>
              )
            return (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {calls.map((a, i) => (
                  <li
                    key={`${a.episodeId}-${i}`}
                    style={{
                      padding: '4px 0',
                      borderBottom: '1px dotted rgba(0,0,0,0.05)',
                      fontSize: 11,
                    }}
                  >
                    <div
                      style={{
                        color: '#333',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'baseline',
                        gap: 6,
                      }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <span style={{ fontWeight: 500 }}>
                          {toolLabelZh(a.toolName)}
                        </span>
                        {(() => {
                          const detail = toolDetailZh(a.toolName, a.summary)
                          return detail ? (
                            <span style={{ color: '#666', marginLeft: 4 }}>
                              · {detail}
                            </span>
                          ) : null
                        })()}
                      </div>
                      <span
                        style={{
                          color: '#999',
                          fontSize: 10,
                          flexShrink: 0,
                          whiteSpace: 'nowrap',
                        }}
                        title={new Date(a.ts).toLocaleString('zh-CN')}
                      >
                        {relativeTime(a.ts)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )
          })()}
        </Section>
      </div>
    </div>
  )
}
