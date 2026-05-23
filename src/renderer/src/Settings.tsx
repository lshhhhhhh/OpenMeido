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
import { performanceModel, visionModel } from '../../shared/lightweight-models'
import {
  MINIMAX_MODELS,
  MINIMAX_PRESET_VOICES,
  VOLCENGINE_CLUSTERS,
  VOLCENGINE_PRESET_VOICES,
} from '../../shared/tts-voices'

/**
 * Per-capability resolution for the active provider. Drives the "能力概览"
 * card in the AI tab so the user can see, after picking a vendor, which
 * model handles which job — and when something isn't supported at all.
 *
 * Returning a discriminated string makes the renderer keep its switch
 * exhaustive (`have` → model, `none` → hint, `depends` → LM Studio).
 */
type Capability =
  | { kind: 'have'; model: string }
  | { kind: 'none'; hint: string }
  | { kind: 'depends'; hint: string }

function textCapability(baseUrl: string, currentModel: string): Capability {
  // 文字对话用的就是用户当前选定的 model。perf tier 只是 OpenMeido 给该
  // backend 的默认推荐，用户可以在 "换一个 ▾" 里改成别的——能力矩阵
  // 应该反映"实际在用什么"，不是"我们建议用什么"。
  if (currentModel) return { kind: 'have', model: currentModel }
  if (baseUrl.includes('127.0.0.1') || baseUrl.includes('localhost'))
    return { kind: 'depends', hint: '取决于 LM Studio 当前加载的模型' }
  const perf = performanceModel(baseUrl)
  return perf
    ? { kind: 'have', model: perf }
    : { kind: 'none', hint: '未配置模型' }
}

function visionCapability(baseUrl: string, currentModel: string): Capability {
  const vis = visionModel(baseUrl)
  if (vis) return { kind: 'have', model: vis }
  if (baseUrl.includes('deepseek.com'))
    return { kind: 'none', hint: 'DeepSeek 不支持图像 — 换 Gemini / GLM / Qwen' }
  if (baseUrl.includes('127.0.0.1') || baseUrl.includes('localhost'))
    return {
      kind: 'depends',
      hint: `取决于加载的模型（${currentModel || '?'}），仅多模态模型可用`,
    }
  return { kind: 'none', hint: '当前 backend 没有视觉模型 — 换 Gemini / GLM / Qwen' }
}

function searchCapability(baseUrl: string): Capability {
  if (baseUrl.includes('googleapis.com'))
    return { kind: 'have', model: '✓ Google 搜索（Gemini grounding）' }
  if (baseUrl.includes('bigmodel.cn'))
    return { kind: 'have', model: '✓ 智谱内置 web_search' }
  if (baseUrl.includes('moonshot.cn') || baseUrl.includes('moonshot.ai'))
    return {
      kind: 'none',
      hint: 'Kimi $web_search 协议与流式客户端不兼容 — 换 Gemini / GLM',
    }
  return { kind: 'none', hint: '当前 backend 不支持联网搜索 — 换 Gemini / GLM' }
}

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

type TabId = 'ai' | 'persona' | 'live2d' | 'voice' | 'mail' | 'window' | 'proactive' | 'about'
const TABS: { id: TabId; label: string }[] = [
  { id: 'ai', label: 'AI' },
  { id: 'persona', label: '人物' },
  { id: 'live2d', label: 'Live2D' },
  { id: 'voice', label: '语音' },
  { id: 'proactive', label: '主动' },
  { id: 'mail', label: '邮箱' },
  { id: 'window', label: '窗口' },
  { id: 'about', label: '关于' },
]

