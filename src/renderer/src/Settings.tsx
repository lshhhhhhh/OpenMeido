/**
 * Settings modal. Full-window overlay with the same translucent / blur look
 * as the chat panel. Edits are kept in local React state and only written to
 * the persistent config when the user clicks Save.
 */

import { useEffect, useState } from 'react'

import { confirm, prompt } from './confirm'
import { CUSTOM_PERSONA_TEMPLATE, personaPresets, type Config } from '../../shared/config'
import type { Episode, Fact, SessionSummary } from '../../core/memory/types'
import {
  EMOTIONS,
  type Emotion,
  type ModelListEntry,
  type ModelSidecar,
} from '../../shared/live2d-models'
import { BASE_URL_PRESETS, findPreset, suggestedModels } from './backend-presets'

interface SettingsProps {
  initial: Config
  onClose: () => void
}

// BASE_URL_PRESETS / findPreset / suggestedModels / MODEL_SUGGESTIONS_BY_HOST
// live in ./backend-presets.ts so the SetupWizard can share them. See that
// file for the full table + per-provider env var / signup URL.

/** IMAP presets for common providers. Port is always 993 (IMAPS). */
const MAIL_PRESETS: { label: string; host: string; helpUrl: string }[] = [
  { label: 'Gmail', host: 'imap.gmail.com', helpUrl: 'https://support.google.com/accounts/answer/185833' },
  { label: 'Outlook', host: 'outlook.office365.com', helpUrl: 'https://support.microsoft.com/en-us/account-billing/manage-app-passwords-for-two-step-verification-d6dc8c6d-4bf7-4851-ad95-6d07799387e9' },
  { label: 'iCloud', host: 'imap.mail.me.com', helpUrl: 'https://support.apple.com/en-us/102654' },
  { label: '163', host: 'imap.163.com', helpUrl: 'https://mail.163.com/' },
  { label: 'QQ', host: 'imap.qq.com', helpUrl: 'https://service.mail.qq.com/detail/0/351' },
]

