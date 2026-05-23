import { useState } from 'react'

import type { Config } from '../../shared/config'
import { BASE_URL_PRESETS, type BackendPreset, suggestedModels } from './backend-presets'
import { performanceModel } from '../../shared/lightweight-models'

interface Props {
  initial: Config
  /** User picked "稍后再说" — dismiss without saving. */
  onSkip: () => void
  /** Save apiKey + baseUrl + model, then close. */
  onSave: (next: Config) => Promise<void>
}

/**
 * First-run modal: pick a backend, register a key, paste it. Triggered from
 * App.tsx when the persisted config has an empty apiKey AND main can't fall
 * back via .env (which is dev-only; shipped builds will see empty here).
 *
 * Defaults to 智谱 GLM because it's the only provider in the list with a free
 * multimodal tier AND China-accessible — best onboarding match.
 */
const DEFAULT_PROVIDER = '智谱 GLM'

export function SetupWizard({ initial, onSkip, onSave }: Props) {
  const [preset, setPreset] = useState<BackendPreset>(
    BASE_URL_PRESETS.find((p) => p.label === DEFAULT_PROVIDER) ?? BASE_URL_PRESETS[0]!,
  )
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Personalization fields — both optional. Even leaving both blank
  // still lets the user finish setup; we only seed facts when the
  // user actually typed something. Default callAs comes from the
  // active persona's address (主人 / 哥 / 你) so the placeholder
  // already feels right.
  const personaAddress =
    initial.persona.preset === 'maid'
      ? '主人'
      : initial.persona.preset === 'imouto'
        ? '哥'
        : initial.persona.preset === 'ojou'
          ? '你'
          : '你'
  const [callAs, setCallAs] = useState('')
  const [occupation, setOccupation] = useState('')

  // Auto-derive a sensible default model for the picked provider. We always
  // Prefer the perf-tier default (the recommended chat model for that
  // provider — gpt-5.5, glm-5.1, kimi-k2.6, etc). Falls back to the
  // first suggestion (cheap/free tier) if no perf mapping exists for
  // the host. Power users tweak later in Settings → AI.
  const defaultModel =
    performanceModel(preset.url) ??
    suggestedModels(preset.url)[0] ??
    initial.backend.model

  // Local-endpoint presets don't need a key. For those, we let Save fire even
  // with apiKey empty; for everything else we require non-empty.
  const keyOptional = !preset.envVar
  const canSave = keyOptional || apiKey.trim().length > 0

  async function save(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      const trimmed = apiKey.trim()
      // Also record this key in the per-baseUrl map so a later provider
      // switch in Settings doesn't drop it. The map exists so users can
      // configure multiple backends and round-trip between them without
      // re-entering keys.
      const apiKeys = { ...initial.backend.apiKeys, [preset.url]: trimmed }
      await onSave({
        ...initial,
        backend: {
          baseUrl: preset.url,
          model: defaultModel,
          apiKey: trimmed,
          apiKeys,
          // Preserve whatever toggle the user had before; this wizard is
          // about provider/key, not search settings.
          searchEnabled: initial.backend.searchEnabled,
        },
      })
      // Seed personalization facts AFTER config save (which initializes
      // memory) so the very first greeting can reference them. Both
      // fields are optional — empty/blank values skip the write.
      // upsertFact auto-picks scope from key prefix:
      //   - user.preferred_address → 'persona' (each persona has its own)
      //   - user.occupation        → 'shared'  (applies across personas)
      const trimmedCallAs = callAs.trim()
      const trimmedOccupation = occupation.trim()
      if (trimmedCallAs) {
        await window.api.memory.upsertFact('user.preferred_address', trimmedCallAs).catch(
          (err) => console.warn('[wizard] seed preferred_address failed:', err),
        )
      }
      if (trimmedOccupation) {
        await window.api.memory.upsertFact('user.occupation', trimmedOccupation).catch(
          (err) => console.warn('[wizard] seed occupation failed:', err),
        )
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  function openSignup(): void {
    window.open(preset.signupUrl, '_blank', 'noopener,noreferrer')
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2000,
        // Slightly stronger backdrop than Settings — this is the gate before
        // anything else works, we want to clearly block interaction with the
        // chat below.
        background: 'rgba(0,0,0,0.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div
        style={{
          width: 480,
          maxWidth: '90vw',
          background: '#1f2128',
          color: '#eee',
          borderRadius: 10,
          padding: '20px 22px',
          boxShadow: '0 10px 40px rgba(0,0,0,0.5)',
          // position:relative so the absolutely-positioned close × can
          // anchor to the card's corner instead of the viewport.
          position: 'relative',
        }}
      >
        {/* Top-right × — same affordance as "稍后再说" but in the canonical
            "this is a closable modal" position. Without it, a user who
            reaches this dialog accidentally has no obvious way out
            besides reading to the bottom and finding 稍后再说. */}
        <button
          onClick={onSkip}
          aria-label="跳过设置"
          title="跳过设置（稍后可在 Settings → AI 配）"
          style={{
            position: 'absolute',
            top: 10,
            right: 12,
            width: 28,
            height: 28,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            border: 'none',
            color: '#888',
            fontSize: 20,
            lineHeight: 1,
            cursor: 'pointer',
            borderRadius: 4,
            padding: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(255,255,255,0.08)'
            e.currentTarget.style.color = '#eee'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent'
            e.currentTarget.style.color = '#888'
          }}
        >
          ×
        </button>
        <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>
          👋 欢迎，先给妹妹/女仆配个大脑
        </div>
        <div style={{ fontSize: 12, color: '#aaa', marginBottom: 16 }}>
          需要一个 AI 接口才能聊天。挑一家、注册、把 key 粘进来，2 分钟搞定。
        </div>

        {/* Provider radio list — vertical so labels fit comfortably and the
            recommended row sits naturally at the top with a star. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 14 }}>
          {BASE_URL_PRESETS.map((p) => {
            const selected = p.label === preset.label
            const recommended = p.label === DEFAULT_PROVIDER
            return (
              <label
                key={p.url}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 10px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  background: selected ? 'rgba(120,160,255,0.16)' : 'transparent',
                  border: selected
                    ? '1px solid rgba(120,160,255,0.55)'
                    : '1px solid transparent',
                  fontSize: 13,
                }}
              >
                <input
                  type="radio"
                  name="backend-preset"
                  checked={selected}
                  onChange={() => setPreset(p)}
                  style={{ accentColor: '#7ab8ff' }}
                />
                <span style={{ fontWeight: selected ? 600 : 400 }}>
                  {p.label}
                  {recommended && (
                    <span style={{ color: '#ffd566', marginLeft: 6, fontSize: 11 }}>★ 推荐</span>
                  )}
                </span>
                {p.note && (
                  <span style={{ color: '#8c8', fontSize: 11, marginLeft: 'auto' }}>
                    {p.note}
                  </span>
                )}
              </label>
            )
          })}
        </div>

        {/* Step 1: register */}
        <div style={{ fontSize: 12, color: '#bbb', marginBottom: 6 }}>
          ① 点这里去 <b>{preset.label}</b> 注册并复制 key：
        </div>
        <button
          onClick={openSignup}
          style={{
            width: '100%',
            padding: '8px 12px',
            marginBottom: 14,
            background: 'rgba(122,184,255,0.18)',
            border: '1px solid rgba(122,184,255,0.5)',
            color: '#aad4ff',
            borderRadius: 6,
            cursor: 'pointer',
            fontSize: 13,
            textAlign: 'left',
          }}
        >
          🌐 打开 {preset.signupUrl} ↗
        </button>

        {/* Step 2: paste */}
        <div style={{ fontSize: 12, color: '#bbb', marginBottom: 6 }}>
          {keyOptional ? '② 本地端点，无需 key（直接 "开始聊天"）' : '② 粘贴 key 进来：'}
        </div>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={keyOptional ? '（可留空）' : 'sk-... / AIza... / xxx.yyy'}
          disabled={keyOptional || saving}
          // Auto-focus so the user can paste immediately without hunting for
          // the field. Disabled when there's nothing to type (local endpoints).
          autoFocus
          style={{
            width: '100%',
            padding: '7px 10px',
            background: '#2a2d36',
            border: '1px solid #3a3e48',
            color: '#eee',
            borderRadius: 6,
            fontSize: 13,
            marginBottom: 16,
            // The text inside is sensitive — monospace makes truncation obvious.
            fontFamily: keyOptional ? 'inherit' : 'monospace',
            boxSizing: 'border-box',
          }}
        />

        {/* Personalization — both optional. The point isn't to gather
            data; it's to let the FIRST greeting reference something
            real about you so the app feels alive on minute 1 instead
            of "you, generic AI user". Skipping both is fine. */}
        <div
          style={{
            marginBottom: 14,
            padding: '10px 12px',
            background: 'rgba(120,160,255,0.06)',
            border: '1px solid rgba(120,160,255,0.18)',
            borderRadius: 6,
          }}
        >
          <div style={{ fontSize: 12, color: '#bbb', marginBottom: 8 }}>
            ③ 让她第一眼就觉得"认识你"（选填，留空也行）
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>
                她可以叫你
              </div>
              <input
                type="text"
                value={callAs}
                onChange={(e) => setCallAs(e.target.value)}
                placeholder={personaAddress}
                disabled={saving}
                style={{
                  width: '100%',
                  padding: '6px 8px',
                  background: '#2a2d36',
                  border: '1px solid #3a3e48',
                  color: '#eee',
                  borderRadius: 6,
                  fontSize: 12,
                  boxSizing: 'border-box',
                }}
              />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>
                你做什么的
              </div>
              <input
                type="text"
                value={occupation}
                onChange={(e) => setOccupation(e.target.value)}
                placeholder="程序员 / 学生 / 设计师..."
                disabled={saving}
                style={{
                  width: '100%',
                  padding: '6px 8px',
                  background: '#2a2d36',
                  border: '1px solid #3a3e48',
                  color: '#eee',
                  borderRadius: 6,
                  fontSize: 12,
                  boxSizing: 'border-box',
                }}
              />
            </div>
          </div>
          <div style={{ fontSize: 10, color: '#666' }}>
            稍后在 Settings → 人物 → 记忆 里随时改。
          </div>
        </div>

        {error && (
          <div
            style={{
              fontSize: 12,
              color: '#f99',
              marginBottom: 10,
              padding: '6px 10px',
              background: 'rgba(200,80,80,0.15)',
              border: '1px solid rgba(200,80,80,0.35)',
              borderRadius: 4,
            }}
          >
            保存失败：{error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            onClick={onSkip}
            disabled={saving}
            style={{
              padding: '7px 14px',
              background: 'transparent',
              border: '1px solid #4a4e58',
              color: '#aaa',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            稍后再说
          </button>
          <button
            onClick={() => void save()}
            disabled={!canSave || saving}
            style={{
              padding: '7px 14px',
              background: canSave ? '#3a82f7' : '#2c3140',
              border: '1px solid ' + (canSave ? '#5497ff' : '#3a3e48'),
              color: canSave ? '#fff' : '#666',
              borderRadius: 6,
              cursor: canSave ? 'pointer' : 'not-allowed',
              fontSize: 13,
              fontWeight: 500,
            }}
          >
            {saving ? '保存中…' : '开始聊天 →'}
          </button>
        </div>

        <div style={{ fontSize: 11, color: '#666', marginTop: 12, textAlign: 'center' }}>
          稍后可在 设置（⚙）→ AI 改 backend / 换 key。
        </div>
      </div>
    </div>
  )
}
