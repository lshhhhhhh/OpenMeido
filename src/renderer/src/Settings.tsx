/**
 * Settings modal. Full-window overlay with the same translucent / blur look
 * as the chat panel. Edits are kept in local React state and only written to
 * the persistent config when the user clicks Save.
 */

import { useEffect, useState } from 'react'

import { personaPresets, type Config } from '../../shared/config'

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

export function Settings({ initial, onClose }: SettingsProps) {
  const [draft, setDraft] = useState<Config>(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function save(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      await window.api.config.set(draft)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
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
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '14px 16px',
          color: '#eee',
          fontSize: 13,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>设置</h2>
          <button onClick={onClose} style={closeBtnStyle}>×</button>
        </div>

        {/* ---- Backend ---- */}
        <Section title="AI Backend">
          <Label>Base URL</Label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
            {BASE_URL_PRESETS.map((p) => (
              <button
                key={p.url}
                style={chipStyle(draft.backend.baseUrl === p.url)}
                onClick={() =>
                  setDraft({ ...draft, backend: { ...draft.backend, baseUrl: p.url } })
                }
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
          {/* Chips for quick picks based on selected base URL — same affordance
              as the URL presets above, so users immediately see they can choose
              instead of having to type. */}
          {suggestedModels(draft.backend.baseUrl).length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
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
            </div>
          )}
          <input
            list="model-suggestions"
            placeholder="或手填任意 model id（fine-tune、新版本、本地模型...）"
            value={draft.backend.model}
            onChange={(e) =>
              setDraft({ ...draft, backend: { ...draft.backend, model: e.target.value } })
            }
            style={inputStyle}
          />
          {/* <datalist> backs the input with native browser autocomplete so power
              users can fuzzy-match suggested models without clicking the chips. */}
          <datalist id="model-suggestions">
            {suggestedModels(draft.backend.baseUrl).map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </Section>

        {/* ---- Persona ---- */}
        <Section title="人设">
          <Label>预设</Label>
          <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
            {(['maid', 'imouto', 'custom'] as const).map((id) => (
              <button
                key={id}
                style={chipStyle(draft.persona.preset === id)}
                onClick={() => setDraft({ ...draft, persona: { ...draft.persona, preset: id } })}
              >
                {id === 'maid' ? '女仆' : id === 'imouto' ? '妹妹' : '自定义'}
              </button>
            ))}
          </div>

          {draft.persona.preset === 'custom' ? (
            <>
              <Label>自定义 system prompt</Label>
              <textarea
                value={draft.persona.customSystemPrompt}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    persona: { ...draft.persona, customSystemPrompt: e.target.value },
                  })
                }
                rows={8}
                style={{ ...inputStyle, fontFamily: 'inherit', resize: 'vertical' }}
              />
              <Label>称呼用户为</Label>
              <input
                placeholder="主人 / 哥 / 你 / ..."
                value={draft.persona.customUserAddress}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    persona: { ...draft.persona, customUserAddress: e.target.value },
                  })
                }
                style={inputStyle}
              />
            </>
          ) : (
            <div
              style={{
                whiteSpace: 'pre-wrap',
                background: 'rgba(255,255,255,0.06)',
                padding: 8,
                borderRadius: 6,
                fontSize: 11,
                lineHeight: 1.5,
                color: '#ccc',
                maxHeight: 160,
                overflowY: 'auto',
              }}
            >
              {personaPresets[draft.persona.preset].systemPrompt}
            </div>
          )}
        </Section>

        {/* ---- Live2D ---- */}
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

        {/* ---- Window ---- */}
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
        <button onClick={onClose} disabled={saving} style={btnStyle(false)}>
          取消
        </button>
        <button onClick={save} disabled={saving} style={btnStyle(true)}>
          {saving ? '...' : '保存'}
        </button>
      </div>
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

function btnStyle(primary: boolean): React.CSSProperties {
  return {
    padding: '6px 18px',
    fontSize: 13,
    borderRadius: 4,
    border: 'none',
    background: primary ? '#5a8edf' : 'rgba(255,255,255,0.12)',
    color: 'white',
    cursor: 'pointer',
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