type TabId = 'ai' | 'persona' | 'live2d' | 'voice' | 'mail' | 'memory' | 'window' | 'proactive'
const TABS: { id: TabId; label: string }[] = [
  { id: 'ai', label: 'AI' },
  { id: 'persona', label: '人设' },
  { id: 'live2d', label: 'Live2D' },
  { id: 'voice', label: '语音' },
  { id: 'proactive', label: '主动' },
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
                  // Switching providers resets THREE fields so a stale value
                  // from the previous backend doesn't silently get reused:
                  //   - model: a gemini id has no meaning at the OpenAI URL
                  //   - apiKey: an OpenAI key is invalid for DeepSeek/GLM/
                  //     Qwen/etc. Leaving it set blocks the main-process
                  //     .env fallback (which only kicks in when apiKey is ""),
                  //     so the request fires with the WRONG provider's key
                  //     and returns 401 (this exact bug bit us once).
                  const newSuggestions = suggestedModels(p.url)
                  const stillValid = newSuggestions.includes(draft.backend.model)
                  setDraft({
                    ...draft,
                    backend: {
                      ...draft.backend,
                      baseUrl: p.url,
                      model: stillValid ? draft.backend.model : newSuggestions[0] ?? draft.backend.model,
                      apiKey: '',
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
          {(() => {
            // Resolve hint + signup link from the active preset so the prompt
            // names the RIGHT env var (the old hardcoded "OPENAI_API_KEY /
            // GEMINI_API_KEY" was wrong for any user on GLM / DeepSeek / Qwen
            // / Doubao). Custom (non-preset) URLs get a generic hint.
            const preset = findPreset(draft.backend.baseUrl)
            return (
              <div
                style={{
                  fontSize: 11,
                  color: '#999',
                  marginTop: -4,
                  marginBottom: 8,
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                {preset ? (
                  preset.envVar ? (
                    <>
                      <span>
                        留空则使用 <code>.env</code> 中的{' '}
                        <code>{preset.envVar}</code>（仅开发兜底）。
                      </span>
                      <a
                        href={preset.signupUrl}
                        // Open in the user's real browser, not inside
                        // OpenMeido — Electron lets us hand it off cleanly.
                        onClick={(e) => {
                          e.preventDefault()
                          void window.open(preset.signupUrl, '_blank', 'noopener,noreferrer')
                        }}
                        style={{ color: '#7ab8ff', textDecoration: 'underline' }}
                      >
                        去 {preset.label} 注册 →
                      </a>
                      {preset.note && (
                        <span style={{ color: '#7c7' }}>{preset.note}</span>
                      )}
                    </>
                  ) : (
                    <span>{preset.note ?? '本地端点，通常无需 key。'}</span>
                  )
                ) : (
                  <span>留空则使用 <code>.env</code> 兜底（仅开发模式）。</span>
                )}
              </div>
            )
          })()}

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
                Uses the in-app prompt() (NOT window.prompt) — native dialogs
                break input focus on transparent windows, see ./confirm.tsx. */}
            <button
              style={chipStyle(
                !suggestedModels(draft.backend.baseUrl).includes(draft.backend.model),
              )}
              onClick={async () => {
                const v = await prompt(
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
                      onClick={async () => {
                        if (
                          active.systemPrompt === CUSTOM_PERSONA_TEMPLATE ||
                          (await confirm('重置为默认模板？当前编辑内容会丢失。'))
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
                    onClick={async () => {
                      if (!(await confirm(`删除人设「${active.name}」？此操作无法撤销。`))) return
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
          <Live2DTab
            activeModel={draft.live2d.activeModel}
            portraitZoom={draft.live2d.portraitZoom}
            onChangeActive={(name) =>
              setDraft({ ...draft, live2d: { ...draft.live2d, activeModel: name } })
            }
            onChangeZoom={(z) =>
              setDraft({ ...draft, live2d: { ...draft.live2d, portraitZoom: z } })
            }
          />
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

        {/* ---- Voice / TTS ---- */}
        {activeTab === 'voice' && (
          <VoiceTab
            draft={draft.tts}
            onChange={(next) => setDraft({ ...draft, tts: next })}
          />
        )}

        {/* ---- Proactive ---- */}
        {activeTab === 'proactive' && (
          <ProactiveTab
            draft={draft.proactive}
            onChange={(next) => setDraft({ ...draft, proactive: next })}
          />
        )}

        {/* ---- Memory ---- */}
        {activeTab === 'memory' && <MemoryTab />}

        {/* ---- Window ---- */}
        {activeTab === 'window' && (
          <>
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

            <Section title="Demo 模式">
              <div style={{ fontSize: 12, color: '#bbb', marginBottom: 8, lineHeight: 1.5 }}>
                每条 demo 配一个热键，按下播台词 + Live2D 表情 + TTS。
                <br />
                台词存在 <code>demos.json</code>，记事本 / VSCode 改完保存立刻生效，不用重启。
                <br />
                <span style={{ color: '#888' }}>
                  默认 <code>1</code> 触发第一条、<code>2</code> 触发第二条。文件结构：
                  <br />
                  <code>{'[ { "hotkey": "1", "text": "...", "expression": "星星眼" }, ... ]'}</code>
                  <br />
                  在聊天输入框里打字时数字键不会触发（要带 Ctrl/Alt 修饰才能强制触发）。
                </span>
              </div>
              <button
                onClick={() => void window.api.demos.reveal()}
                style={btnStyle('secondary')}
              >
                📝 打开 demos.json
              </button>
            </Section>
          </>
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

/**
 * Proactive remark settings. When enabled, the maid speaks up on her own
 * based on timer / idle triggers. The LLM gets a veto via a "should_speak"
 * JSON response, so configuring an aggressive timer doesn't necessarily
 * mean she'll actually interrupt — she might quietly say nothing.
 */
function ProactiveTab({
  draft,
  onChange,
}: {
  draft: Config['proactive']
  onChange: (next: Config['proactive']) => void
}) {
  return (
    <Section title="主动模式">
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => onChange({ ...draft, enabled: e.target.checked })}
        />
        <span>启用主动搭话（后台轮询，LLM 决定是否说话）</span>
      </label>
      {draft.enabled && (
        <>
          <Label>定时间隔（分钟）—— {Math.round(draft.timerSec / 60)}</Label>
          <input
            type="range"
            min={60}
            max={3600}
            step={60}
            value={draft.timerSec}
            onChange={(e) => onChange({ ...draft, timerSec: Number(e.target.value) })}
            style={{ width: '100%', marginBottom: 12 }}
          />

          <Label>空闲阈值（分钟）—— {Math.round(draft.idleThresholdSec / 60)}</Label>
          <input
            type="range"
            min={60}
            max={3600}
            step={60}
            value={draft.idleThresholdSec}
            onChange={(e) => onChange({ ...draft, idleThresholdSec: Number(e.target.value) })}
            style={{ width: '100%', marginBottom: 12 }}
          />

          <Label>冷却（两次主动至少间隔，分钟）—— {Math.round(draft.cooldownSec / 60)}</Label>
          <input
            type="range"
            min={60}
            max={3600}
            step={60}
            value={draft.cooldownSec}
            onChange={(e) => onChange({ ...draft, cooldownSec: Number(e.target.value) })}
            style={{ width: '100%', marginBottom: 12 }}
          />

          <div style={{ fontSize: 11, color: '#888', marginBottom: 12 }}>
            模型可能仍然选择沉默（觉得不该打扰）。即使触发了也不一定开口。
          </div>
        </>
      )}

      <div
        style={{
          borderTop: '1px solid rgba(255,255,255,0.1)',
          paddingTop: 12,
          marginTop: 8,
        }}
      >
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <input
            type="checkbox"
            checked={draft.notifListener.enabled}
            onChange={(e) =>
              onChange({
                ...draft,
                notifListener: { ...draft.notifListener, enabled: e.target.checked },
              })
            }
          />
          <span>监听系统通知（Windows）</span>
        </label>
        <div style={{ fontSize: 11, color: '#888', marginBottom: 8, lineHeight: 1.5 }}>
          开启后，OpenMeido 会订阅 Windows 通知中心，LLM 判断哪些值得提示给你（比如 QQ
          私聊、邮件），过滤掉广告和系统消息。
          <br />
          <b>首次开启 Windows 会弹出系统授权框</b>——同意一次就行，以后不再问。
        </div>
        {draft.notifListener.enabled && (
          <>
            <Label>应用白名单（每行一个，子串匹配，空=接受所有，很吵慎用）</Label>
            <textarea
              value={draft.notifListener.allowlist.join('\n')}
              onChange={(e) =>
                onChange({
                  ...draft,
                  notifListener: {
                    ...draft.notifListener,
                    // Trim + drop empties so trailing newlines don't insert a blank entry
                    // that matches every app (substring match against "" hits everything).
                    allowlist: e.target.value
                      .split('\n')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  },
                })
              }
              rows={5}
              placeholder={'QQ\nWeChat\n微信\nOutlook'}
              style={{ ...inputStyle, fontFamily: 'monospace', resize: 'vertical' }}
            />
            <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
              仅 Windows 10 1607+ 支持。Mac / Linux 上这个开关无效。
            </div>
          </>
        )}
      </div>
    </Section>
  )
}

/**
 * Live2D model picker + per-model emotion mapping editor.
 *
 * Reads the installed-model list from main on mount (`live2d:listModels`),
 * lets the user:
 *   - pick the active model (writes draft.live2d.activeModel)
 *   - import a new model via zip (calls main, which shows a native picker)
 *   - delete an installed model
 *   - edit emotion → expression / motion mapping in the model's sidecar
 *     (saved INSTANTLY to the sidecar JSON — not gated by Settings 保存
 *     because that maps to the global Config and sidecars live per-model
 *     on disk).
 */
function Live2DTab({
  activeModel,
  portraitZoom,
  onChangeActive,
  onChangeZoom,
}: {
  activeModel: string
  portraitZoom: number
  onChangeActive: (name: string) => void
  onChangeZoom: (z: number) => void
}) {
  const [models, setModels] = useState<ModelListEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [autoBinding, setAutoBinding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    setLoading(true)
    try {
      const list = await window.api.live2d.listModels()
      setModels(list)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const active = models.find((m) => m.name === activeModel)

  async function onImport(): Promise<void> {
    if (importing) return
    setImporting(true)
    setError(null)
    try {
      const r = await window.api.live2d.importZip({})
      if (!r.ok) {
        if (!r.canceled) setError(`导入失败：${r.error}`)
        return
      }
      await refresh()
      onChangeActive(r.name)
    } finally {
      setImporting(false)
    }
  }

  async function onAutoBind(name: string): Promise<void> {
    if (autoBinding) return
    // Destructive — wipes whatever the user (or last AI run) had in the
    // sidecar. Confirm so an accidental click doesn't burn token + delete
    // hand-tuned mappings.
    if (
      !(await confirm(
        `用 AI 重新绑定「${name}」的情绪映射？\n\n` +
          '• 会覆盖你现有的所有手动 / 上次 AI 绑定结果\n' +
          '• 消耗当前 chat backend 的 token（一次调用）\n' +
          '• AI 可能挑到不太合适的表情（命名抽象的模型尤其容易踩坑）',
      ))
    ) {
      return
    }
    setAutoBinding(true)
    setError(null)
    try {
      const r = await window.api.live2d.autoBindEmotions(name)
      if (!r.ok) {
        setError(`AI 绑定失败：${r.error}`)
        return
      }
      await refresh()
    } finally {
      setAutoBinding(false)
    }
  }

  async function onDelete(name: string): Promise<void> {
    if (!(await confirm(`删除模型「${name}」？磁盘上的所有文件都会被清掉，无法撤销。`))) return
    setError(null)
    await window.api.live2d.deleteModel(name)
    // If we just deleted the active one, fall back to the first remaining.
    const next = (await window.api.live2d.listModels())[0]?.name
    if (next && name === activeModel) onChangeActive(next)
    await refresh()
  }

  // Sidecar edits are saved immediately — the per-emotion select onChange
  // dispatches a write, then re-fetches the list so the UI reflects what's
  // on disk. Debouncing isn't worth the complexity here (user clicks a
  // dropdown once per emotion, not a continuous stream).
  async function updateMapping(
    name: string,
    field: 'emotionMapping' | 'motionMapping',
    emotion: Emotion,
    value: string | { group: string; index: number } | undefined,
  ): Promise<void> {
    const m = models.find((x) => x.name === name)
    if (!m) return
    const base = m.sidecar
    const next: ModelSidecar = {
      ...base,
      emotionMapping: { ...(base.emotionMapping ?? {}) },
      motionMapping: { ...(base.motionMapping ?? {}) },
    }
    if (value === undefined) {
      delete (next[field] as Record<string, unknown>)[emotion]
    } else {
      ;(next[field] as Record<string, unknown>)[emotion] = value
    }
    await window.api.live2d.setSidecar(name, next)
    await refresh()
  }

  return (
    <Section title="Live2D">
      <Label>当前模型</Label>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <select
          value={activeModel}
          onChange={(e) => onChangeActive(e.target.value)}
          style={{ ...inputStyle, flex: 1 }}
        >
          {models.length === 0 && <option value={activeModel}>{activeModel}</option>}
          {models.map((m) => (
            <option key={m.name} value={m.name}>
              {m.name} · {m.expressionCount}表情 · {m.motionCount}动作
            </option>
          ))}
        </select>
        <button onClick={onImport} disabled={importing} style={btnStyle('secondary')}>
          {importing ? '导入中…' : '导入 zip'}
        </button>
      </div>
      {error && (
        <div style={{ fontSize: 11, color: '#f99', marginBottom: 8 }}>{error}</div>
      )}
      <div style={{ fontSize: 11, color: '#888', marginBottom: 12 }}>
        模型存放在 <code>%APPDATA%/openmeido/live2d-models/</code>。导入的 zip
        必须包含 <code>*.model3.json</code>，否则会被拒收。
      </div>

      <Label>Portrait Zoom: {portraitZoom.toFixed(2)}</Label>
      <input
        type="range"
        min={0.8}
        max={2.5}
        step={0.05}
        value={portraitZoom}
        onChange={(e) => onChangeZoom(Number(e.target.value))}
        style={{ width: '100%', marginBottom: 12 }}
      />

      {active && (
        <>
          <div
            style={{
              fontSize: 12,
              color: '#ccc',
              borderTop: '1px solid rgba(255,255,255,0.1)',
              paddingTop: 10,
              marginTop: 8,
              marginBottom: 8,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>
              <b>{active.name}</b> · 情绪绑定
              <span style={{ color: '#888', fontSize: 11, marginLeft: 8 }}>
                {loading ? '加载中…' : '改动即刻保存'}
              </span>
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                onClick={() => void onAutoBind(active.name)}
                disabled={
                  autoBinding ||
                  (active.expressionCount === 0 && active.motionCount === 0)
                }
                title="让当前 AI backend 看表情/动作名字猜映射，自动写回 sidecar（会覆盖你已填的内容）"
                style={{
                  ...btnStyle('subtle'),
                  background: 'rgba(120, 160, 255, 0.18)',
                  border: '1px solid rgba(120, 160, 255, 0.45)',
                  color: '#aad4ff',
                  fontSize: 11,
                  padding: '2px 8px',
                }}
              >
                {autoBinding ? '⏳ AI 绑定中…' : '✨ AI 绑定表情'}
              </button>
              {active.name !== 'haitu_vts' && (
                <button
                  onClick={() => void onDelete(active.name)}
                  style={{
                    ...btnStyle('subtle'),
                    background: 'rgba(200, 80, 80, 0.15)',
                    border: '1px solid rgba(200, 80, 80, 0.35)',
                    color: '#f99',
                    fontSize: 11,
                    padding: '2px 8px',
                  }}
                >
                  删除模型
                </button>
              )}
            </div>
          </div>

          {active.expressionCount === 0 && active.motionCount === 0 && (
            <div style={{ fontSize: 11, color: '#888' }}>
              这个模型既没有表情文件，也没有动作组——情绪绑定无效。
            </div>
          )}

          {EMOTIONS.map((emotion) => {
            const expr = active.sidecar.emotionMapping?.[emotion]
            const motion = active.sidecar.motionMapping?.[emotion]
            return (
              <div
                key={emotion}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '60px 1fr 1fr',
                  gap: 6,
                  marginBottom: 6,
                  alignItems: 'center',
                }}
              >
                <span style={{ fontSize: 12 }}>{emotion}</span>
                <select
                  value={expr ?? ''}
                  onChange={(e) =>
                    void updateMapping(
                      active.name,
                      'emotionMapping',
                      emotion,
                      e.target.value || undefined,
                    )
                  }
                  disabled={active.expressionCount === 0}
                  style={{ ...inputStyle, fontSize: 11 }}
                  title={active.expressionCount === 0 ? '此模型无表情文件' : '映射到一个表情'}
                >
                  <option value="">— 表情 —</option>
                  {active.expressionNames.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
                <select
                  value={motion ? `${motion.group}:${motion.index}` : ''}
                  onChange={(e) => {
                    const v = e.target.value
                    if (!v) {
                      void updateMapping(active.name, 'motionMapping', emotion, undefined)
                    } else {
                      const [group, idx] = v.split(':')
                      void updateMapping(active.name, 'motionMapping', emotion, {
                        group: group!,
                        index: Number(idx),
                      })
                    }
                  }}
                  disabled={active.motionCount === 0}
                  style={{ ...inputStyle, fontSize: 11 }}
                  title={active.motionCount === 0 ? '此模型无动作' : '映射到一个动作'}
                >
                  <option value="">— 动作 —</option>
                  {active.motionGroups.flatMap((g) =>
                    Array.from({ length: g.count }, (_, i) => (
                      <option key={`${g.group}:${i}`} value={`${g.group}:${i}`}>
                        {g.group} [{i}]
                      </option>
                    )),
                  )}
                </select>
              </div>
            )
          })}
        </>
      )}
    </Section>
  )
}

/**
 * Voice / TTS settings tab. The voice catalog is fetched from main on
 * mount — Edge TTS exposes ~400 voices, we filter to zh-* and en-US by
 * default so the dropdown stays usable.
 */
function VoiceTab({
  draft,
  onChange,
}: {
  draft: Config['tts']
  onChange: (next: Config['tts']) => void
}) {
  const [voices, setVoices] = useState<
    { shortName: string; locale: string; gender: string; friendlyName: string }[]
  >([])
  const [loading, setLoading] = useState(false)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [filter, setFilter] = useState<'zh' | 'en' | 'all'>('zh')

  // Only the Edge backend needs the voice catalog. Skip the fetch when SoVITS
  // is selected so a user without internet (or on the local-only build) isn't
  // hit with a useless network call.
  useEffect(() => {
    if (draft.backend !== 'edge') return
    if (voices.length > 0) return
    setLoading(true)
    void window.api.tts.listVoices().then((list) => {
      setVoices(list)
      setLoading(false)
    })
  }, [draft.backend, voices.length])

  const filtered = voices.filter((v) => {
    if (filter === 'all') return true
    if (filter === 'zh') return v.locale.startsWith('zh-')
    if (filter === 'en') return v.locale.startsWith('en-')
    return true
  })

  async function onPreview(): Promise<void> {
    if (previewBusy) return
    setPreviewBusy(true)
    try {
      // Pass the draft so the user can hear unsaved changes (ref audio path,
      // ref text, voice choice). Without this override main would read the
      // persisted config and ignore the in-progress edit.
      const r = await window.api.tts.synthesize(
        '你好，我是你的桌面伙伴，很高兴见到你。',
        draft,
      )
      if ('error' in r) {
        alert(`试听失败：${r.error}`)
        return
      }
      const { playMp3Base64 } = await import('./tts/player')
      await playMp3Base64(r.base64, { mouthGain: draft.mouthGain })
    } finally {
      setPreviewBusy(false)
    }
  }

  return (
    <Section title="语音 (TTS)">
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => onChange({ ...draft, enabled: e.target.checked })}
        />
        <span>启用语音合成</span>
      </label>

      {draft.enabled && (
        <>
          <Label>引擎</Label>
          <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
            {(
              [
                { id: 'edge', label: 'Edge TTS', hint: '免费 · 联网 · 微软' },
                { id: 'sovits', label: 'GPT-SoVITS', hint: '本地 · 零样本克隆' },
              ] as const
            ).map((b) => (
              <button
                key={b.id}
                onClick={() => onChange({ ...draft, backend: b.id })}
                style={{
                  ...btnStyle(draft.backend === b.id ? 'primary' : 'subtle'),
                  padding: '4px 12px',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  lineHeight: 1.2,
                }}
              >
                <span style={{ fontSize: 12 }}>{b.label}</span>
                <span style={{ fontSize: 10, opacity: 0.7 }}>{b.hint}</span>
              </button>
            ))}
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
            <input
              type="checkbox"
              checked={draft.autoPlay}
              onChange={(e) => onChange({ ...draft, autoPlay: e.target.checked })}
            />
            <span>自动朗读每条回复（关闭后只在你点喇叭时朗读）</span>
          </label>

          {draft.backend === 'edge' && (
            <>
              <Label>语言筛选</Label>
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                {(['zh', 'en', 'all'] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    style={{
                      ...btnStyle(filter === f ? 'primary' : 'subtle'),
                      padding: '2px 10px',
                      fontSize: 11,
                    }}
                  >
                    {f === 'zh' ? '中文' : f === 'en' ? 'English' : '全部'}
                  </button>
                ))}
                <span style={{ alignSelf: 'center', fontSize: 11, color: '#888' }}>
                  {loading ? '加载中…' : `${filtered.length} / ${voices.length}`}
                </span>
              </div>

              <Label>声音</Label>
              <select
                value={draft.voice}
                onChange={(e) => onChange({ ...draft, voice: e.target.value })}
                style={{ ...inputStyle, marginBottom: 12 }}
              >
                {filtered.length === 0 && <option value={draft.voice}>{draft.voice}</option>}
                {filtered.map((v) => (
                  <option key={v.shortName} value={v.shortName}>
                    {v.friendlyName.replace('Microsoft ', '')} · {v.locale} · {v.gender}
                  </option>
                ))}
              </select>
            </>
          )}

          {draft.backend === 'sovits' && (
            <SovitsFields
              draft={draft.sovits}
              onChange={(next) => onChange({ ...draft, sovits: next })}
            />
          )}

          <Label>嘴型幅度 ({draft.mouthGain.toFixed(1)})</Label>
          <input
            type="range"
            min={1}
            max={8}
            step={0.1}
            value={draft.mouthGain}
            onChange={(e) => onChange({ ...draft, mouthGain: Number(e.target.value) })}
            style={{ width: '100%', marginBottom: 12 }}
          />

          <button onClick={onPreview} disabled={previewBusy} style={btnStyle('secondary')}>
            {previewBusy ? '播放中…' : '试听'}
          </button>
        </>
      )}
    </Section>
  )
}

function SovitsFields({
  draft,
  onChange,
}: {
  draft: Config['tts']['sovits']
  onChange: (next: Config['tts']['sovits']) => void
}) {
  return (
    <>
      <div
        style={{
          fontSize: 11,
          color: '#666',
          background: 'rgba(0,0,0,0.04)',
          padding: '6px 8px',
          borderRadius: 4,
          marginBottom: 8,
          lineHeight: 1.5,
        }}
      >
        需要本地跑 GPT-SoVITS api_v2.py（默认 9880 端口）。
        服务里先加载好声音模型，然后填这里：
      </div>

      <Label>api_v2.py 地址</Label>
      <input
        type="text"
        value={draft.baseUrl}
        onChange={(e) => onChange({ ...draft, baseUrl: e.target.value })}
        placeholder="http://127.0.0.1:9880"
        style={{ ...inputStyle, marginBottom: 8 }}
      />

      <Label>参考音频路径（服务器侧绝对路径，3-10 秒 wav）</Label>
      <input
        type="text"
        value={draft.refAudio}
        onChange={(e) => onChange({ ...draft, refAudio: e.target.value })}
        placeholder="C:\\path\\to\\ref.wav"
        style={{ ...inputStyle, marginBottom: 8 }}
      />

      <Label>参考音频的文字内容（必须和录音完全一致）</Label>
      <textarea
        value={draft.refText}
        onChange={(e) => onChange({ ...draft, refText: e.target.value })}
        placeholder="一段录音原文，比如：今天天气真好我们出去玩吧"
        rows={2}
        style={{ ...inputStyle, marginBottom: 8, resize: 'vertical' }}
      />

      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <div style={{ flex: 1 }}>
          <Label>参考语言</Label>
          <select
            value={draft.refLang}
            onChange={(e) => onChange({ ...draft, refLang: e.target.value })}
            style={inputStyle}
          >
            {['zh', 'en', 'ja', 'ko', 'yue', 'auto'].map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <Label>合成语言</Label>
          <select
            value={draft.textLang}
            onChange={(e) => onChange({ ...draft, textLang: e.target.value })}
            style={inputStyle}
          >
            {['zh', 'en', 'ja', 'ko', 'yue', 'auto'].map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </div>
      </div>

      <Label>语速 ({draft.speedFactor.toFixed(2)})</Label>
      <input
        type="range"
        min={0.5}
        max={2}
        step={0.05}
        value={draft.speedFactor}
        onChange={(e) => onChange({ ...draft, speedFactor: Number(e.target.value) })}
        style={{ width: '100%', marginBottom: 8 }}
      />

      <details style={{ marginBottom: 12 }}>
        <summary style={{ fontSize: 11, color: '#666', cursor: 'pointer' }}>
          采样高级参数 (top-k / top-p / temperature)
        </summary>
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <div style={{ flex: 1 }}>
            <Label>top-k</Label>
            <input
              type="number"
              min={1}
              max={50}
              value={draft.topK}
              onChange={(e) => onChange({ ...draft, topK: Number(e.target.value) || 5 })}
              style={inputStyle}
            />
          </div>
          <div style={{ flex: 1 }}>
            <Label>top-p</Label>
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={draft.topP}
              onChange={(e) => onChange({ ...draft, topP: Number(e.target.value) || 1 })}
              style={inputStyle}
            />
          </div>
          <div style={{ flex: 1 }}>
            <Label>temp</Label>
            <input
              type="number"
              min={0}
              max={2}
              step={0.05}
              value={draft.temperature}
              onChange={(e) => onChange({ ...draft, temperature: Number(e.target.value) || 1 })}
              style={inputStyle}
            />
          </div>
        </div>
      </details>
    </>
  )
}

function MemoryTab() {
  const [status, setStatus] = useState<{
    ready: boolean
    count?: number
    sessionId?: string
    initError?: string
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
    if (!(await confirm('清空全部记忆？此操作无法撤销，妹妹会忘记之前所有对话。'))) return
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
    if (!(await confirm(`删除会话「${label}」的全部记录？无法撤销。`))) return
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
    return (
      <div style={{ fontSize: 12, lineHeight: 1.5 }}>
        <div style={{ color: '#f88', marginBottom: 6 }}>记忆模块初始化失败 / 未启用。</div>
        {status.initError && (
          <pre
            style={{
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 4,
              padding: '8px 10px',
              color: '#ddd',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'monospace',
              fontSize: 11,
              margin: 0,
            }}
          >
            {status.initError}
          </pre>
        )}
        <div style={{ color: '#888', marginTop: 8 }}>
          常见原因：better-sqlite3 / sqlite-vec 原生模块在打包时没正确解压，或者
          embedding 模型（~95MB）首次下载失败。把上面这段错误截图发给开发者帮忙看。
        </div>
      </div>
    )
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

      <Label>查看会话（切换需要点下方按钮）</Label>
      {sessions.length === 0 ? (
        <div style={{ color: '#777', fontSize: 12, padding: 8 }}>
          还没有任何对话记录。聊几句就有了。
        </div>
      ) : (
        <>
          <select
            value={viewSessionId ?? ''}
            // Dropdown is preview-only. Switching the ACTIVE session is a
            // big deal (changes where future chat lands) so we require an
            // explicit click on the "切换到此会话" button below.
            onChange={(e) => setViewSessionId(e.target.value)}
            style={{ ...inputStyle, marginBottom: 8 }}
          >
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {sessionLabel(s, s.id === status.sessionId)}
              </option>
            ))}
          </select>

          {/* Switch button — appears only when peeking at a session that
              isn't already the active one. Disabled on the current session
              to make "this is already active" visible. */}
          {viewSessionId && viewSessionId !== status.sessionId && (
            <button
              onClick={async () => {
                if (!viewSessionId) return
                setBusy(true)
                try {
                  await window.api.memory.setSession(viewSessionId)
                  await refresh()
                } finally {
                  setBusy(false)
                }
              }}
              disabled={busy}
              style={{ ...btnStyle('primary'), marginBottom: 8, width: '100%' }}
            >
              切换到此会话 · 之后的对话都续在这里
            </button>
          )}

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
            ★ = 当前活跃会话（新对话会归入这里）。dropdown 只是预览，要切换请点上方按钮。
          </div>
        </>
      )}

      <FactsPanel />
    </Section>
  )
}

/**
 * L3 facts inspector. Lives inside MemoryTab so the user can audit what
 * the LLM has decided to "remember" about them — and prune wrong facts
 * with one click. Facts auto-refresh on mount and after manual reflect.
 */
function FactsPanel() {
  const [facts, setFacts] = useState<Fact[]>([])
  const [busy, setBusy] = useState(false)
  const [lastReflect, setLastReflect] = useState<string | null>(null)

  async function refresh(): Promise<void> {
    setFacts(await window.api.memory.listFacts(200))
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function onReflectNow(): Promise<void> {
    setBusy(true)
    setLastReflect(null)
    try {
      const n = await window.api.memory.reflectNow()
      setLastReflect(n > 0 ? `提取了 ${n} 条事实` : '本轮没提取到新事实')
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  async function onClearFacts(): Promise<void> {
    if (!(await confirm('清空所有事实？妹妹会忘记关于你的所有"已知"，下次对话时会重新攒。'))) return
    setBusy(true)
    try {
      await window.api.memory.clearFacts()
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: 8,
        }}
      >
        <Label>她记住的事实 ({facts.length})</Label>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={onReflectNow} disabled={busy} style={btnStyle('secondary')}>
            {busy ? '提取中…' : '立即提取'}
          </button>
          <button
            onClick={onClearFacts}
            disabled={busy || facts.length === 0}
            style={{
              ...btnStyle('subtle'),
              background: 'rgba(200, 80, 80, 0.15)',
              border: '1px solid rgba(200, 80, 80, 0.35)',
              color: '#f99',
            }}
          >
            清空
          </button>
        </div>
      </div>
      {lastReflect && (
        <div style={{ color: '#9c9', fontSize: 11, marginBottom: 6 }}>{lastReflect}</div>
      )}
      {facts.length === 0 ? (
        <div style={{ color: '#777', fontSize: 12, padding: 8 }}>
          还没有提取到稳定事实。聊几句关于你自己的事，下次反射就会有。
        </div>
      ) : (
        <div
          style={{
            background: 'rgba(255,255,255,0.04)',
            borderRadius: 6,
            padding: 6,
            maxHeight: 200,
            overflowY: 'auto',
            fontSize: 11,
          }}
        >
          {facts.map((f) => (
            <div
              key={f.id}
              style={{
                padding: '3px 6px',
                marginBottom: 2,
                display: 'flex',
                gap: 8,
                alignItems: 'baseline',
              }}
              title={`置信度 ${f.confidence.toFixed(2)} · ${new Date(f.updatedAt).toLocaleString()}`}
            >
              <span style={{ color: '#7af', fontFamily: 'monospace', minWidth: 0, flexShrink: 1 }}>
                {f.key}
              </span>
              <span style={{ color: '#ddd', flex: 1 }}>{f.value}</span>
              <span style={{ color: '#666', fontSize: 10 }}>
                {(f.confidence * 100).toFixed(0)}%
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
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