const REPO_URL = 'https://github.com/lshhhhhhh/OpenMeido'
const LICENSE_URL = 'https://www.gnu.org/licenses/gpl-3.0.html'

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
  // Model picker hides by default — OpenMeido auto-picks the recommended
  // model when the user clicks a backend preset chip. Power users (custom
  // fine-tunes, beta versions, LM Studio local models) open this to switch.
  const [showModelPicker, setShowModelPicker] = useState(false)

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
                  // Switching providers needs care:
                  //   - model: a gemini id has no meaning at the OpenAI URL,
                  //     so reset to the new provider's first suggested model
                  //     unless the user's current pick happens to fit.
                  //   - apiKey: an OpenAI key is invalid for GLM/DeepSeek/etc.
                  //     Leaving it set would block the main-process .env
                  //     fallback. But we DON'T want to lose it forever — the
                  //     user might switch back. Solution: stash the current
                  //     key under the OLD baseUrl in apiKeys{}, and pull the
                  //     NEW baseUrl's saved key (or empty) into the live field.
                  const newSuggestions = suggestedModels(p.url)
                  const stillValid = newSuggestions.includes(draft.backend.model)
                  // Pick the perf-tier model as the new default (our
                  // recommended choice for regular chat). Falls back to
                  // the first suggestion if no perf tier is mapped.
                  const newDefault =
                    performanceModel(p.url) ??
                    newSuggestions[0] ??
                    draft.backend.model
                  const updatedMap = { ...draft.backend.apiKeys }
                  if (draft.backend.apiKey) {
                    updatedMap[draft.backend.baseUrl] = draft.backend.apiKey
                  }
                  setDraft({
                    ...draft,
                    backend: {
                      ...draft.backend,
                      baseUrl: p.url,
                      model: stillValid ? draft.backend.model : newDefault,
                      apiKey: updatedMap[p.url] ?? '',
                      apiKeys: updatedMap,
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
            onChange={(e) => {
              // Mirror into the per-baseUrl map so switching providers and
              // back doesn't drop this key. Saved on every keystroke; the
              // outer Save propagates the whole config to disk.
              const next = e.target.value
              const map = { ...draft.backend.apiKeys, [draft.backend.baseUrl]: next }
              setDraft({
                ...draft,
                backend: { ...draft.backend, apiKey: next, apiKeys: map },
              })
            }}
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

          {/* ===== 能力概览 — per-capability model breakdown =====
              Shows: 文字 / 多模态 / 联网搜索 → either the model that handles
              it, or "✗ 不支持" with a hint pointing the user at a backend
              that does. The point: when someone picks "DeepSeek" they should
              immediately see "no images, no search" rather than discovering
              it the hard way mid-conversation. */}
          {(() => {
            const text = textCapability(draft.backend.baseUrl, draft.backend.model)
            const vision = visionCapability(draft.backend.baseUrl, draft.backend.model)
            const search = searchCapability(draft.backend.baseUrl)
            const rows: { icon: string; label: string; cap: Capability }[] = [
              { icon: '📝', label: '文字对话', cap: text },
              { icon: '🖼️', label: '看图 / 截屏', cap: vision },
              { icon: '🌐', label: '联网搜索', cap: search },
            ]
            return (
              <div
                style={{
                  marginTop: 8,
                  marginBottom: 4,
                  padding: '8px 10px',
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: 6,
                  fontSize: 12,
                }}
              >
                <div style={{ color: '#999', fontSize: 11, marginBottom: 6 }}>
                  能力概览
                </div>
                {rows.map((r) => (
                  <div
                    key={r.label}
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: 8,
                      padding: '3px 0',
                    }}
                  >
                    <span style={{ width: 16, flexShrink: 0 }}>{r.icon}</span>
                    <span style={{ width: 80, flexShrink: 0, color: '#bbb' }}>
                      {r.label}
                    </span>
                    {r.cap.kind === 'have' ? (
                      <code style={{ color: '#8ec98e' }}>{r.cap.model}</code>
                    ) : r.cap.kind === 'depends' ? (
                      <span style={{ color: '#d9c97a' }}>{r.cap.hint}</span>
                    ) : (
                      <span style={{ color: '#d98a8a' }}>✗ {r.cap.hint}</span>
                    )}
                  </div>
                ))}
              </div>
            )
          })()}

          {/* Model picker — collapsed by default. The recommended model is
              auto-picked when the user clicks a backend preset (above), so
              this section is for power users (fine-tunes, beta versions,
              local LM Studio names). Header shows the current model + a
              "换一个" link that toggles the picker chips below. */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginTop: 8,
              marginBottom: showModelPicker ? 6 : 0,
            }}
          >
            <div style={{ fontSize: 12, color: '#bbb' }}>
              当前模型：<code style={{ color: '#ddd' }}>{draft.backend.model}</code>
            </div>
            <button
              onClick={() => setShowModelPicker((v) => !v)}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#7ab8ff',
                cursor: 'pointer',
                fontSize: 12,
                padding: 0,
              }}
            >
              {showModelPicker ? '收起 ▴' : '换一个 ▾'}
            </button>
          </div>
          {showModelPicker && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
              {suggestedModels(draft.backend.baseUrl).map((m) => (
                <button
                  key={m}
                  style={chipStyle(draft.backend.model === m)}
                  onClick={() =>
                    setDraft({ ...draft, backend: { ...draft.backend, model: m } })
                  }
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
          )}

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

          {/* Search-grounding toggle. Support state is already surfaced by
              the 能力概览 row above — so this is just the on/off, disabled
              when the active backend can't do search at all. */}
          {(() => {
            const supported = searchCapability(draft.backend.baseUrl).kind === 'have'
            return (
              <div style={{ marginTop: 12 }}>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 13,
                    opacity: supported ? 1 : 0.5,
                    cursor: supported ? 'pointer' : 'not-allowed',
                  }}
                >
                  <input
                    type="checkbox"
                    disabled={!supported}
                    checked={supported && draft.backend.searchEnabled}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        backend: { ...draft.backend, searchEnabled: e.target.checked },
                      })
                    }
                  />
                  允许 AI 联网搜索
                </label>
                {supported && (
                  <div style={{ fontSize: 11, color: '#999', marginTop: 4 }}>
                    开启后模型自动决定何时搜索，回答会标注引用来源。
                  </div>
                )}
              </div>
            )
          })()}
        </Section>
        )}

        {/* ---- Persona ---- */}
        {activeTab === 'persona' && (
        <Section title="人物">
          <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>
            每个人物有独立的记忆和好感度。切换 = 见不同的人。
          </div>
          <Label>选择人物</Label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
            {/* Built-in chips */}
            <PersonaChip
              label="女仆"
              personaId="maid"
              active={draft.persona.preset === 'maid'}
              onClick={() => setDraft({ ...draft, persona: { ...draft.persona, preset: 'maid' } })}
            />
            <PersonaChip
              label="妹妹"
              personaId="imouto"
              active={draft.persona.preset === 'imouto'}
              onClick={() => setDraft({ ...draft, persona: { ...draft.persona, preset: 'imouto' } })}
            />
            <PersonaChip
              label="大小姐"
              personaId="ojou"
              active={draft.persona.preset === 'ojou'}
              onClick={() => setDraft({ ...draft, persona: { ...draft.persona, preset: 'ojou' } })}
            />
            {/* User-saved customs */}
            {draft.persona.customs.map((c) => (
              <PersonaChip
                key={c.id}
                label={c.name || '(未命名)'}
                personaId={c.id}
                active={draft.persona.preset === c.id}
                onClick={() => setDraft({ ...draft, persona: { ...draft.persona, preset: c.id } })}
              />
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

          {/* Per-persona stats: affinity bar + episode count + actions.
              Always rendered (built-in OR custom) since these stats are
              about the relationship, not the persona definition. */}
          <PersonaStatsPanel
            personaId={draft.persona.preset}
            draft={draft}
            setDraft={setDraft}
          />

          {/* Detail panel for the currently-selected persona. */}
          {draft.persona.preset in personaPresets ? (
            // Built-in personas are READ-ONLY — the prompt is the result
            // of careful tuning against the tier system, exposing it for
            // edit invites users to add warmth keywords (温柔 / 忠诚)
            // back in and undo the tier-driven escalation. Custom
            // personas remain fully editable below.
            <div style={{ fontSize: 12, color: '#bbb', lineHeight: 1.6 }}>
              {(() => {
                const archetypeDescription: Record<string, string> = {
                  maid: '能干、专业、注重服务。态度（温柔、撒娇、"主人"称呼）随亲密度逐步解锁。',
                  imouto: '年纪比你小、记性好、有自己的个性。态度（毒舌、撒娇、"哥"称呼）随亲密度逐步解锁。',
                  ojou: '青梅竹马的傲娇大小姐，家世显赫。态度（刀子嘴、"本小姐"、嘴硬心软）随亲密度逐步解锁。',
                }
                return (
                  <>
                    <div style={{ marginBottom: 6 }}>
                      <b style={{ color: '#ddd' }}>
                        {
                          personaPresets[draft.persona.preset as keyof typeof personaPresets]
                            .name
                        }
                      </b>
                      ：
                      {archetypeDescription[draft.persona.preset] ?? ''}
                    </div>
                    <div style={{ fontSize: 11, color: '#888' }}>
                      内置人设的 prompt 不可编辑——它跟好感度等级系统是配套调试的。
                      想自定义？点上面 "+ 新建"。
                    </div>
                  </>
                )
              })()}
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
                  <div
                    style={{
                      fontSize: 11,
                      color: '#999',
                      marginBottom: 8,
                      padding: '6px 8px',
                      background: 'rgba(255,255,255,0.04)',
                      borderRadius: 4,
                      border: '1px solid rgba(255,255,255,0.08)',
                    }}
                  >
                    💡 自定义人设的好感度系统正常工作（分数会涨/降、tier
                    切换、记忆隔离都生效），但内置三个人设那种按等级解锁的
                    具体特征列表（生疏 → 熟络时新出现什么动作）目前只有内置
                    才有；自定义会用通用文案。如果想要细粒度的等级化态度，
                    在 system prompt 里自己描述"等级 X 时该怎么表现"。
                  </div>

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

        {/* Memory infrastructure section — folded into 人物 tab per the
            "人设和记忆合一" decision. Embedding model status / download,
            reflection cadence, and any other system-level memory settings
            live inside MemoryTab. Shown ONLY when the 人物 tab is open. */}
        {activeTab === 'persona' && (
          <Section title="记忆系统（高级）">
            <MemoryTab personaId={draft.persona.preset} />
          </Section>
        )}

        {activeTab === 'persona' && (
          <Section title="预制台词">
            <PresetLinesPanel />
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

        {/* ---- Voice (TTS + STT) ---- */}
        {activeTab === 'voice' && (
          <VoiceTab
            draft={draft.tts}
            onChange={(next) => setDraft({ ...draft, tts: next })}
            stt={draft.stt}
            onChangeStt={(next) => setDraft({ ...draft, stt: next })}
          />
        )}

        {/* ---- Proactive ---- */}
        {activeTab === 'proactive' && (
          <ProactiveTab
            draft={draft.proactive}
            onChange={(next) => setDraft({ ...draft, proactive: next })}
          />
        )}

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
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <input
                  type="checkbox"
                  checked={draft.window.startAtLogin}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      window: { ...draft.window, startAtLogin: e.target.checked },
                    })
                  }
                />
                开机自启（登录系统后自动打开 OpenMeido）
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <input
                  type="checkbox"
                  checked={draft.window.clickThroughTransparent}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      window: {
                        ...draft.window,
                        clickThroughTransparent: e.target.checked,
                      },
                    })
                  }
                />
                透明区域穿透鼠标（可点到桌面 / 后面的窗口）
              </label>
              <div style={{ fontSize: 11, color: '#888', marginLeft: 22, marginBottom: 6 }}>
                只在女仆形象之外的透明区域生效；女仆 / 聊天 / 侧栏照常接收点击。
                偶发卡住的话，关掉再开。
              </div>
              <div style={{ fontSize: 11, color: '#888', marginLeft: 22 }}>
                只在安装版生效。如果想撤销，也可以在 Windows
                任务管理器 → 启动 里禁用。
              </div>
            </Section>

            <Section title="全局快捷键">
              <Label>召唤 / 隐藏 OpenMeido</Label>
              <input
                type="text"
                placeholder="例如 CommandOrControl+Alt+M（留空 = 禁用）"
                value={draft.window.summonHotkey}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    window: { ...draft.window, summonHotkey: e.target.value },
                  })
                }
                style={inputStyle}
              />
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
                {['CommandOrControl+Alt+M', 'CommandOrControl+Shift+M', 'F8'].map(
                  (combo) => (
                    <button
                      key={combo}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          window: { ...draft.window, summonHotkey: combo },
                        })
                      }
                      style={{
                        ...chipStyle(draft.window.summonHotkey === combo),
                        fontSize: 11,
                      }}
                    >
                      {combo}
                    </button>
                  ),
                )}
              </div>
              <HotkeyStatus savedAccelerator={initial.window.summonHotkey} />
              <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
                Electron 加速器格式：修饰键（CommandOrControl / Alt / Shift / Super）+ 字母 /
                数字 / F1-F24 / Space / Enter / 方向键，用 + 连接。保存后立即生效；
                如果显示"已被占用"换一个组合。窗口被快捷键隐藏后，再按一次就拉回来。
                <br />
                ⚠️ 避开 <b>Alt+Shift</b>（Windows 输入法切换）、<b>Ctrl+Space</b>
                （中文输入法开关）、<b>Win+...</b>（系统保留），这些会被系统先拦截。
              </div>
            </Section>

            <Section title="字体大小">
              <div style={{ fontSize: 12, color: '#bbb', marginBottom: 8 }}>
                整窗缩放，会影响所有文字 + 按钮。保存后立即生效。
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {[
                  { label: '小', value: 0.9 },
                  { label: '标准', value: 1.0 },
                  { label: '大', value: 1.15 },
                  { label: '特大', value: 1.3 },
                  { label: '超大', value: 1.5 },
                ].map(({ label, value }) => {
                  const active = Math.abs(draft.ui.fontScale - value) < 0.01
                  return (
                    <button
                      key={value}
                      onClick={() =>
                        setDraft({ ...draft, ui: { ...draft.ui, fontScale: value } })
                      }
                      style={{
                        ...btnStyle(active ? 'primary' : 'secondary'),
                        minWidth: 60,
                      }}
                    >
                      {label}
                      <span style={{ fontSize: 10, opacity: 0.7, marginLeft: 4 }}>
                        {Math.round(value * 100)}%
                      </span>
                    </button>
                  )
                })}
              </div>
            </Section>

            <Section title="字体">
              <div style={{ fontSize: 12, color: '#bbb', marginBottom: 8, lineHeight: 1.5 }}>
                3 个内置开源字体，跟系统字体比有「二次元 / 手书」感。每个字体下面预览那行文字看效果，再点按钮切换。
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {([
                  {
                    id: 'system',
                    label: '系统字体',
                    family: 'system-ui, sans-serif',
                    hint: '默认 · 跟 OS 一致',
                  },
                  {
                    id: 'xiaolai',
                    label: '小赖字体',
                    family: '"Xiaolai", system-ui, sans-serif',
                    hint: '濑户字体衍生 · 日系手书 · 最 二次元',
                  },
                  {
                    id: 'lxgw-wenkai',
                    label: 'LXGW 文楷',
                    family: '"LXGW WenKai Lite", system-ui, sans-serif',
                    hint: '手书楷体 · 柔和文气',
                  },
                  {
                    id: 'smiley-sans',
                    label: '得意黑',
                    family: '"Smiley Sans", system-ui, sans-serif',
                    hint: '现代圆角 + 微斜 · 活泼',
                  },
                ] as const).map((f) => {
                  const active = draft.ui.fontFamily === f.id
                  return (
                    <button
                      key={f.id}
                      onClick={() =>
                        setDraft({ ...draft, ui: { ...draft.ui, fontFamily: f.id } })
                      }
                      style={{
                        ...btnStyle(active ? 'primary' : 'secondary'),
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'flex-start',
                        textAlign: 'left',
                        padding: '8px 12px',
                        gap: 4,
                      }}
                    >
                      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', width: '100%' }}>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>{f.label}</span>
                        <span style={{ fontSize: 10, opacity: 0.7 }}>{f.hint}</span>
                      </div>
                      <div
                        style={{
                          fontFamily: f.family,
                          fontSize: 14,
                          opacity: 0.95,
                        }}
                      >
                        主人，今天也辛苦了。我泡杯茶给您吧？
                      </div>
                    </button>
                  )
                })}
              </div>
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

        {activeTab === 'about' && (
          <>
            <Section title="关于 OpenMeido">
              <div style={{ fontSize: 13, lineHeight: 1.7, color: '#ddd' }}>
                <div style={{ marginBottom: 12 }}>
                  桌面 AI 伴侣 — Live2D 形象 + 多后端 LLM + 记忆 / 好感度系统。
                  为不写代码的人也能用 AI 而做。
                </div>

                <div style={{ marginBottom: 12 }}>
                  <Label>仓库</Label>
                  <a
                    href={REPO_URL}
                    onClick={(e) => {
                      e.preventDefault()
                      void window.open(REPO_URL, '_blank', 'noopener,noreferrer')
                    }}
                    style={{ color: '#7ab8ff', textDecoration: 'underline' }}
                  >
                    {REPO_URL}
                  </a>
                </div>

                <div style={{ marginBottom: 12 }}>
                  <Label>许可证</Label>
                  <a
                    href={LICENSE_URL}
                    onClick={(e) => {
                      e.preventDefault()
                      void window.open(LICENSE_URL, '_blank', 'noopener,noreferrer')
                    }}
                    style={{ color: '#7ab8ff', textDecoration: 'underline' }}
                  >
                    GNU General Public License v3.0
                  </a>
                  <div style={{ fontSize: 11, color: '#999', marginTop: 4, lineHeight: 1.6 }}>
                    可自由使用、修改、分发，但任何衍生作品也必须以同等条款开源。
                  </div>
                </div>
              </div>
            </Section>

            <Section title="声明">
              <div style={{ fontSize: 12, lineHeight: 1.7, color: '#bbb' }}>
                <div style={{ marginBottom: 8 }}>
                  <b style={{ color: '#8ec98e' }}>本软件完全免费、完全开源。</b>
                </div>
                <ul style={{ paddingLeft: 16, margin: '8px 0' }}>
                  <li style={{ marginBottom: 4 }}>
                    OpenMeido 本体不收取任何费用。如有人向你收费销售，请要求退款并到上方仓库地址反馈。
                  </li>
                  <li style={{ marginBottom: 4 }}>
                    使用 LLM 后端（OpenAI / Gemini / GLM 等）产生的 API 费用由各 backend 厂商收取，与本项目无关。
                  </li>
                  <li style={{ marginBottom: 4 }}>
                    本项目仅集成 Live2D Cubism Web SDK 的运行时调用；不包含、不分发任何 Live2D 模型文件。
                    用户自带的模型版权归各原作者所有。
                  </li>
                  <li style={{ marginBottom: 4 }}>
                    AI 生成的对话、表情、判断**仅供娱乐**，不代表任何事实陈述或建议；
                    不要把 OpenMeido 当成医疗、法律、金融顾问。
                  </li>
                  <li>
                    本软件按 GPL-3.0 第 15、16 条之规定，**不附带任何明示或暗示的担保**——
                    使用过程中的数据丢失、设备损坏、心情起伏等概由用户自负。
                  </li>
                </ul>
              </div>
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
  const MODES: { id: 'mute' | 'auto' | 'chatty'; label: string; hint: string }[] = [
    { id: 'mute', label: '闭嘴', hint: '完全不主动开口' },
    { id: 'auto', label: '自动', hint: '由好感度决定频率（推荐）' },
    { id: 'chatty', label: '多话', hint: '不管好感度都常在' },
  ]
  return (
    <Section title="主动模式">
      <Label>她什么时候主动开口</Label>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        {MODES.map((m) => (
          <button
            key={m.id}
            onClick={() => onChange({ ...draft, mode: m.id })}
            style={{
              ...btnStyle(draft.mode === m.id ? 'primary' : 'subtle'),
              padding: '4px 12px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              lineHeight: 1.2,
            }}
          >
            <span style={{ fontSize: 12 }}>{m.label}</span>
            <span style={{ fontSize: 10, opacity: 0.7 }}>{m.hint}</span>
          </button>
        ))}
      </div>
      <div style={{ fontSize: 11, color: '#888', marginBottom: 12, lineHeight: 1.5 }}>
        节奏（多久来一句、冷却多久）由模式 + 当前好感度自动决定。
        Lv.1-2 几乎不开口；Lv.3 大约 10 分钟一次；Lv.5 更频繁。
      </div>
      {draft.mode !== 'mute' && (
        <>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <input
              type="checkbox"
              checked={draft.includeScreen}
              onChange={(e) => onChange({ ...draft, includeScreen: e.target.checked })}
            />
            <span>让她偶尔瞥一眼屏幕（截图传给 LLM）</span>
          </label>
          {draft.includeScreen && (
            <>
              <div
                style={{
                  fontSize: 11,
                  color: '#fc8',
                  marginBottom: 8,
                  padding: '6px 8px',
                  background: 'rgba(255,200,100,0.08)',
                  border: '1px solid rgba(255,200,100,0.25)',
                  borderRadius: 4,
                }}
              >
                ⚠️ 截屏会发送到云端 LLM。会拍到密码框、私聊、银行界面。
                请确认你信任当前后端的隐私策略。
              </div>
              <ScreenExclusionPicker
                excludedIds={draft.excludedScreenIds}
                onChange={(ids) => onChange({ ...draft, excludedScreenIds: ids })}
              />
            </>
          )}

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
  stt,
  onChangeStt,
}: {
  draft: Config['tts']
  onChange: (next: Config['tts']) => void
  stt: Config['stt']
  onChangeStt: (next: Config['stt']) => void
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
          <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
            {(
              [
                { id: 'edge', label: 'Edge TTS', hint: '免费 · 联网 · 微软' },
                { id: 'sovits', label: 'GPT-SoVITS', hint: '本地 · 零样本克隆' },
                { id: 'minimax', label: 'MiniMax', hint: '海螺 · 云端 · 付费' },
                { id: 'volcengine', label: '火山引擎', hint: '豆包大模型 · 云端' },
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

          {draft.backend === 'minimax' && (
            <MinimaxFields
              draft={draft.minimax}
              onChange={(next) => onChange({ ...draft, minimax: next })}
            />
          )}

          {draft.backend === 'volcengine' && (
            <VolcengineFields
              draft={draft.volcengine}
              onChange={(next) => onChange({ ...draft, volcengine: next })}
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

      {/* ===== Speech-to-text (STT) ===== */}
      <div style={{ marginTop: 20, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#ddd', marginBottom: 8 }}>
          🎤 语音输入
        </div>
        <SttPanel stt={stt} onChangeStt={onChangeStt} />
      </div>
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

/**
 * MiniMax 海螺 T2A v2 credentials + voice picker.
 *
 * The "其它 voice_id" override is intentional — preset voices are mainland
 * canonical names; international users (region='global') often have
 * different voice ids issued by their account.
 */
function MinimaxFields({
  draft,
  onChange,
}: {
  draft: Config['tts']['minimax']
  onChange: (next: Config['tts']['minimax']) => void
}) {
  const isPreset = MINIMAX_PRESET_VOICES.some((v) => v.id === draft.voiceId)
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
        到 MiniMax 控制台拿 API Key + GroupId（账户信息页）。
        国内账号选 minimax.chat / minimaxi.com，海外账号选 minimax.io。
      </div>

      <Label>区域</Label>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        {(
          [
            { id: 'cn', label: '国内 (api.minimaxi.com)' },
            { id: 'global', label: '海外 (api.minimax.io)' },
          ] as const
        ).map((r) => (
          <button
            key={r.id}
            onClick={() => onChange({ ...draft, region: r.id })}
            style={{
              ...btnStyle(draft.region === r.id ? 'primary' : 'subtle'),
              padding: '2px 10px',
              fontSize: 11,
            }}
          >
            {r.label}
          </button>
        ))}
      </div>

      <Label>API Key</Label>
      <input
        type="password"
        value={draft.apiKey}
        onChange={(e) => onChange({ ...draft, apiKey: e.target.value })}
        placeholder="eyJ... (Bearer token)"
        style={{ ...inputStyle, marginBottom: 8 }}
      />

      <Label>GroupId</Label>
      <input
        type="text"
        value={draft.groupId}
        onChange={(e) => onChange({ ...draft, groupId: e.target.value })}
        placeholder="账户信息页里的 group id"
        style={{ ...inputStyle, marginBottom: 8 }}
      />

      <Label>模型</Label>
      <select
        value={draft.model}
        onChange={(e) => onChange({ ...draft, model: e.target.value })}
        style={{ ...inputStyle, marginBottom: 8 }}
      >
        {MINIMAX_MODELS.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
            {m.hint ? ` · ${m.hint}` : ''}
          </option>
        ))}
      </select>

      <Label>音色</Label>
      <select
        value={isPreset ? draft.voiceId : '__custom__'}
        onChange={(e) => {
          const v = e.target.value
          if (v === '__custom__') return // user typing custom; keep current
          onChange({ ...draft, voiceId: v })
        }}
        style={{ ...inputStyle, marginBottom: 6 }}
      >
        {MINIMAX_PRESET_VOICES.map((v) => (
          <option key={v.id} value={v.id}>
            {v.label} · {v.id}
            {v.hint ? ` · ${v.hint}` : ''}
          </option>
        ))}
        <option value="__custom__">— 自定义 voice_id（克隆 / 海外特有）—</option>
      </select>
      <input
        type="text"
        value={draft.voiceId}
        onChange={(e) => onChange({ ...draft, voiceId: e.target.value })}
        placeholder="voice_id（例：female-shaonv）"
        style={{ ...inputStyle, marginBottom: 8 }}
      />

      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <div style={{ flex: 1 }}>
          <Label>语速 ({draft.speed.toFixed(2)})</Label>
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.05}
            value={draft.speed}
            onChange={(e) => onChange({ ...draft, speed: Number(e.target.value) })}
            style={{ width: '100%' }}
          />
        </div>
        <div style={{ flex: 1 }}>
          <Label>音量 ({draft.volume.toFixed(1)})</Label>
          <input
            type="range"
            min={0}
            max={10}
            step={0.1}
            value={draft.volume}
            onChange={(e) => onChange({ ...draft, volume: Number(e.target.value) })}
            style={{ width: '100%' }}
          />
        </div>
        <div style={{ flex: 1 }}>
          <Label>音调 ({draft.pitch})</Label>
          <input
            type="range"
            min={-12}
            max={12}
            step={1}
            value={draft.pitch}
            onChange={(e) => onChange({ ...draft, pitch: Number(e.target.value) })}
            style={{ width: '100%' }}
          />
        </div>
      </div>

      <details style={{ marginBottom: 12 }}>
        <summary style={{ fontSize: 11, color: '#666', cursor: 'pointer' }}>
          高级：自定义 baseUrl（覆盖区域默认）
        </summary>
        <input
          type="text"
          value={draft.baseUrl}
          onChange={(e) => onChange({ ...draft, baseUrl: e.target.value })}
          placeholder="留空 = 用上面选的区域默认；填了就用这个"
          style={{ ...inputStyle, marginTop: 6 }}
        />
      </details>
    </>
  )
}

/**
 * 火山引擎 大模型语音合成（豆包）credentials + voice picker.
 *
 * Three fields required (appid + accessToken + cluster) instead of one,
 * because 火山 binds each app to a specific TTS subscription. The literal
 * `Bearer;<token>` auth quirk is handled inside the adapter — UI just
 * collects the raw token.
 */
function VolcengineFields({
  draft,
  onChange,
}: {
  draft: Config['tts']['volcengine']
  onChange: (next: Config['tts']['volcengine']) => void
}) {
  const isPreset = VOLCENGINE_PRESET_VOICES.some((v) => v.id === draft.voiceType)
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
        到火山控制台 → 语音技术 → 语音合成（大模型） → 应用管理拿 appid + access token。
        cluster 默认 volcano_tts，开通了「声音复刻」才需要切到 volcano_icl。
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <div style={{ flex: 1 }}>
          <Label>App ID</Label>
          <input
            type="text"
            value={draft.appid}
            onChange={(e) => onChange({ ...draft, appid: e.target.value })}
            placeholder="火山控制台里的 appid"
            style={inputStyle}
          />
        </div>
        <div style={{ flex: 1 }}>
          <Label>Cluster</Label>
          <select
            value={draft.cluster}
            onChange={(e) => onChange({ ...draft, cluster: e.target.value })}
            style={inputStyle}
          >
            {VOLCENGINE_CLUSTERS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
                {c.hint ? ` · ${c.hint}` : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      <Label>Access Token</Label>
      <input
        type="password"
        value={draft.accessToken}
        onChange={(e) => onChange({ ...draft, accessToken: e.target.value })}
        placeholder="header 跟 body 都用这个 token"
        style={{ ...inputStyle, marginBottom: 8 }}
      />

      <Label>音色</Label>
      <select
        value={isPreset ? draft.voiceType : '__custom__'}
        onChange={(e) => {
          const v = e.target.value
          if (v === '__custom__') return
          onChange({ ...draft, voiceType: v })
        }}
        style={{ ...inputStyle, marginBottom: 6 }}
      >
        {VOLCENGINE_PRESET_VOICES.map((v) => (
          <option key={v.id} value={v.id}>
            {v.label} · {v.id}
            {v.hint ? ` · ${v.hint}` : ''}
          </option>
        ))}
        <option value="__custom__">— 自定义 voice_type（复刻 / 私有音色）—</option>
      </select>
      <input
        type="text"
        value={draft.voiceType}
        onChange={(e) => onChange({ ...draft, voiceType: e.target.value })}
        placeholder="voice_type（例：BV700_streaming）"
        style={{ ...inputStyle, marginBottom: 8 }}
      />

      <Label>语速 ({draft.speedRatio.toFixed(2)})</Label>
      <input
        type="range"
        min={0.5}
        max={2}
        step={0.05}
        value={draft.speedRatio}
        onChange={(e) => onChange({ ...draft, speedRatio: Number(e.target.value) })}
        style={{ width: '100%', marginBottom: 8 }}
      />

      <details style={{ marginBottom: 12 }}>
        <summary style={{ fontSize: 11, color: '#666', cursor: 'pointer' }}>
          高级：自定义 baseUrl / body token
        </summary>
        <Label>baseUrl</Label>
        <input
          type="text"
          value={draft.baseUrl}
          onChange={(e) => onChange({ ...draft, baseUrl: e.target.value })}
          placeholder="留空 = openspeech.bytedance.com"
          style={{ ...inputStyle, marginBottom: 6 }}
        />
        <Label>body token（少数账号 header / body 不同；常规留空）</Label>
        <input
          type="password"
          value={draft.bodyToken}
          onChange={(e) => onChange({ ...draft, bodyToken: e.target.value })}
          placeholder="留空 = 复用 access token"
          style={inputStyle}
        />
      </details>
    </>
  )
}

/**
 * Embedding-model panel for the 记忆 tab.
 *
 * Two states the user actually cares about:
 *   1. Model present (bundled or already downloaded) → long-term memory works
 *      via local semantic search (bge-small-zh-v1.5).
 *   2. Naive mode (no model) → recent-N only, no semantic recall. User can
 *      tap "下载模型" here to fetch it from hf-mirror.com (no GitHub-blocked
 *      hosts) and switch into full mode without restarting.
 */
/**
 * STT panel for the Voice tab. Mirrors EmbedModelPanel — Whisper model
 * (~74-130 MB depending on Whisper's actual file count) is downloaded on
 * first use OR via the button here. Plus an enabled toggle (hide mic
 * button entirely) and a cleanup toggle (LLM post-processes raw Whisper
 * output to fix homophone errors + missing punctuation).
 */
function SttPanel({
  stt,
  onChangeStt,
}: {
  stt: Config['stt']
  onChangeStt: (next: Config['stt']) => void
}): React.ReactElement {
  const [s, setS] = useState<{
    modelPresent: boolean
    inProgress: boolean
    totalBytes: number
    receivedBytes: number
    currentFile: string | null
  } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])

  async function refresh(): Promise<void> {
    setS(await window.api.stt.status())
  }
  /**
   * Enumerate mic devices. Device labels are only populated after the
   * user has granted mic permission at least once — before that we'd
   * get a list of devices with empty labels. We trigger a permission
   * request via getUserMedia (immediately released) so the second
   * enumerateDevices() call has labels we can show.
   */
  async function refreshMics(): Promise<void> {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true })
      probe.getTracks().forEach((t) => t.stop())
    } catch {
      // Permission denied. We can still enumerate, but labels will be
      // generic ("Default", "Communications", etc.).
    }
    const devices = await navigator.mediaDevices.enumerateDevices()
    setMics(devices.filter((d) => d.kind === 'audioinput'))
  }
  useEffect(() => {
    void refresh()
    void refreshMics()
    const offP = window.api.stt.onProgress((p) => {
      setS((prev) => (prev ? { ...prev, ...p } : prev))
    })
    const offC = window.api.stt.onComplete((r) => {
      if (!r.ok) setErr(r.error)
      else setErr(null)
      void refresh()
    })
    return () => {
      offP()
      offC()
    }
  }, [])

  if (!s) return <></>
  const pct =
    s.totalBytes > 0 ? Math.min(100, Math.round((s.receivedBytes / s.totalBytes) * 100)) : 0
  const mb = (n: number): string => (n / 1024 / 1024).toFixed(1)

  return (
    <>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <input
          type="checkbox"
          checked={stt.enabled}
          onChange={(e) => onChangeStt({ ...stt, enabled: e.target.checked })}
        />
        <span>启用语音输入（聊天框旁显示麦克风按钮）</span>
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <input
          type="checkbox"
          checked={stt.cleanup}
          onChange={(e) => onChangeStt({ ...stt, cleanup: e.target.checked })}
          disabled={!stt.enabled}
        />
        <span>LLM 后处理（修正同音字 / 错字 / 标点；增加约 0.5 秒延迟）</span>
      </label>

      {/* Mic device picker. Empty value = OS default (the safest choice
          for most users). Browser only populates device labels AFTER
          the user has granted mic permission once; pressing 刷新 re-
          enumerates if they plugged something in. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 12, color: '#bbb', minWidth: 64 }}>麦克风：</span>
        <select
          value={stt.deviceId}
          onChange={(e) => onChangeStt({ ...stt, deviceId: e.target.value })}
          disabled={!stt.enabled}
          style={{
            flex: 1,
            padding: '3px 6px',
            background: '#2a2d36',
            color: '#eee',
            border: '1px solid #3a3e48',
            borderRadius: 4,
            fontSize: 12,
          }}
        >
          <option value="">系统默认</option>
          {mics.map((m, i) => (
            <option key={m.deviceId || i} value={m.deviceId}>
              {m.label || `输入设备 ${i + 1}`}
            </option>
          ))}
        </select>
        <button
          onClick={() => void refreshMics()}
          disabled={!stt.enabled}
          style={btnStyle('subtle')}
          title="重新枚举（插入新设备后用）"
        >
          刷新
        </button>
      </div>

      <div
        style={{
          marginTop: 8,
          padding: '8px 10px',
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 4,
          fontSize: 12,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: '#ddd', fontWeight: 500 }}>
            Whisper 模型 ·{' '}
            {s.modelPresent ? (
              <span style={{ color: '#8c8' }}>已就绪</span>
            ) : (
              <span style={{ color: '#fc8' }}>未下载</span>
            )}
          </span>
          {!s.inProgress && !s.modelPresent && (
            <button
              onClick={() => {
                setErr(null)
                void window.api.stt.download()
              }}
              style={btnStyle('secondary')}
            >
              下载语音模型 (~120MB)
            </button>
          )}
        </div>
        {s.inProgress && (
          <div style={{ marginTop: 6 }}>
            <div
              style={{
                width: '100%',
                height: 6,
                background: 'rgba(255,255,255,0.08)',
                borderRadius: 3,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${pct}%`,
                  height: '100%',
                  background: '#5b8def',
                  transition: 'width 100ms linear',
                }}
              />
            </div>
            <div style={{ marginTop: 4, color: '#aaa', fontSize: 11 }}>
              {pct}% · {mb(s.receivedBytes)} / {mb(s.totalBytes)} MB
              {s.currentFile && ` · ${s.currentFile}`}
            </div>
          </div>
        )}
        {!s.inProgress && !s.modelPresent && (
          <div style={{ marginTop: 6, color: '#999', fontSize: 11, lineHeight: 1.5 }}>
            点麦克风录音前需要下载 Whisper-base 模型。模型从{' '}
            <span style={{ color: '#aac' }}>hf-mirror.com</span>{' '}
            获取（国内可直连），完成后即时生效。
          </div>
        )}
        {err && (
          <div style={{ marginTop: 6, color: '#f88', fontSize: 11 }}>
            下载失败：{err}
          </div>
        )}
      </div>
    </>
  )
}

/**
 * Preset-lines editor panel. Surfaces a one-click "open lines.json"
 * button so users can edit her mute / unmute feedback lines (and
 * future preset content) in their OS default editor.
 *
 * File lives at %APPDATA%/openmeido/lines.json. Edits take effect on
 * next app restart — we don't watch the file (notepad's save would
 * fire mid-edit on every keystroke save), and the lines are loaded
 * once at boot for predictability.
 */
function PresetLinesPanel(): React.ReactElement {
  const [path, setPath] = useState<string>('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void window.api.lines?.path().then((p) => setPath(p))
  }, [])
  async function openFile(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      const r = await window.api.lines?.openFile()
      if (r && !r.ok) alert(`打不开文件：${r.error ?? '未知错误'}`)
    } finally {
      setBusy(false)
    }
  }
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
        她在闭嘴 / 解除闭嘴 时说的话来自一个 JSON 文件，你可以编辑她的台词风格。
        当前覆盖：mute / unmute 反馈（按人设 × 好感度档分类）。
        <br />
        <strong>编辑后重启 app 生效。</strong>
        删掉文件就是恢复默认。
      </div>
      <button onClick={openFile} disabled={busy} style={btnStyle('secondary')}>
        {busy ? '打开中…' : '打开 lines.json'}
      </button>
      {path && (
        <div style={{ fontSize: 10, color: '#888', marginTop: 6, wordBreak: 'break-all' }}>
          路径：{path}
        </div>
      )}
    </>
  )
}

function EmbedModelPanel(): React.ReactElement {
  const [s, setS] = useState<{
    naive: boolean
    modelPresent: boolean
    inProgress: boolean
    totalBytes: number
    receivedBytes: number
    currentFile: string | null
  } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function refresh(): Promise<void> {
    setS(await window.api.embed.status())
  }

  useEffect(() => {
    void refresh()
    const offP = window.api.embed.onProgress((p) => {
      setS((prev) => (prev ? { ...prev, ...p } : prev))
    })
    const offC = window.api.embed.onComplete((r) => {
      if (!r.ok) setErr(r.error)
      else setErr(null)
      void refresh()
    })
    return () => {
      offP()
      offC()
    }
  }, [])

  if (!s) return <></>

  const pct =
    s.totalBytes > 0 ? Math.min(100, Math.round((s.receivedBytes / s.totalBytes) * 100)) : 0
  const mb = (n: number): string => (n / 1024 / 1024).toFixed(1)

  // Three rendering modes: downloading, naive (offer download), ready.
  return (
    <div
      style={{
        marginBottom: 12,
        padding: '8px 10px',
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 4,
        fontSize: 12,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ color: '#ddd', fontWeight: 500 }}>
          长期记忆模型 ·{' '}
          {s.modelPresent ? (
            <span style={{ color: '#8c8' }}>已就绪</span>
          ) : (
            <span style={{ color: '#fc8' }}>未安装（简易模式）</span>
          )}
        </span>
        {!s.inProgress && !s.modelPresent && (
          <button
            onClick={() => {
              setErr(null)
              void window.api.embed.download()
            }}
            style={btnStyle('secondary')}
          >
            下载模型 (~95MB)
          </button>
        )}
      </div>

      {s.inProgress && (
        <div style={{ marginTop: 6 }}>
          <div
            style={{
              width: '100%',
              height: 6,
              background: 'rgba(255,255,255,0.08)',
              borderRadius: 3,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${pct}%`,
                height: '100%',
                background: '#5b8def',
                transition: 'width 100ms linear',
              }}
            />
          </div>
          <div style={{ marginTop: 4, color: '#aaa', fontSize: 11 }}>
            {pct}% · {mb(s.receivedBytes)} / {mb(s.totalBytes)} MB
            {s.currentFile && ` · ${s.currentFile}`}
          </div>
        </div>
      )}

      {!s.inProgress && !s.modelPresent && (
        <div style={{ marginTop: 6, color: '#999', fontSize: 11, lineHeight: 1.5 }}>
          当前是简易记忆模式，妹妹只能记得最近几条对话，无法做语义检索。
          下载模型后会自动切换到完整模式，无需重启。模型从{' '}
          <span style={{ color: '#aac' }}>hf-mirror.com</span> 获取，中国大陆可直接连接。
        </div>
      )}

      {err && (
        <div style={{ marginTop: 6, color: '#f88', fontSize: 11 }}>
          下载失败：{err}
        </div>
      )}
    </div>
  )
}

function MemoryTab({ personaId }: { personaId: string }) {
  // Simplified per "一个人物，一个记忆" decision (2026-05-21): no session
  // picker, no manual session creation, no cross-persona "clear all". The
  // per-persona panel above already exposes "清空这个人物" — which IS the
  // user-facing "wipe her memory" action. Here we only show:
  //   - embedding-model download/status (system-level infra)
  //   - aggregate count for the focused persona
  //   - a read-only recent-episodes browser for that persona
  //   - the L3 facts inspector (her distilled knowledge about you)
  //
  // The `personaId` prop is the DRAFT-level focus, NOT the persisted
  // active persona — so clicking a different chip above immediately
  // refreshes this view, without requiring the user to click 保存.
  const [memReady, setMemReady] = useState<{ ready: boolean; initError?: string }>({
    ready: false,
  })
  const [count, setCount] = useState<number>(0)
  const [episodes, setEpisodes] = useState<Episode[]>([])

  async function refresh(): Promise<void> {
    const s = await window.api.memory.status()
    setMemReady(s.ready ? { ready: true } : { ready: false, initError: s.initError })
    if (!s.ready) return
    const all = await window.api.affinity.listAll()
    const me = all.find((a) => a.personaId === personaId)
    setCount(me?.episodeCount ?? 0)
    // Per-persona recent — bypass the active-persona-scoped listRecent
    // because the focused chip may not match the saved active persona.
    setEpisodes(await window.api.memory.listRecentFor(personaId, 200))
  }

  useEffect(() => {
    void refresh()
    // Also listen for persona-switch broadcasts so a save-driven persona
    // change updates us even when the Settings dialog stays open.
    const offSwitch = window.api.affinity.onPersonaSwitched(() => void refresh())
    return () => {
      offSwitch()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personaId])

  if (!memReady.ready) {
    return (
      <div style={{ fontSize: 12, lineHeight: 1.5 }}>
        <div style={{ color: '#f88', marginBottom: 6 }}>记忆模块初始化失败 / 未启用。</div>
        {memReady.initError && (
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
            {memReady.initError}
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
      <EmbedModelPanel />
      <div style={{ fontSize: 12, color: '#ccc', marginBottom: 8 }}>
        这个人物对你有 <b style={{ color: '#fff' }}>{count}</b> 段记忆。
      </div>
      <div style={{ fontSize: 11, color: '#999', marginBottom: 12 }}>
        每个人物拥有独立的记忆池——切换人物时记忆自动跟着切换。要清空当前人物的记忆，到上面"清空这个人物"。
      </div>

      <Label>最近的对话</Label>
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
          <div style={{ color: '#777', padding: 8 }}>还没有任何对话记录。聊几句就有了。</div>
        ) : (
          // Newest at top — scrolling a long list to find recent activity
          // by hand was wrong UX. Slice before reverse so we don't
          // mutate the state array (would break React's diff).
          episodes.slice().reverse().map((e) => (
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
              <div
                style={{
                  color: '#ddd',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {e.text.length > 200 ? e.text.slice(0, 200) + '…' : e.text}
              </div>
            </div>
          ))
        )}
      </div>

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
      <div
        style={{
          fontSize: 10,
          color: '#777',
          marginBottom: 8,
          lineHeight: 1.5,
          fontStyle: 'italic',
        }}
      >
        只显示日常 / 关系记忆。工作相关的内容（项目、邮件、ticket）走单独的内部
        通道，不在此处展示，避免和稳定的个人事实混淆。
      </div>
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
              <button
                onClick={async () => {
                  // No confirm() — the action is small-scoped (one fact) and
                  // reversible-ish (you can just chat about it again and
                  // reflection will re-extract). Confirm dialogs on every
                  // 🗑 in a long list are friction.
                  await window.api.memory.deleteFact(f.id)
                  await refresh()
                }}
                title="删除这条记忆"
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#888',
                  cursor: 'pointer',
                  fontSize: 11,
                  padding: '0 2px',
                  lineHeight: 1,
                }}
              >
                🗑
              </button>
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

/**
 * Picker for which screens the AI is ALLOWED to capture. List = all
 * attached displays with preview thumbnails. Checkbox per screen
 * controls inclusion. The config field stores EXCLUDED ids (default
 * empty = all included) so leaving the picker untouched preserves
 * the "see all displays" default.
 *
 * Refreshes the list on mount + whenever the user clicks 刷新 (e.g.
 * after plugging/unplugging a monitor).
 */
function ScreenExclusionPicker({
  excludedIds,
  onChange,
}: {
  excludedIds: string[]
  onChange: (ids: string[]) => void
}) {
  const [screens, setScreens] = useState<
    Array<{ id: string; name: string; previewBase64: string }>
  >([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const reload = async (): Promise<void> => {
    setLoading(true)
    setErr(null)
    try {
      // Defensive: listScreens was added in v0.0.28; if the user is
      // running with an older preload bundle that doesn't expose it
      // (common during dev when preload hasn't HMR'd), we want a
      // visible error not silent empty state.
      const fn = window.api.chat.listScreens
      if (typeof fn !== 'function') {
        throw new Error('window.api.chat.listScreens 不存在——preload bundle 老了，重启 app。')
      }
      setScreens(await fn())
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void reload()
  }, [])
  const excludedSet = new Set(excludedIds)
  function toggle(id: string): void {
    const next = new Set(excludedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange([...next])
  }
  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 6,
        }}
      >
        <Label>选择她能看到的屏幕</Label>
        <button
          onClick={() => void reload()}
          disabled={loading}
          style={{
            fontSize: 10,
            padding: '1px 8px',
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: 4,
            color: '#bbb',
            cursor: 'pointer',
          }}
        >
          {loading ? '...' : '刷新'}
        </button>
      </div>
      {err ? (
        <div style={{ fontSize: 11, color: '#f88' }}>{err}</div>
      ) : screens.length === 0 ? (
        <div style={{ fontSize: 11, color: '#888' }}>
          {loading ? '正在检测屏幕…' : '没有检测到屏幕（点上方"刷新"重试）。'}
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
            gap: 6,
          }}
        >
          {screens.map((s) => {
            const included = !excludedSet.has(s.id)
            return (
              <label
                key={s.id}
                style={{
                  display: 'block',
                  cursor: 'pointer',
                  border: included
                    ? '2px solid #5a8edf'
                    : '2px solid rgba(255,255,255,0.1)',
                  borderRadius: 4,
                  padding: 4,
                  background: included
                    ? 'rgba(90,142,223,0.08)'
                    : 'rgba(255,255,255,0.02)',
                  opacity: included ? 1 : 0.5,
                }}
              >
                <div style={{ position: 'relative' }}>
                  <img
                    src={`data:image/png;base64,${s.previewBase64}`}
                    alt={s.name}
                    style={{ width: '100%', display: 'block', borderRadius: 2 }}
                  />
                  <input
                    type="checkbox"
                    checked={included}
                    onChange={() => toggle(s.id)}
                    style={{
                      position: 'absolute',
                      top: 4,
                      right: 4,
                      transform: 'scale(1.2)',
                    }}
                  />
                </div>
                <div
                  style={{
                    fontSize: 10,
                    color: included ? '#ddd' : '#888',
                    marginTop: 2,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {s.name}
                </div>
              </label>
            )
          })}
        </div>
      )}
      <div style={{ fontSize: 10, color: '#888', marginTop: 4 }}>
        勾选 = 允许她看；取消 = 这一块屏幕永远不会被截。设置同时影响"主动瞥屏"
        和 👀 按钮触发的看屏。
      </div>
    </div>
  )
}

/** Match shared/affinity.ts tier breakpoints. Duplicated in renderer to
 *  avoid pulling a Node-typed module into the renderer bundle. */
function tierLabelFor(score: number): string {
  if (score >= 80) return 'Lv.5'
  if (score >= 60) return 'Lv.4'
  if (score >= 40) return 'Lv.3'
  if (score >= 20) return 'Lv.2'
  return 'Lv.1'
}

/**
 * Per-persona stats panel for the 人物 tab. Shows affinity (bar + tier
 * label + last judge reason) plus episode/fact counts and reset actions.
 * Also hosts the per-persona custom-background picker.
 * Re-fetches on persona switch.
 */
function PersonaStatsPanel({
  personaId,
  draft,
  setDraft,
}: {
  personaId: string
  draft: Config
  setDraft: (next: Config) => void
}) {
  const [stats, setStats] = useState<{
    score: number
    lastReason: string | null
    episodeCount: number
  } | null>(null)
  const reload = async (): Promise<void> => {
    const rec = await window.api.affinity.get(personaId)
    if (!rec) return
    const all = await window.api.affinity.listAll()
    const me = all.find((a) => a.personaId === personaId)
    setStats({
      score: rec.score,
      lastReason: rec.lastReason,
      episodeCount: me?.episodeCount ?? 0,
    })
  }
  useEffect(() => {
    void reload()
  }, [personaId])
  if (!stats) {
    return <div style={{ fontSize: 11, color: '#888', marginBottom: 8 }}>...</div>
  }
  const tier = tierLabelFor(stats.score)
  return (
    <div
      style={{
        marginBottom: 8,
        padding: '8px 10px',
        background: 'rgba(255,255,255,0.04)',
        borderRadius: 6,
        fontSize: 11,
        color: '#bbb',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginBottom: 4,
          color: '#ddd',
          fontWeight: 500,
        }}
      >
        <span>❤️ 好感度</span>
        <span>
          {Math.round(stats.score)} / 100 · {tier}
        </span>
      </div>
      <div
        style={{
          height: 5,
          borderRadius: 3,
          background: 'rgba(0,0,0,0.3)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${Math.max(2, stats.score)}%`,
            height: '100%',
            background: 'linear-gradient(90deg, #f6a4b3, #d4768a)',
            transition: 'width 400ms ease',
          }}
        />
      </div>
      {stats.lastReason && (
        <div
          style={{
            marginTop: 4,
            fontSize: 10,
            color: '#888',
            fontStyle: 'italic',
          }}
        >
          最近：{stats.lastReason}
        </div>
      )}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginTop: 6,
        }}
      >
        <span>记忆：{stats.episodeCount} 条 episode</span>
        <button
          onClick={async () => {
            if (
              !(await confirm(
                `清空${personaId}的所有记忆 + 好感度？此操作无法撤销。`,
              ))
            ) {
              return
            }
            await window.api.persona.delete(personaId)
            await reload()
          }}
          style={{
            fontSize: 10,
            padding: '1px 8px',
            background: 'rgba(200, 80, 80, 0.18)',
            border: '1px solid rgba(200, 80, 80, 0.35)',
            borderRadius: 3,
            color: '#f99',
            cursor: 'pointer',
          }}
        >
          清空这个人物
        </button>
      </div>

      {/* ===== Per-persona background image ===== */}
      <div
        style={{
          marginTop: 10,
          paddingTop: 8,
          borderTop: '1px dotted rgba(255,255,255,0.08)',
          fontSize: 11,
          color: '#bbb',
        }}
      >
        <div style={{ marginBottom: 4, color: '#ddd', fontWeight: 500 }}>
          🖼 背景图
        </div>
        <div
          style={{
            display: 'flex',
            gap: 6,
            alignItems: 'center',
            marginBottom: 4,
          }}
        >
          <button
            onClick={async () => {
              const result = await window.api.background.import(personaId)
              if (!result) return
              const oldFile = draft.window.customBackgrounds[personaId]
              setDraft({
                ...draft,
                window: {
                  ...draft.window,
                  customBackgrounds: {
                    ...draft.window.customBackgrounds,
                    [personaId]: result.basename,
                  },
                },
              })
              if (oldFile && oldFile !== result.basename) {
                void window.api.background.delete(oldFile)
              }
            }}
            style={{
              fontSize: 10,
              padding: '2px 8px',
              background: 'rgba(90, 142, 223, 0.22)',
              border: '1px solid #5a8edf',
              borderRadius: 3,
              color: '#cfdcf3',
              cursor: 'pointer',
            }}
          >
            导入图片…
          </button>
          {draft.window.customBackgrounds[personaId] && (
            <>
              <span style={{ fontSize: 10, color: '#9b9' }}>
                已使用自定义
              </span>
              <button
                onClick={async () => {
                  const old = draft.window.customBackgrounds[personaId]
                  const next = { ...draft.window.customBackgrounds }
                  delete next[personaId]
                  setDraft({
                    ...draft,
                    window: { ...draft.window, customBackgrounds: next },
                  })
                  if (old) void window.api.background.delete(old)
                }}
                style={{
                  fontSize: 10,
                  padding: '1px 6px',
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.15)',
                  borderRadius: 3,
                  color: '#bbb',
                  cursor: 'pointer',
                }}
              >
                恢复默认
              </button>
            </>
          )}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginTop: 4,
          }}
        >
          <span style={{ fontSize: 10, color: '#888', minWidth: 36 }}>
            缩放
          </span>
          <input
            type="range"
            min={0.5}
            max={3}
            step={0.05}
            value={draft.window.backgroundZoom}
            onChange={(e) =>
              setDraft({
                ...draft,
                window: {
                  ...draft.window,
                  backgroundZoom: Number(e.target.value),
                },
              })
            }
            style={{ flex: 1 }}
          />
          <span
            style={{
              fontSize: 10,
              color: '#bbb',
              minWidth: 36,
              textAlign: 'right',
            }}
          >
            {Math.round(draft.window.backgroundZoom * 100)}%
          </span>
        </div>
        <div style={{ fontSize: 10, color: '#777', marginTop: 2 }}>
          100% = 默认填满窗口（cover）；&gt;100% = 放大近景；&lt;100% =
          缩小看更多画面。所有人物共享同一个缩放。
        </div>
      </div>
    </div>
  )
}

/**
 * Persona chip with affinity score + tier badge. Polls the per-persona
 * affinity record once on mount so the user can see "女仆 ❤️47 · 熟络"
 * at a glance — comparing personas side-by-side becomes meaningful only
 * when you can see each one's relationship state.
 */
function PersonaChip({
  label,
  personaId,
  active,
  onClick,
}: {
  label: string
  personaId: string
  active: boolean
  onClick: () => void
}) {
  const [score, setScore] = useState<number | null>(null)
  useEffect(() => {
    let alive = true
    void window.api.affinity.get(personaId).then((rec) => {
      if (alive && rec) setScore(rec.score)
    })
    return () => {
      alive = false
    }
  }, [personaId])
  return (
    <button
      onClick={onClick}
      style={{
        ...chipStyle(active),
        display: 'inline-flex',
        gap: 4,
        alignItems: 'center',
      }}
    >
      <span>{label}</span>
      {score !== null && score > 0 && (
        <span style={{ fontSize: 9, color: active ? '#fff' : '#c45e76' }}>
          ❤️{score}
        </span>
      )}
    </button>
  )
}

/**
 * Shows whether the global summon hotkey is actually registered with the OS
 * right now. Polls main on mount and whenever the saved accelerator changes
 * (i.e. after the user clicks 保存). Stale while the user is editing — that's
 * intentional: the hint text tells them changes apply on save.
 */
function HotkeyStatus({ savedAccelerator }: { savedAccelerator: string }) {
  const [status, setStatus] = useState<{
    registered: boolean
    accelerator: string
    error: string | null
  } | null>(null)
  useEffect(() => {
    let alive = true
    void window.api.window.getHotkeyStatus().then((s) => {
      if (alive) setStatus(s)
    })
    return () => {
      alive = false
    }
  }, [savedAccelerator])
  if (!savedAccelerator) {
    return (
      <div style={{ fontSize: 11, color: '#888' }}>
        ⚪ 未启用——填入快捷键并保存。
      </div>
    )
  }
  if (!status) {
    return <div style={{ fontSize: 11, color: '#888' }}>检查中…</div>
  }
  if (status.registered) {
    return (
      <div style={{ fontSize: 11, color: '#7fc97f' }}>
        ✓ 已注册（{status.accelerator}）。在任意窗口按一次即可呼出 / 隐藏 OpenMeido。
      </div>
    )
  }
  return (
    <div style={{ fontSize: 11, color: '#e88' }}>
      ✗ 注册失败：{status.error || '可能被其他程序占用或格式不正确。换一个组合试试。'}
    </div>
  )
}
