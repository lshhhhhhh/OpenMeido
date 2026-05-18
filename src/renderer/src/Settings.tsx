/**
 * Settings modal. Full-window overlay with the same translucent / blur look
 * as the chat panel. Edits are kept in local React state and only written to
 * the persistent config when the user clicks Save.
 */

import { useEffect, useState } from 'react'

import { CUSTOM_PERSONA_TEMPLATE, personaPresets, type Config } from '../../shared/config'
import type { Episode, SessionSummary } from '../../core/memory/types'

interface SettingsProps {
  initial: Config
  onClose: () => void
}

/** Common base URLs offered as quick-fill chips above the URL input. */
const BASE_URL_PRESETS: { label: string; url: string }[] = [
  { label: 'OpenAI', url: 'https://api.openai.com/v1' },
  { label: 'Gemini (OpenAI 兼容)', url: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { label: 'LM Studio (本地)', url: 'http://127.0.0.1:1234/v1' },
]

/**
 * Suggested multimodal-capable model ids per provider, three per family —
 * cheap / balanced / flagship. ALL entries support image input (OpenMeido
 * needs vision for screenshot perception), verified against provider docs
 * 2026-05. Older / superseded variants intentionally omitted.
 *
 * Note: OpenAI's 5.5 generation has NO `gpt-5.5-mini`; the cheap tier
 * stayed `gpt-5.4-mini` even after 5.5 launched.
 */
const MODEL_SUGGESTIONS_BY_HOST: { match: (url: string) => boolean; models: string[] }[] = [
  {
    match: (url) => url.includes('openai.com'),
    models: ['gpt-5.4-mini', 'gpt-5.5', 'gpt-5.5-pro'],
  },
  {
    match: (url) => url.includes('googleapis.com'),
    models: ['gemini-2.5-flash', 'gemini-3.1-flash-lite', 'gemini-3.1-pro-preview'],
  },
  {
    match: (url) => url.includes('anthropic.com'),
    models: ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-7'],
  },
  {
    // LM Studio etc. — names depend on what's loaded locally.
    match: (url) => url.includes('127.0.0.1') || url.includes('localhost'),
    models: ['qwen/qwen3-vl-30b'],
  },
]

function suggestedModels(baseUrl: string): string[] {
  for (const entry of MODEL_SUGGESTIONS_BY_HOST) {
    if (entry.match(baseUrl)) return entry.models
  }
  return []
}

/** IMAP presets for common providers. Port is always 993 (IMAPS). */
const MAIL_PRESETS: { label: string; host: string; helpUrl: string }[] = [
  { label: 'Gmail', host: 'imap.gmail.com', helpUrl: 'https://support.google.com/accounts/answer/185833' },
  { label: 'Outlook', host: 'outlook.office365.com', helpUrl: 'https://support.microsoft.com/en-us/account-billing/manage-app-passwords-for-two-step-verification-d6dc8c6d-4bf7-4851-ad95-6d07799387e9' },
  { label: 'iCloud', host: 'imap.mail.me.com', helpUrl: 'https://support.apple.com/en-us/102654' },
  { label: '163', host: 'imap.163.com', helpUrl: 'https://mail.163.com/' },
  { label: 'QQ', host: 'imap.qq.com', helpUrl: 'https://service.mail.qq.com/detail/0/351' },
]

type TabId = 'ai' | 'persona' | 'live2d' | 'mail' | 'memory' | 'window'
const TABS: { id: TabId; label: string }[] = [
  { id: 'ai', label: 'AI' },
  { id: 'persona', label: '人设' },
  { id: 'live2d', label: 'Live2D' },
  { id: 'mail', label: '邮箱' },
  { id: 'memory', label: '记忆' },
  { id: 'window', label: '窗口' },
]

export function Settings({ initial, onClose }: SettingsProps) {
  const [draft, setDraft] = useState<Config>(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<TabId>('ai')
  // Mail password input is local-only: we never preload the stored value
  // (it's ciphertext) and we only write to config.mail.password on save if
  // the user has actually typed something here.
  const [mailPasswordInput, setMailPasswordInput] = useState('')
  const [mailTestResult, setMailTestResult] = useState<
    null | 'testing' | { ok: boolean; error?: string }
  >(null)
  const [backendTestResult, setBackendTestResult] = useState<
    null | 'testing' | { ok: boolean; error?: string }
  >(null)

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /** Persist the current draft. Used by both "保存" (then closes the modal)
   *  and "应用" (stays open so the user can keep tweaking). */
  async function applyChanges(): Promise<boolean> {
    setSaving(true)
    setError(null)
    try {
      // If the user typed a new mail password, hand the plaintext to main
      // with passwordEncrypted=false — main re-encrypts via safeStorage
      // before persisting. Otherwise the existing ciphertext flows through
      // untouched.
      let next = draft
      if (mailPasswordInput) {
        next = {
          ...draft,
          mail: { ...draft.mail, password: mailPasswordInput, passwordEncrypted: false },
        }
      }
      await window.api.config.set(next)
      // Mail password was written as ciphertext now — clear the input so
      // a subsequent 应用 doesn't try to re-set it.
      setMailPasswordInput('')
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setSaving(false)
    }
  }

  async function save(): Promise<void> {
    if (await applyChanges()) onClose()
  }

  async function apply(): Promise<void> {
    await applyChanges()
  }

  // Are there pending changes to save? The Memory tab has no editable
  // draft state (all its actions hit IPC directly), so on that tab this
  // stays false and the modal footer collapses to a single Close button.
  const hasChanges =
    mailPasswordInput.length > 0 || JSON.stringify(draft) !== JSON.stringify(initial)

  async function testMail(): Promise<void> {
    setMailTestResult('testing')
    try {
      const result = await window.api.mail.test(draft.mail, mailPasswordInput || undefined)
      setMailTestResult(result)
    } catch (err) {
      setMailTestResult({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  async function testBackend(): Promise<void> {
    setBackendTestResult('testing')
    try {
      const result = await window.api.chat.test(draft.backend)
      setBackendTestResult(result)
    } catch (err) {
      setBackendTestResult({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        // Solid background — the parent BrowserWindow is transparent + frame:false,
        // so a translucent modal would let the desktop bleed through and make the
        // form unreadable. Keep this opaque.
        background: '#1e1f29',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      {/* Header — title + close. Always visible above the tab bar. */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '12px 16px 8px',
          color: '#eee',
        }}
      >
        <h2 style={{ margin: 0, fontSize: 16 }}>设置</h2>
        <button onClick={onClose} style={closeBtnStyle}>
          ×
        </button>
      </div>

      {/* Tab bar — horizontal, scrolls if narrow. Underline-style active state. */}
      <div
        style={{
          display: 'flex',
          gap: 4,
          padding: '0 12px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            style={tabBtnStyle(activeTab === t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '12px 16px',
          color: '#eee',
          fontSize: 13,
        }}
      >
        {/* ---- Backend ---- */}
        {activeTab === 'ai' && (
        <Section title="AI Backend">
          <Label>Base URL</Label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
            {BASE_URL_PRESETS.map((p) => (
              <button
                key={p.url}
                style={chipStyle(draft.backend.baseUrl === p.url)}
                onClick={() => {
                  // Switching providers also resets the model to the new
                  // provider's first suggestion — otherwise we'd leave (say)
                  // a gemini model id stranded under the OpenAI base URL.
                  const newSuggestions = suggestedModels(p.url)
                  const stillValid = newSuggestions.includes(draft.backend.model)
                  setDraft({
                    ...draft,
                    backend: {
                      ...draft.backend,
                      baseUrl: p.url,
                      model: stillValid ? draft.backend.model : newSuggestions[0] ?? draft.backend.model,
                    },
                  })
                  setBackendTestResult(null)
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
          <input
            value={draft.backend.baseUrl}
            onChange={(e) =>
              setDraft({ ...draft, backend: { ...draft.backend, baseUrl: e.target.value } })
            }
            style={inputStyle}
          />

          <Label>API Key</Label>
          <input
            type="password"
            placeholder="sk-... 或 AIza..."
            value={draft.backend.apiKey}
            onChange={(e) =>
              setDraft({ ...draft, backend: { ...draft.backend, apiKey: e.target.value } })
            }
            style={inputStyle}
          />
          <div style={{ fontSize: 11, color: '#999', marginTop: -4, marginBottom: 8 }}>
            留空则使用 <code>.env</code> 中的 OPENAI_API_KEY / GEMINI_API_KEY（仅开发兜底）。
          </div>

          <Label>Model</Label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
            {suggestedModels(draft.backend.baseUrl).map((m) => (
              <button
                key={m}
                style={chipStyle(draft.backend.model === m)}
                onClick={() => setDraft({ ...draft, backend: { ...draft.backend, model: m } })}
              >
                {m}
              </button>
            ))}
            {/* Escape hatch — fine-tunes, new versions, local model names.
                Uses native window.prompt instead of a separate input field,
                which the user found visually redundant with the chips. */}
            <button
              style={chipStyle(
                !suggestedModels(draft.backend.baseUrl).includes(draft.backend.model),
              )}
              onClick={() => {
                const v = window.prompt(
                  '输入 model id（fine-tune / 新版本 / 本地模型）',
                  draft.backend.model,
                )
                if (v !== null && v.trim()) {
                  setDraft({ ...draft, backend: { ...draft.backend, model: v.trim() } })
                }
              }}
            >
              {suggestedModels(draft.backend.baseUrl).includes(draft.backend.model)
                ? '✏️ 其它'
                : `✏️ ${draft.backend.model}`}
            </button>
          </div>

          {/* Connectivity test — hits /models, no tokens spent. On success
              the main process pushes 'chat:status: ok' which the title-bar
              pill listens to and goes green. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={testBackend} disabled={backendTestResult === 'testing'} style={btnStyle(false)}>
              {backendTestResult === 'testing' ? '测试中...' : '测试连通'}
            </button>
            {backendTestResult && backendTestResult !== 'testing' && (
              <span style={{ fontSize: 12, color: backendTestResult.ok ? '#8ec98e' : '#f88' }}>
                {backendTestResult.ok ? '✓ 连接成功' : `✗ ${backendTestResult.error ?? '失败'}`}
              </span>
            )}
          </div>
        </Section>
        )}

        {/* ---- Persona ---- */}
        {activeTab === 'persona' && (
        <Section title="人设">
          <Label>选择人设</Label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
            {/* Built-in chips */}
            <button
              style={chipStyle(draft.persona.preset === 'maid')}
              onClick={() => setDraft({ ...draft, persona: { ...draft.persona, preset: 'maid' } })}
            >
              女仆
            </button>
            <button
              style={chipStyle(draft.persona.preset === 'imouto')}
              onClick={() => setDraft({ ...draft, persona: { ...draft.persona, preset: 'imouto' } })}
            >
              妹妹
            </button>
            {/* User-saved customs */}
            {draft.persona.customs.map((c) => (
              <button
                key={c.id}
                style={chipStyle(draft.persona.preset === c.id)}
                onClick={() => setDraft({ ...draft, persona: { ...draft.persona, preset: c.id } })}
              >
                {c.name || '(未命名)'}
              </button>
            ))}
            {/* "+ new" chip — creates a fresh custom seeded with the template. */}
            <button
              style={{
                ...chipStyle(false),
                borderStyle: 'dashed',
              }}
              onClick={() => {
                const id = 'c' + Date.now().toString(36)
                setDraft({
                  ...draft,
                  persona: {
                    preset: id,
                    customs: [
                      ...draft.persona.customs,
                      { id, name: '新人设', systemPrompt: CUSTOM_PERSONA_TEMPLATE },
                    ],
                  },
                })
              }}
            >
              + 新建
            </button>
          </div>

          {/* Detail panel for the currently-selected persona. */}
          {(draft.persona.preset === 'maid' || draft.persona.preset === 'imouto') ? (
            <div
              style={{
                whiteSpace: 'pre-wrap',
                background: 'rgba(255,255,255,0.06)',
                padding: 8,
                borderRadius: 6,
                fontSize: 11,
                lineHeight: 1.5,
                color: '#ccc',
                maxHeight: 200,
                overflowY: 'auto',
              }}
            >
              {personaPresets[draft.persona.preset as 'maid' | 'imouto'].systemPrompt}
            </div>
          ) : (
            (() => {
              const active = draft.persona.customs.find((c) => c.id === draft.persona.preset)
              if (!active) {
                return (
                  <div style={{ color: '#999', fontSize: 12 }}>
                    人设未找到，请重新选择上方 chip 或点 "+ 新建"。
                  </div>
                )
              }
              const updateActive = (patch: Partial<typeof active>): void => {
                setDraft({
                  ...draft,
                  persona: {
                    ...draft.persona,
                    customs: draft.persona.customs.map((c) =>
                      c.id === active.id ? { ...c, ...patch } : c,
                    ),
                  },
                })
              }
              return (
                <>
                  <Label>名称（显示在 chip 上）</Label>
                  <input
                    value={active.name}
                    placeholder="例如：调皮妹妹 / 严厉助理"
                    onChange={(e) => updateActive({ name: e.target.value })}
                    style={inputStyle}
                  />

                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-end',
                    }}
                  >
                    <Label>System prompt（括号是填空提示）</Label>
                    <button
                      onClick={() => {
                        if (
                          active.systemPrompt === CUSTOM_PERSONA_TEMPLATE ||
                          window.confirm('重置为默认模板？当前编辑内容会丢失。')
                        ) {
                          updateActive({ systemPrompt: CUSTOM_PERSONA_TEMPLATE })
                        }
                      }}
                      title="还原到原始填空模板"
                      style={{
                        fontSize: 10,
                        padding: '2px 8px',
                        background: 'rgba(255,255,255,0.08)',
                        border: '1px solid rgba(255,255,255,0.15)',
                        borderRadius: 4,
                        color: '#ccc',
                        cursor: 'pointer',
                        marginBottom: 3,
                      }}
                    >
                      ↺ 重置为模板
                    </button>
                  </div>
                  <textarea
                    value={active.systemPrompt}
                    onChange={(e) => updateActive({ systemPrompt: e.target.value })}
                    rows={12}
                    style={{ ...inputStyle, fontFamily: 'inherit', resize: 'vertical' }}
                  />
                  <div style={{ fontSize: 11, color: '#999', marginTop: -4, marginBottom: 8 }}>
                    替换所有 <code>【填写：...】</code> 即可。
                  </div>

                  <button
                    onClick={() => {
                      if (!window.confirm(`删除人设「${active.name}」？此操作无法撤销。`)) return
                      setDraft({
                        ...draft,
                        persona: {
                          // Fall back to maid after deletion.
                          preset: 'maid',
                          customs: draft.persona.customs.filter((c) => c.id !== active.id),
                        },
                      })
                    }}
                    style={{
                      fontSize: 11,
                      padding: '4px 10px',
                      background: 'rgba(200, 80, 80, 0.2)',
                      border: '1px solid rgba(200, 80, 80, 0.4)',
                      borderRadius: 4,
                      color: '#f99',
                      cursor: 'pointer',
                    }}
                  >
                    删除此人设
                  </button>
                </>
              )
            })()
          )}
        </Section>
        )}

        {/* ---- Live2D ---- */}
        {activeTab === 'live2d' && (
        <Section title="Live2D">
          <Label>模型路径</Label>
          <input
            value={draft.live2d.modelPath}
            onChange={(e) =>
              setDraft({ ...draft, live2d: { ...draft.live2d, modelPath: e.target.value } })
            }
            style={inputStyle}
          />
          <div style={{ fontSize: 11, color: '#999', marginTop: -4, marginBottom: 8 }}>
            相对于 renderer/public/ 的路径，例如 <code>/live2d-models/haitu_vts/...model3.json</code>
          </div>

          <Label>Portrait Zoom: {draft.live2d.portraitZoom.toFixed(2)}</Label>
          <input
            type="range"
            min={0.8}
            max={2.5}
            step={0.05}
            value={draft.live2d.portraitZoom}
            onChange={(e) =>
              setDraft({
                ...draft,
                live2d: { ...draft.live2d, portraitZoom: Number(e.target.value) },
              })
            }
            style={{ width: '100%' }}
          />
        </Section>
        )}

        {/* ---- Mail ---- */}
        {activeTab === 'mail' && (
        <Section title="邮箱（IMAP）">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <input
              type="checkbox"
              checked={draft.mail.enabled}
              onChange={(e) =>
                setDraft({ ...draft, mail: { ...draft.mail, enabled: e.target.checked } })
              }
            />
            启用邮箱读取
          </label>

          {draft.mail.enabled && (
            <>
              <Label>邮箱服务商</Label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
                {MAIL_PRESETS.map((p) => (
                  <button
                    key={p.host}
                    style={chipStyle(draft.mail.host === p.host)}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        mail: { ...draft.mail, host: p.host, port: 993, secure: true },
                      })
                    }
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              {MAIL_PRESETS.find((p) => p.host === draft.mail.host) && (
                <div style={{ fontSize: 11, color: '#999', marginTop: -2, marginBottom: 6 }}>
                  需要"应用专用密码 / 授权码"（不是登录密码）。{' '}
                  <a
                    href={
                      MAIL_PRESETS.find((p) => p.host === draft.mail.host)?.helpUrl ?? '#'
                    }
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: '#7ab' }}
                  >
                    查看官方教程 →
                  </a>
                </div>
              )}

              <Label>IMAP Host</Label>
              <input
                placeholder="imap.gmail.com"
                value={draft.mail.host}
                onChange={(e) =>
                  setDraft({ ...draft, mail: { ...draft.mail, host: e.target.value } })
                }
                style={inputStyle}
              />

              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <Label>Port</Label>
                  <input
                    type="number"
                    value={draft.mail.port}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        mail: { ...draft.mail, port: Number(e.target.value) || 993 },
                      })
                    }
                    style={inputStyle}
                  />
                </div>
                <div style={{ flex: 1, paddingTop: 18 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input
                      type="checkbox"
                      checked={draft.mail.secure}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          mail: { ...draft.mail, secure: e.target.checked },
                        })
                      }
                    />
                    TLS (IMAPS)
                  </label>
                </div>
              </div>

              <Label>用户名 / 邮箱地址</Label>
              <input
                placeholder="you@example.com"
                value={draft.mail.username}
                onChange={(e) =>
                  setDraft({ ...draft, mail: { ...draft.mail, username: e.target.value } })
                }
                style={inputStyle}
              />

              <Label>密码 / 授权码</Label>
              <input
                type="password"
                placeholder={
                  draft.mail.password
                    ? '已保存（输入新密码可替换）'
                    : '应用专用密码 / 授权码'
                }
                value={mailPasswordInput}
                onChange={(e) => setMailPasswordInput(e.target.value)}
                style={inputStyle}
              />
              <div style={{ fontSize: 11, color: '#999', marginTop: -4, marginBottom: 8 }}>
                保存到系统密钥库（macOS Keychain / Windows DPAPI / Linux libsecret）加密。
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  onClick={testMail}
                  disabled={
                    mailTestResult === 'testing' ||
                    !draft.mail.host ||
                    !draft.mail.username
                  }
                  style={btnStyle(false)}
                >
                  {mailTestResult === 'testing' ? '连接中...' : '测试连接'}
                </button>
                {mailTestResult && mailTestResult !== 'testing' && (
                  <span
                    style={{
                      fontSize: 12,
                      color: mailTestResult.ok ? '#8ec98e' : '#f88',
                    }}
                  >
                    {mailTestResult.ok ? '✓ 连接成功' : `✗ ${mailTestResult.error}`}
                  </span>
                )}
              </div>
            </>
          )}
        </Section>
        )}

        {/* ---- Memory ---- */}
        {activeTab === 'memory' && <MemoryTab />}

        {/* ---- Window ---- */}
        {activeTab === 'window' && (
        <Section title="窗口">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <input
              type="checkbox"
              checked={draft.window.alwaysOnTop}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  window: { ...draft.window, alwaysOnTop: e.target.checked },
                })
              }
            />
            始终置顶
          </label>
        </Section>
        )}

        {error && (
          <div style={{ color: '#f88', fontSize: 12, marginTop: 8 }}>[保存失败] {error}</div>
        )}
      </div>

      <div
        style={{
          padding: 10,
          borderTop: '1px solid rgba(255,255,255,0.12)',
          display: 'flex',
          gap: 8,
          justifyContent: 'flex-end',
        }}
      >
        {hasChanges ? (
          <>
            <button onClick={onClose} disabled={saving} style={btnStyle('subtle')}>
              取消
            </button>
            <button onClick={apply} disabled={saving} style={btnStyle('secondary')}>
              {saving ? '...' : '应用'}
            </button>
            <button onClick={save} disabled={saving} style={btnStyle('primary')}>
              {saving ? '...' : '保存'}
            </button>
          </>
        ) : (
          // No pending edits — modal acts as an inspector. Show one Close button.
          <button onClick={onClose} disabled={saving} style={btnStyle('primary')}>
            关闭
          </button>
        )}
      </div>
    </div>
  )
}

// ---- Memory tab ----

/** Friendly label for a session — preview + start date. */
function sessionLabel(s: SessionSummary, isCurrent: boolean): string {
  if (s.id === 'legacy') {
    return `(早期记录 · ${s.count}条)`
  }
  const date = new Date(s.startTs)
  const dateStr = `${date.getMonth() + 1}/${date.getDate()} ${date
    .getHours()
    .toString()
    .padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`
  const preview = s.preview ? s.preview.slice(0, 24).replace(/\n/g, ' ') : '(空会话)'
  const prefix = isCurrent ? '★ ' : ''
  return `${prefix}${dateStr} · ${preview} · ${s.count}条`
}

function MemoryTab() {
  const [status, setStatus] = useState<{
    ready: boolean
    count?: number
    sessionId?: string
  }>({ ready: false })
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  /** Which session is being viewed below. Defaults to current. */
  const [viewSessionId, setViewSessionId] = useState<string | null>(null)
  const [episodes, setEpisodes] = useState<Episode[]>([])
  const [busy, setBusy] = useState(false)

  async function refresh(): Promise<void> {
    const s = await window.api.memory.status()
    setStatus(s)
    if (!s.ready) return
    let list = await window.api.memory.listSessions()
    // The current session might be brand-new and have zero episodes yet —
    // make sure it still appears in the dropdown so the user can SEE it.
    if (s.sessionId && !list.find((x) => x.id === s.sessionId)) {
      const now = new Date().toISOString()
      list = [
        { id: s.sessionId, preview: '', startTs: now, lastTs: now, count: 0 },
        ...list,
      ]
    }
    setSessions(list)
    // Default to current session, falling back to whichever session is on top.
    const target = s.sessionId ?? list[0]?.id ?? null
    setViewSessionId(target)
    if (target) {
      setEpisodes(await window.api.memory.listRecent(200, target))
    } else {
      setEpisodes([])
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-fetch episodes when viewSessionId changes (but skip the first
  // mount where refresh() already populated them).
  useEffect(() => {
    if (!viewSessionId || !status.ready) return
    void (async () => {
      setEpisodes(await window.api.memory.listRecent(200, viewSessionId))
    })()
  }, [viewSessionId, status.ready])

  async function onNewSession(): Promise<void> {
    setBusy(true)
    try {
      await window.api.memory.newSession()
      // Reset view to follow the new current session.
      setViewSessionId(null)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  async function onClearAll(): Promise<void> {
    if (!window.confirm('清空全部记忆？此操作无法撤销，妹妹会忘记之前所有对话。')) return
    setBusy(true)
    try {
      await window.api.memory.clear()
      setViewSessionId(null)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  async function onDeleteViewed(): Promise<void> {
    if (!viewSessionId) return
    const sess = sessions.find((s) => s.id === viewSessionId)
    const label = sess ? sessionLabel(sess, sess.id === status.sessionId) : viewSessionId
    if (!window.confirm(`删除会话「${label}」的全部记录？无法撤销。`)) return
    setBusy(true)
    try {
      await window.api.memory.deleteSession(viewSessionId)
      setViewSessionId(null)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  if (!status.ready) {
    return <div style={{ color: '#999', fontSize: 12 }}>记忆模块未启用或初始化失败。</div>
  }

  return (
    <Section title="记忆">
      <div style={{ fontSize: 12, color: '#ccc', marginBottom: 8 }}>
        共 <b style={{ color: '#fff' }}>{status.count}</b> 条记录，分布在{' '}
        <b style={{ color: '#fff' }}>{sessions.length}</b> 个会话。
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        <button onClick={onNewSession} disabled={busy} style={btnStyle('secondary')}>
          新建会话
        </button>
        <button
          onClick={onDeleteViewed}
          disabled={busy || !viewSessionId}
          style={{
            ...btnStyle('subtle'),
            background: 'rgba(200, 80, 80, 0.15)',
            border: '1px solid rgba(200, 80, 80, 0.35)',
            color: '#f99',
          }}
        >
          删除此会话
        </button>
        <button
          onClick={onClearAll}
          disabled={busy}
          style={{
            ...btnStyle('subtle'),
            background: 'rgba(200, 80, 80, 0.2)',
            border: '1px solid rgba(200, 80, 80, 0.4)',
            color: '#f99',
          }}
        >
          清空全部
        </button>
      </div>

      <Label>查看会话</Label>
      {sessions.length === 0 ? (
        <div style={{ color: '#777', fontSize: 12, padding: 8 }}>
          还没有任何对话记录。聊几句就有了。
        </div>
      ) : (
        <>
          <select
            value={viewSessionId ?? ''}
            onChange={(e) => setViewSessionId(e.target.value)}
            style={{ ...inputStyle, marginBottom: 8 }}
          >
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {sessionLabel(s, s.id === status.sessionId)}
              </option>
            ))}
          </select>

          <div
            style={{
              background: 'rgba(255,255,255,0.04)',
              borderRadius: 6,
              padding: 6,
              maxHeight: 320,
              overflowY: 'auto',
              fontSize: 11,
            }}
          >
            {episodes.length === 0 ? (
              <div style={{ color: '#777', padding: 8 }}>该会话没有记录。</div>
            ) : (
              episodes.map((e) => (
                <div
                  key={e.id}
                  style={{
                    padding: '4px 6px',
                    marginBottom: 2,
                    borderLeft: `3px solid ${e.speaker === 'user' ? '#5a8edf' : '#888'}`,
                  }}
                >
                  <div style={{ color: '#888', fontSize: 10, display: 'flex', gap: 6 }}>
                    <span>{new Date(e.ts).toLocaleTimeString()}</span>
                    <span>· {e.speaker === 'user' ? '我' : '她'}</span>
                  </div>
                  <div style={{ color: '#ddd', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {e.text.length > 200 ? e.text.slice(0, 200) + '…' : e.text}
                  </div>
                </div>
              ))
            )}
          </div>
          <div style={{ fontSize: 10, color: '#777', marginTop: 4 }}>
            ★ = 当前会话（新对话默认归入这里）。切换 dropdown 看历史会话。
          </div>
        </>
      )}
    </Section>
  )
}

// ---- styling helpers ----

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <h3
        style={{
          margin: '0 0 6px',
          fontSize: 12,
          color: '#bbb',
          textTransform: 'uppercase',
          letterSpacing: 0.6,
        }}
      >
        {title}
      </h3>
      {children}
    </div>
  )
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, color: '#aaa', marginTop: 6, marginBottom: 3 }}>{children}</div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  fontSize: 12,
  background: 'rgba(255,255,255,0.08)',
  color: '#eee',
  border: '1px solid rgba(255,255,255,0.15)',
  borderRadius: 4,
  marginBottom: 8,
  boxSizing: 'border-box',
}

function chipStyle(active: boolean): React.CSSProperties {
  return {
    fontSize: 11,
    padding: '3px 8px',
    borderRadius: 12,
    border: '1px solid rgba(255,255,255,0.2)',
    background: active ? 'rgba(120, 160, 255, 0.4)' : 'rgba(255,255,255,0.06)',
    color: '#eee',
    cursor: 'pointer',
  }
}

function tabBtnStyle(active: boolean): React.CSSProperties {
  return {
    fontSize: 13,
    padding: '8px 14px',
    background: 'transparent',
    border: 'none',
    borderBottom: active ? '2px solid #5a8edf' : '2px solid transparent',
    color: active ? '#fff' : '#aaa',
    cursor: 'pointer',
    fontWeight: active ? 600 : 400,
    transition: 'color 0.1s',
  }
}

type BtnVariant = 'primary' | 'secondary' | 'subtle'
function btnStyle(variant: BtnVariant | boolean): React.CSSProperties {
  // Backwards-compat: callers passing a bool get treated as primary / subtle.
  const v: BtnVariant = typeof variant === 'boolean' ? (variant ? 'primary' : 'subtle') : variant
  const base: React.CSSProperties = {
    padding: '6px 18px',
    fontSize: 13,
    borderRadius: 4,
    cursor: 'pointer',
    color: 'white',
  }
  switch (v) {
    case 'primary':
      return { ...base, background: '#5a8edf', border: 'none' }
    case 'secondary':
      return {
        ...base,
        background: 'rgba(90, 142, 223, 0.22)',
        border: '1px solid #5a8edf',
        color: '#cfdcf3',
      }
    case 'subtle':
      return { ...base, background: 'rgba(255,255,255,0.12)', border: 'none' }
  }
}

const closeBtnStyle: React.CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: 12,
  border: 'none',
  background: 'rgba(255,255,255,0.15)',
  color: 'white',
  fontSize: 14,
  cursor: 'pointer',
  padding: 0,
}
