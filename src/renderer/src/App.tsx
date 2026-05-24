import { useEffect, useRef, useState } from 'react'

import type { ChatEvent, ChatImageAttachment } from '../../shared/ipc'
import { resolvePersona, backgroundFor } from '../../shared/config'
import { Live2DCanvas } from './live2d/Live2DCanvas'
import type { Live2DController, Coverage } from './live2d/stage'
import { playMp3Base64, warmupAudioContext, type PlayHandle } from './tts/player'
import { Settings } from './Settings'
import { SetupWizard } from './SetupWizard'
import { Sidebar } from './Sidebar'
import { useConfig } from './useConfig'
import { ConfirmHost } from './confirm'
import { matchHotkey } from '../../shared/demos'
import { stripMarkdown } from '../../shared/strip-markdown'
import { pickMuteFeedback } from '../../shared/mute-feedback'
import { PRESET_LINES_DEFAULTS } from '../../shared/preset-lines-defaults'
import { isWorkToolName } from '../../shared/work-tools'

interface ToolCall {
  name: string
  args: unknown
  result?: unknown
}

/**
 * Rotating onboarding tips — shown as the chat input's placeholder when
 * the input is idle (no typing, no recording, no attachments, not
 * busy). Cycles every TIP_ROTATE_MS so a new-install user discovers
 * features without needing a tutorial.
 *
 * Keep tips ~1 sentence, action-oriented, and feature-pointing. They
 * disappear the moment the user starts typing, so brevity matters
 * more than completeness.
 */
const ONBOARDING_TIPS: readonly string[] = [
  '好感度越高，对话越深',
  '🔔 一键让她闭嘴',
  '语音 / 声线可自定义',
  '拖动她到桌面任意位置',
  '👀 让她看你的屏幕',
  'Settings 可以连邮箱',
  '可以切换 4 种人设',
  '主动模式跟好感度联动',
  '台词文件可记事本编辑',
  'Live2D 模型可自己导入',
]
// 15s rather than 5s — the placeholder sits in the user's peripheral
// vision while they read or think, and short rotations pull the eye
// every few seconds. 15s makes it feel ambient (one cycle ≈ 2.5min)
// while still surfacing enough tips for a casual user to discover
// features within their first session.
const TIP_ROTATE_MS = 15000

interface DraftCard {
  cardId: string
  replyToUid: string
  to: string
  subject: string
  body: string
}

interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
  /** Data URLs of attached images (one per screen, plus future paste/drop). */
  imageDataUrls?: string[]
  toolCalls?: ToolCall[]
  /** Email draft attached to this turn — rendered as an inline card
   *  with copy + iterate controls below the assistant's text. Latest
   *  draft for the same replyToUid replaces the prior one (no stack). */
  draft?: DraftCard
}

// `-webkit-app-region` isn't in @types/react's CSSProperties yet. Bridge it.
type AppRegionStyle = React.CSSProperties & { WebkitAppRegion?: 'drag' | 'no-drag' }

/** Default chat panel takes 2/5 of the window height. Computed lazily so
 *  it adapts to the user's actual window size rather than assuming the
 *  720 default — a tall ultrawide window would otherwise get a tiny
 *  chat panel relative to the Live2D space. */
const DEFAULT_CHAT_HEIGHT_RATIO = 0.4
const computeDefaultChatHeight = (): number =>
  Math.round((typeof window !== 'undefined' ? window.innerHeight : 720) * DEFAULT_CHAT_HEIGHT_RATIO)
const MIN_CHAT_HEIGHT = 100
const MIN_LIVE2D_HEIGHT = 120

/**
 * Strip the `zh-CN-` / `en-US-` locale prefix and the trailing `Neural` /
 * `MultilingualNeural` suffix from an Edge TTS voice ShortName for status-pill
 * display. e.g. `zh-CN-XiaoyiNeural` → `Xiaoyi`. Falls back to the full name
 * if the pattern doesn't match (custom / future voice).
 */
function shortVoiceLabel(voice: string): string {
  const m = /^[a-z]{2}-[A-Z]{2}-(.+?)(Multilingual)?Neural$/.exec(voice)
  return m?.[1] ?? voice
}

/**
 * Decode an audio blob (MediaRecorder output — typically webm/opus) to
 * 16 kHz mono Float32 PCM, which is what our STT pipeline expects.
 *
 * Step 1: decodeAudioData → AudioBuffer at file's native rate (usually
 * 48 kHz for mic capture).
 * Step 2: OfflineAudioContext renders that buffer at the target 16 kHz,
 * with the destination configured as 1 channel so we get mono out
 * automatically (stereo gets averaged by the OfflineAudioContext).
 */
async function decodeBlobTo16kMono(blob: Blob): Promise<Float32Array> {
  const TARGET_RATE = 16_000
  const arrayBuffer = await blob.arrayBuffer()
  // Use a one-shot AudioContext at default rate to decode the file.
  // We close it immediately to free the audio device.
  const tempCtx = new AudioContext()
  let buffer: AudioBuffer
  try {
    buffer = await tempCtx.decodeAudioData(arrayBuffer)
  } finally {
    await tempCtx.close()
  }
  // Resample + downmix via OfflineAudioContext at the target rate. The
  // constructor's first arg = output channel count (1 = mono).
  const targetLen = Math.max(1, Math.ceil(buffer.duration * TARGET_RATE))
  const offline = new OfflineAudioContext(1, targetLen, TARGET_RATE)
  const src = offline.createBufferSource()
  src.buffer = buffer
  src.connect(offline.destination)
  src.start(0)
  const rendered = await offline.startRendering()
  // Copy out of the audio buffer into a fresh Float32Array so callers
  // can keep it past the rendering context's lifetime.
  return new Float32Array(rendered.getChannelData(0))
}

/**
 * Macros: shortcut phrases the user (or a quick-action chip) sends to
 * the maid that get silently expanded into a fuller, directive prompt
 * before reaching the model. The user bubble in chat history still
 * displays the short natural phrase — only the IPC payload is rewritten.
 *
 * Why not put this in the system prompt? Because it's a per-turn
 * intent ("user wants chat with no topic"), not a permanent rule. We
 * don't want every turn telling the model "by the way, if the user
 * says 'random chat'..." — that wastes tokens and noises up the prompt.
 *
 * Add new entries here as natural shortcuts emerge. Keys are matched
 * exactly against trim()'d input. To match variants, list each spelling.
 */
const USER_MACROS: Record<string, string> = {
  '跟我随便聊聊吧':
    '陪我聊会儿吧，你先开个话题——可以聊你刚才看到的、最近想到的、好奇问我点什么、或者回忆我们一起聊过的事。不要回"您想聊什么我都奉陪"这种把球踢回来的话。',
  '随便聊聊':
    '陪我聊会儿吧，你先开个话题——可以聊你刚才看到的、最近想到的、好奇问我点什么、或者回忆我们一起聊过的事。不要回"您想聊什么我都奉陪"这种把球踢回来的话。',
  '跟我聊聊':
    '陪我聊会儿吧，你先开个话题——可以聊你刚才看到的、最近想到的、好奇问我点什么、或者回忆我们一起聊过的事。不要回"您想聊什么我都奉陪"这种把球踢回来的话。',
  '陪我聊会儿':
    '陪我聊会儿吧，你先开个话题——可以聊你刚才看到的、最近想到的、好奇问我点什么、或者回忆我们一起聊过的事。不要回"您想聊什么我都奉陪"这种把球踢回来的话。',
}

function expandUserMacro(text: string): string {
  return USER_MACROS[text.trim()] ?? text
}

export default function App() {
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [busy, setBusy] = useState(false)
  // While a reply is streaming, the input stays unlocked so the user can
  // compose the next message. If they press Send/Enter while busy, we
  // record that intent here and auto-fire the send once `busy` flips back
  // to false. Refs because the auto-send happens inside the chat-event
  // useEffect's stale closure.
  const pendingSendRef = useRef(false)
  // Sidebar visibility (reminders / TODOs / recent activity).
  const [sidebarOpen, setSidebarOpen] = useState(false)
  // Bumped on every chat 'done' event so the Sidebar's recent-activity
  // section refetches. Activity is derived from episodes, no broadcast.
  const [activityRefreshToken, setActivityRefreshToken] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [chatHeight, setChatHeight] = useState(computeDefaultChatHeight)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Pending attachments for the NEXT send. Cleared after send fires.
  const [attachments, setAttachments] = useState<ChatImageAttachment[]>([])
  const [capturing, setCapturing] = useState(false)
  // Voice-input state machine. idle → recording → transcribing → idle.
  // recording uses MediaRecorder + AudioContext to capture the user's mic;
  // transcribing decodes the blob, resamples to 16 kHz mono Float32, and
  // ships to main where Whisper produces the transcript.
  /** Quick screen-react in flight — disables the button so rapid
   *  clicks don't fire concurrent captures + LLM calls. */
  const [quickScreenBusy, setQuickScreenBusy] = useState(false)
  const [voiceState, setVoiceState] = useState<'idle' | 'recording' | 'transcribing'>(
    'idle',
  )
  const voiceRecorderRef = useRef<MediaRecorder | null>(null)
  const voiceChunksRef = useRef<Blob[]>([])
  const voiceStreamRef = useRef<MediaStream | null>(null)
  // First-run setup wizard. Three states:
  //   'checking'  — running an initial chat.test to decide whether we need it
  //   'open'      — show the wizard (no working key found)
  //   'dismissed' — user clicked "稍后再说" OR test succeeded → hide
  // Initial 'checking' avoids a flash of the wizard for devs whose .env
  // supplies a key (apiKey empty in config but main resolves via env).
  const [wizardState, setWizardState] = useState<'checking' | 'open' | 'dismissed'>(
    'checking',
  )
  // LLM health — 'idle' (untested), 'ok' (last call succeeded), 'error'
  // (last call failed). Updates on chat events.
  const [llmStatus, setLlmStatus] = useState<'idle' | 'ok' | 'error'>('idle')
  // Transient memory-write-failure banner. Auto-clears after 8 seconds.
  const [memoryError, setMemoryError] = useState<string | null>(null)
  // Naive-mode banner state. True when the embed model isn't on disk
  // yet — banner persists (doesn't auto-clear) until the user finishes
  // the in-app download. Flipped via embed.status() at boot + via the
  // embed.onComplete listener.
  const [naiveMode, setNaiveMode] = useState(false)
  const [downloadInProgress, setDownloadInProgress] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState<{
    received: number
    total: number
    file: string | null
  }>({ received: 0, total: 0, file: null })
  const activeIdRef = useRef<string | null>(null)
  const live2dRef = useRef<Live2DController>(null)
  const messageListRef = useRef<HTMLDivElement>(null)
  // Currently-playing TTS handle. Tapping speaker on another bubble (or
  // starting a new send) stops this one so audio doesn't overlap.
  const ttsHandleRef = useRef<PlayHandle | null>(null)
  // Last few mute-feedback lines used, oldest first. Bounded to 3 so the
  // anti-repeat ring stays well under the smallest pool size (4) and we
  // never trigger the "every line used" fallback unnecessarily.
  const recentMuteLinesRef = useRef<string[]>([])
  // Rotating onboarding tip index — drives the chat input's placeholder
  // when it would otherwise be empty. Cycles via setInterval, see the
  // useEffect below.
  const [tipIdx, setTipIdx] = useState<number>(() => Math.floor(Math.random() * ONBOARDING_TIPS.length))
  // Preset台词 from %APPDATA%/openmeido/lines.json (merged with bundled
  // defaults). Fetched once at boot — user edits require app restart.
  // Holds null until the first IPC fetch resolves; the mute button uses
  // bundled defaults as a fallback for that brief window so an early
  // click before lines arrive still works.
  const linesRef = useRef<import('../../shared/preset-lines-defaults').PresetLines | null>(null)
  // Which message index is currently speaking (for UI highlight).
  const [speakingIdx, setSpeakingIdx] = useState<number | null>(null)
  const config = useConfig()
  // Mirror config + speak + messages into refs so the chat-event useEffect
  // closure (which has [] deps so subscription doesn't churn) always reads
  // fresh values, AND so we can read state from outside React's setMessages
  // updater (which StrictMode double-invokes in dev — side-effects there fire
  // twice, causing audible double-play).
  const configRef = useRef(config)
  configRef.current = config
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  // Messages whose 'done' event has already been processed — see the
  // 'done' case in the chat-event handler for why we need this.
  const doneSeenRef = useRef<Set<string>>(new Set())
  // Synchronously-tracked accumulation of the current assistant turn's
  // visible text. We CAN'T read this from messagesRef in the `done` case
  // because the most recent setMessages (queued by flushPendingText) may
  // not have committed yet — `done` fires on the IPC channel and the
  // React re-render is async. Reading messagesRef under those conditions
  // misses the most recent flushed chunk and TTS drops the first
  // characters of the reply.
  const accumulatedTextRef = useRef('')
  // Resolved meido-live2d:// URL for the currently-active model. Stays null
  // until the sidecar fetch returns — we render Live2DCanvas conditionally.
  const [modelUrl, setModelUrl] = useState<string | null>(null)


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

  // Text-display buffer: smooths over the "model emitted text then tool_call
  // fires text-reset" pattern that was producing a visible flash (text
  // appears, then erases). We hold incoming deltas for ~450ms before
  // committing them to the visible bubble. If a text-reset arrives while
  // text is still in the buffer, we discard it silently — no flash.
  //
  // Tradeoff: the user sees text appear in ~450ms-spaced batches instead of
  // token-by-token. For a maid-style chat this reads more like "she pauses
  // then says something" rather than a typewriter — which the user prefers
  // over the flashing.
  const TEXT_FLUSH_DELAY_MS = 450
  const pendingTextRef = useRef<{
    buffer: string
    timer: ReturnType<typeof setTimeout> | null
  }>({ buffer: '', timer: null })

  function flushPendingText(): void {
    const p = pendingTextRef.current
    if (p.timer) {
      clearTimeout(p.timer)
      p.timer = null
    }
    if (p.buffer) {
      const buf = p.buffer
      p.buffer = ''
      patchLastAssistant((m) => ({ ...m, text: m.text + buf }))
    }
  }

  // Warm the AudioContext on first mount so the boot-greeting TTS plays
  // from the start, not from "wherever Chromium let it begin once we
  // had a user gesture". Pairs with main.ts's
  // --autoplay-policy=no-user-gesture-required.
  useEffect(() => {
    warmupAudioContext()
  }, [])

  // Register installed optional fonts via the FontFace API so they're
  // immediately usable without an app restart. Bundled Xiaolai is
  // already in index.css; the other two (LXGW / Smiley) are served
  // from <userData>/fonts/ via meido-font:// and only exist on disk
  // if the user downloaded them. Skip silently for fonts not installed.
  useEffect(() => {
    let cancelled = false
    void window.api.fonts?.list().then(async (fonts) => {
      if (cancelled || !fonts) return
      const nameMap: Record<string, string> = {
        'lxgw-wenkai': 'LXGW WenKai Lite',
        'smiley-sans': 'Smiley Sans',
      }
      for (const f of fonts) {
        if (!f.installed) continue
        const family = nameMap[f.id]
        if (!family) continue
        // Skip if already registered (e.g. effect re-runs in StrictMode dev).
        if ([...document.fonts].some((ff) => ff.family === family)) continue
        try {
          const face = new FontFace(family, `url(meido-font:///${encodeURIComponent(f.filename)})`)
          await face.load()
          document.fonts.add(face)
        } catch (err) {
          console.warn(`[font] failed to register installed font ${f.id}:`, err)
        }
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Apply the user's chosen UI font by writing a CSS variable on the
  // <html> element. index.html's `font-family: var(--meido-font, ...)`
  // reads this; everything inherits from there. 'system' clears the
  // variable so the fallback chain in index.html kicks in.
  useEffect(() => {
    if (!config) return
    const fontMap: Record<string, string> = {
      system: '',
      xiaolai: '"Xiaolai", "HarmonyOS Sans SC", "Microsoft YaHei UI", sans-serif',
      'lxgw-wenkai': '"LXGW WenKai Lite", "HarmonyOS Sans SC", "Microsoft YaHei UI", sans-serif',
      'smiley-sans': '"Smiley Sans", "HarmonyOS Sans SC", "Microsoft YaHei UI", sans-serif',
    }
    const family = fontMap[config.ui.fontFamily] ?? ''
    if (family) {
      document.documentElement.style.setProperty('--meido-font', family)
    } else {
      document.documentElement.style.removeProperty('--meido-font')
    }
  }, [config?.ui.fontFamily])

  // Rotate the onboarding tip placeholder every TIP_ROTATE_MS so users
  // discover features passively. Always runs — the placeholder is
  // only visible when the input is idle anyway, so silent rotation
  // during typing / recording is invisible (and cheap).
  useEffect(() => {
    const id = setInterval(() => {
      setTipIdx((i) => (i + 1) % ONBOARDING_TIPS.length)
    }, TIP_ROTATE_MS)
    return () => clearInterval(id)
  }, [])

  // Fetch preset台词 from main once at boot. Until this resolves, the
  // mute button falls back to bundled defaults; both are valid
  // structures so there's no broken state during the brief window
  // before the IPC returns.
  useEffect(() => {
    void window.api.lines?.get().then((data) => {
      // Defensive cast — main validates with Zod, so this is the
      // already-merged structure.
      linesRef.current = data as typeof PRESET_LINES_DEFAULTS
    })
  }, [])

  useEffect(() => {
    return window.api.chat.onEvent((event: ChatEvent) => {
      if (event.messageId !== activeIdRef.current) return

      switch (event.type) {
        case 'text': {
          const p = pendingTextRef.current
          p.buffer += event.delta
          accumulatedTextRef.current += event.delta
          // Throttle, don't debounce — once a flush is scheduled, let it
          // fire so streaming text doesn't get held indefinitely.
          if (!p.timer) {
            p.timer = setTimeout(() => {
              p.timer = null
              flushPendingText()
            }, TEXT_FLUSH_DELAY_MS)
          }
          break
        }
        case 'text-reset': {
          // Two sources can trigger this: (a) `</think>` block stripped by
          // the main-process filter, (b) pre-tool narration rolled back
          // because a tool_call fired. In both cases, prefer to consume
          // characters from our pending-text buffer FIRST — those chars
          // were never committed to the visible bubble, so discarding them
          // silently means the user never sees the flash. Only fall back to
          // slicing the visible text when the reset is bigger than the
          // pending buffer.
          const p = pendingTextRef.current
          const fromBuffer = Math.min(event.length, p.buffer.length)
          if (fromBuffer > 0) {
            p.buffer = p.buffer.slice(0, -fromBuffer)
            if (!p.buffer && p.timer) {
              clearTimeout(p.timer)
              p.timer = null
            }
          }
          const remaining = event.length - fromBuffer
          if (remaining > 0) {
            patchLastAssistant((m) => ({
              ...m,
              text: m.text.slice(0, -remaining),
            }))
          }
          // Keep the synchronous accumulator in sync with what's actually
          // going to end up visible.
          if (event.length > 0) {
            accumulatedTextRef.current = accumulatedTextRef.current.slice(
              0,
              -event.length,
            )
          }
          break
        }
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
        case 'draft-card':
          // Email-draft side-channel. The draftEmailReply tool emits
          // this; we attach the draft to the current assistant message
          // so it renders inline as a card. A second draft for the
          // same replyToUid (iteration) replaces the first — no stack.
          patchLastAssistant((m) => ({ ...m, draft: event.draft }))
          break
        case 'done': {
          // Commit the trailing buffered text to the visible bubble. We
          // don't need to capture it for TTS — accumulatedTextRef has
          // every char already (it's updated synchronously on each
          // text-delta, unlike messagesRef which lags by one React render).
          flushPendingText()
          setBusy(false)
          setLlmStatus('ok')
          // Guard against duplicate 'done' events on the same messageId.
          // Two sources can produce them:
          //   1. React StrictMode dev double-mount before cleanup runs.
          //   2. HMR + Fast Refresh leaving a stale chat-event listener
          //      from a previous edit (Electron-vite + IPC handlers).
          // Either way we'd auto-play the same reply twice. doneSeenRef
          // is a Set scoped to this listener; we drop the duplicate here
          // BEFORE asking speakRef to do anything.
          if (doneSeenRef.current.has(event.messageId)) break
          doneSeenRef.current.add(event.messageId)
          {
            const idx = messagesRef.current.length - 1
            const fullText = accumulatedTextRef.current
            if (fullText.trim()) {
              const cfg = configRef.current
              if (cfg?.tts.enabled && cfg.tts.autoPlay) {
                void speakRef.current(fullText, idx)
              }
            }
          }
          // If the user queued a Send while the reply was streaming, fire
          // it now. Defer one tick so React commits setBusy(false) first —
          // otherwise sendRef.current sees busy=true and re-queues forever.
          if (pendingSendRef.current) {
            pendingSendRef.current = false
            setTimeout(() => sendRef.current(), 0)
          }
          // Tell the sidebar's recent-activity section to refetch — the
          // turn just persisted new tool_calls/tool_results.
          setActivityRefreshToken((v) => v + 1)
          break
        }
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

  // Memory write failures bubble up here so silent failures get visible.
  useEffect(() => {
    return window.api.memory.onError((info) => {
      setMemoryError(`记忆 ${info.operation} 失败: ${info.message}`)
      // Auto-dismiss after 8 seconds; user can also click ×.
      setTimeout(() => setMemoryError(null), 8000)
    })
  }, [])

  // Naive-memory-mode boot check + download subscriptions. When the embed
  // model isn't on disk, the banner stays visible until the user downloads.
  useEffect(() => {
    void window.api.embed.status().then((s) => {
      setNaiveMode(s.naive)
      setDownloadInProgress(s.inProgress)
      setDownloadProgress({ received: s.receivedBytes, total: s.totalBytes, file: s.currentFile })
    })
    const offP = window.api.embed.onProgress((p) => {
      setDownloadInProgress(p.inProgress)
      setDownloadProgress({ received: p.receivedBytes, total: p.totalBytes, file: p.currentFile })
    })
    const offC = window.api.embed.onComplete((r) => {
      setDownloadInProgress(false)
      if (r.ok) setNaiveMode(false)
    })
    return () => {
      offP()
      offC()
    }
  }, [])

  // Reminder fired in main → show it inline in chat as an assistant message.
  // Kept on the legacy `reminders` channel for back-compat with any old
  // pending reminders (pre-task-migration) that fire while we're running.
  useEffect(() => {
    return window.api.reminders.onFired((reminder) => {
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          text: `⏰ 提醒：${reminder.message}`,
        },
      ])
    })
  }, [])

  // Task notification fired (the new unified channel). We deliberately do
  // NOT append a synthetic `⏰ 提醒：…` bubble anymore — tasks-host now asks
  // the LLM to generate a maid-styled reminder line and broadcasts it as
  // a `proactive:remark`, which the spontaneous-remark handler below picks
  // up (display + TTS, same as proactive observer output). All we keep this
  // channel around for is the eventual case where some non-text UX wants
  // to react to a fire (badge, flash, etc.).

  // Spontaneous proactive remark from main. Drop it into the chat list and,
  // if TTS auto-play is on, speak it. We don't track it through activeIdRef
  // because there's no associated stream — it's already complete text.
  useEffect(() => {
    return window.api.proactive.onRemark((info) => {
      // Append outside the setMessages updater — StrictMode double-invokes
      // updaters in dev and we don't want auto-speak to fire twice.
      const idx = messagesRef.current.length
      setMessages((prev) => [...prev, { role: 'assistant' as const, text: info.text }])
      const cfg = configRef.current
      if (cfg?.tts.enabled && cfg.tts.autoPlay) {
        void speakRef.current(info.text, idx)
      }
    })
  }, [])

  // First-run check: hit /models via window.api.chat.test with the current
  // backend. If it succeeds, we have a working key (either in config or via
  // .env fallback in dev), so skip the wizard. If it fails AND the user
  // Open the wizard when this install has not yet completed it. The flag
  // is persisted in config.onboarding.wizardCompleted — wiped by
  // reset:all / reset:config, set by Save or Skip. We DELIBERATELY don't
  // probe the backend with chat.test() anymore: the env-var fallback in
  // resolveBackendKey would silently make a freshly-reset install look
  // configured (since dev .env still leaks through), which is what
  // suppressed the wizard after reset in v0.0.39.
  useEffect(() => {
    if (!config) return
    if (wizardState !== 'checking') return
    setWizardState(config.onboarding.wizardCompleted ? 'dismissed' : 'open')
  }, [config, wizardState])

  // Subscribe to Live2D commands from main (chat tool calls). The main side
  // already does the emotion → expression/motion lookup via the active model's
  // sidecar, so here we just translate the broadcast into a controller call.
  useEffect(() => {
    return window.api.live2d.onCommand((cmd) => {
      const ctrl = live2dRef.current
      if (!ctrl) return
      if (cmd.type === 'setExpression') {
        if (cmd.name === null) ctrl.clearExpression()
        else ctrl.setExpression(cmd.name)
      } else if (cmd.type === 'playMotion') {
        ctrl.playMotion(cmd.group, cmd.index)
      }
    })
  }, [])

  // Idle fidget — every 75-150s of true idle, randomly play an
  // expression or motion so the model doesn't sit perfectly still
  // between events. Without this the maid felt "dry" between chat
  // turns / proactive remarks. Eye tracking already covers "she looks
  // at where my mouse is", but the rest of her face/body stayed
  // static. This adds the missing layer of "she just adjusted, looked
  // around, fixed her hair" — micro-fidgets that read as alive.
  //
  // Guards: skip while chat is in flight (busy), while TTS is playing
  // (speakingIdx !== null — would override the speaking expression),
  // or while the user is recording voice input (voiceState). All
  // accessed via refs so the timer doesn't restart on every render.
  const idleStateRef = useRef({ busy, speakingIdx, voiceState })
  useEffect(() => {
    idleStateRef.current = { busy, speakingIdx, voiceState }
  }, [busy, speakingIdx, voiceState])
  useEffect(() => {
    let mainTimer: number | null = null
    let clearExprTimer: number | null = null

    const scheduleNext = (): void => {
      // Random delay 75-150s. Wide range prevents periodicity (user
      // would notice "she always fidgets at 1m30s after each chat").
      const delayMs = 75_000 + Math.random() * 75_000
      mainTimer = window.setTimeout(fire, delayMs)
    }

    const fire = (): void => {
      const ctrl = live2dRef.current
      const state = idleStateRef.current
      // Bail if model not loaded or anything else has the stage. The
      // re-schedule still runs so we try again later.
      const occupied =
        !ctrl ||
        state.busy ||
        state.speakingIdx !== null ||
        state.voiceState !== 'idle'
      if (occupied) {
        scheduleNext()
        return
      }
      // 70/30 split: expressions are subtler, motions are more
      // visible. Tilt toward expressions so the fidget doesn't feel
      // performative. For models with no .exp3.json (Hiyori / Haru),
      // randomExpression silently no-ops — the next tick will land
      // on motion and the user still sees something.
      if (Math.random() < 0.7) {
        ctrl!.randomExpression()
        // Return to default after 6-10s so the fidget reads as a
        // brief look, not a held emotion.
        const clearDelayMs = 6_000 + Math.random() * 4_000
        clearExprTimer = window.setTimeout(() => {
          // Re-check the state — TTS / chat may have started during
          // the held window; in that case the speaking expression
          // already took over and we don't want to step on it.
          const now = idleStateRef.current
          if (now.busy || now.speakingIdx !== null) return
          live2dRef.current?.clearExpression()
        }, clearDelayMs)
      } else {
        ctrl!.randomMotion()
      }
      scheduleNext()
    }

    scheduleNext()
    return () => {
      if (mainTimer !== null) clearTimeout(mainTimer)
      if (clearExprTimer !== null) clearTimeout(clearExprTimer)
    }
  }, [])

  // Resolve activeModel → meido-live2d:// URL. We need the sidecar to know
  // which *.model3.json inside the model dir is the entry point. Re-runs when
  // the user picks a different model in Settings.
  useEffect(() => {
    if (!config) return
    let canceled = false
    void window.api.live2d.getSidecar(config.live2d.activeModel).then((side) => {
      if (canceled) return
      if (!side) {
        console.warn('[live2d] model not found:', config.live2d.activeModel)
        setModelUrl(null)
        return
      }
      // Encode each path segment separately so spaces / Chinese characters
      // in the filename survive the URL parser.
      const file = side.modelFile
        .split('/')
        .map((seg) => encodeURIComponent(seg))
        .join('/')
      setModelUrl(`meido-live2d://${encodeURIComponent(config.live2d.activeModel)}/${file}`)
    })
    return () => {
      canceled = true
    }
  }, [config?.live2d.activeModel])

  // Demo mode — each demo has its own hotkey in `<userData>/demos.json`.
  // Local (window-focused only) since main has no registered global shortcut.
  // We re-fetch from main on every plausible keydown so user edits to the
  // file take effect immediately, no restart / no HMR.
  //
  // Bare keys like '1' / '2' are valid hotkeys, BUT we suppress matching
  // when the user is typing in the chat input — otherwise typing '1' in a
  // sentence would fire demo 1. Modifier-prefixed hotkeys (Ctrl+Shift+D)
  // pass through input-focus suppression because the modifier signals intent.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const hasMod = e.ctrlKey || e.altKey || e.metaKey
      // While focus is in an editable element AND there's no modifier, this
      // is regular typing — don't fire any demo.
      const target = e.target as HTMLElement | null
      const inEditable =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable
      if (inEditable && !hasMod) return
      // Cheap pre-filter to avoid an IPC roundtrip on every keystroke:
      // anything that could plausibly be a hotkey has either a modifier,
      // OR is a named key (F1 / Space / Escape — `e.key.length > 1`), OR
      // is a single printable char (`e.key.length === 1`, which covers
      // bare-digit hotkeys like '1'). That's literally every keydown but
      // it's only ~20Hz peak, well under any IPC limit.
      const couldBeHotkey = hasMod || e.key.length >= 1
      if (!couldBeHotkey) return
      void (async () => {
        const demos = await window.api.demos.list()
        const item = demos.find((d) => matchHotkey(e, d.hotkey))
        if (!item) return
        e.preventDefault()

        const ctrl = live2dRef.current
        if (item.expression) ctrl?.setExpression(item.expression)
        else if (item.expression === null) ctrl?.clearExpression()
        if (item.motion) ctrl?.playMotion(item.motion.group, item.motion.index)

        const idx = messagesRef.current.length
        setMessages((prev) => [
          ...prev,
          { role: 'assistant' as const, text: item.text },
        ])
        // Speak even if autoPlay is off — pressing the demo hotkey IS an
        // explicit play request. Still respect the master tts.enabled toggle.
        if (configRef.current?.tts.enabled) {
          // Defer one tick so React commits the new bubble first; speak's
          // setSpeakingIdx(idx) needs the bubble to exist for the highlight.
          setTimeout(() => void speakRef.current(item.text, idx), 0)
        }
      })()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Diagnose: log window focus/blur + active element. If Windows is taking
  // focus away from OpenMeido during memory-clear interactions, we'd see
  // a blur on the window itself (NOT just the input).
  useEffect(() => {
    const onFocus = () => console.log('[diag] WINDOW focus', new Date().toISOString())
    const onBlur = () => {
      const a = document.activeElement
      console.log(
        '[diag] WINDOW blur, activeElement was:',
        a ? `${a.tagName}.${(a as HTMLElement).className || '(no class)'}` : 'null',
        new Date().toISOString(),
      )
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  // Window-level click-through. Off by default; opt-in via
  // `cfg.window.clickThroughTransparent` in Settings → 窗口.
  //
  // Driven by Live2DCanvas's `onCoverageChange` (a React synthetic
  // pointer handler on the canvas wrapper). We don't use document-level
  // mousemove because PIXI's interactive system and transparent
  // BrowserWindow quirks can swallow those before they reach a global
  // listener. React's synthetic events on the canvas DOM element always
  // fire reliably.
  //
  // States from the Live2D stage's coverage probe:
  //   'pixel'       → cursor on the maid model → click-through OFF
  //   'transparent' → cursor on empty canvas area → click-through ON
  //   'outside'     → cursor past the canvas (or pointerLeave) → OFF
  //                   (chat / sidebar / outside-window all map here)
  const ignoreMouseRef = useRef(false)
  const setIgnore = (next: boolean): void => {
    if (next === ignoreMouseRef.current) return
    ignoreMouseRef.current = next
    void window.api.window.setIgnoreMouseEvents(next)
  }
  // When the feature is disabled (or unmounting), force OFF so no stuck
  // state can survive a toggle / restart.
  useEffect(() => {
    if (!config?.window.clickThroughTransparent) {
      setIgnore(false)
    }
    return () => setIgnore(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.window.clickThroughTransparent])
  // Hook used by the Live2DCanvas prop below. Wraps setIgnore so the
  // toggle is respected even when Live2DCanvas keeps emitting coverage
  // events after the user disables the feature.
  //
  // Click-through is gated by TWO conditions:
  //   1. The user opted into clickThroughTransparent.
  //   2. The window's "transparent area" is actually transparent (i.e.
  //      no background image is showing). When the room background is
  //      on, those pixels are opaque and clicks belong to the window,
  //      not the desktop — pixel-perfect coverage detection would
  //      otherwise say "transparent" anyway because it only samples the
  //      Live2D canvas, leading to the user seeing a room they can't
  //      click on.
  const handleLive2DCoverage = (cov: Coverage): void => {
    if (!config?.window.clickThroughTransparent) {
      setIgnore(false)
      return
    }
    if (!config.window.transparentBackground) {
      // Room background is showing → ALL pixels are opaque; never click-through.
      setIgnore(false)
      return
    }
    setIgnore(cov === 'transparent')
  }

  /**
   * Speak a chat message via TTS, driving the Live2D mouth from RMS.
   *
   * Token-guarded against concurrent invocations: between auto-play on 'done'
   * and a manual 🔊 tap (or any duplicate event from HMR-stale listeners),
   * two speak() calls could arrive almost simultaneously. Without a guard
   * both would survive the `ttsHandleRef.current?.stop()` no-op (no handle
   * yet) and both would await synthesize → both would call playMp3Base64 →
   * two overlapping audio sources. The token ensures only the most-recent
   * caller actually plays; older ones bail at every await boundary.
   */
  const speakTokenRef = useRef(0)
  const speakRef = useRef<(text: string, idx: number) => Promise<void>>(async () => {})
  async function speak(text: string, idx: number): Promise<void> {
    if (!config?.tts.enabled || !text.trim()) return
    // Tapping the same bubble that's playing → stop it (toggle behavior).
    if (ttsHandleRef.current && speakingIdx === idx) {
      ttsHandleRef.current.stop()
      ttsHandleRef.current = null
      setSpeakingIdx(null)
      return
    }
    ttsHandleRef.current?.stop()
    ttsHandleRef.current = null
    const myToken = ++speakTokenRef.current
    setSpeakingIdx(idx)
    try {
      // No override — let main read whichever backend is configured.
      const result = await window.api.tts.synthesize(text)
      // A newer speak() has superseded us while we were awaiting synthesis —
      // discard this result instead of stacking it on top of the new audio.
      if (speakTokenRef.current !== myToken) return
      if ('error' in result) {
        console.warn('[tts] synth failed:', result.error)
        setSpeakingIdx(null)
        return
      }
      const ctrl = live2dRef.current
      const handle = await playMp3Base64(result.base64, {
        mouthGain: config.tts.mouthGain,
        onMouth: (v) => ctrl?.setMouthOpen(v),
        onEnd: () => {
          // Make sure the mouth closes — onMouth(0) is fired by the player
          // on stop, but we still want UI state to reset.
          ctrl?.setMouthOpen(0)
          if (ttsHandleRef.current === handle) {
            ttsHandleRef.current = null
            setSpeakingIdx((cur) => (cur === idx ? null : cur))
          }
        },
      })
      // Same guard at the second await boundary.
      if (speakTokenRef.current !== myToken) {
        handle.stop()
        return
      }
      ttsHandleRef.current = handle
    } catch (err) {
      console.warn('[tts] play failed:', err)
      setSpeakingIdx(null)
    }
  }
  speakRef.current = speak

  // Stable ref to the latest send so the chat-event useEffect (empty deps)
  // can call it without holding a stale closure.
  const sendRef = useRef<() => void>(() => {})
  function send(): void {
    const text = input.trim()
    // Image-only sends are allowed: user can screenshot and hit Send with
    // no question, model will describe what it sees by default.
    if (!text && attachments.length === 0) return
    // Already streaming a reply — queue the intent. The chat-event 'done'
    // handler will replay this call once busy clears. We don't clear the
    // input here; the user keeps seeing what they typed until the actual
    // send happens.
    if (busy) {
      pendingSendRef.current = true
      return
    }
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
    // Reset the synchronous text accumulator for the new turn so any
    // residue from a cancelled prior turn doesn't leak into TTS.
    accumulatedTextRef.current = ''
    activeIdRef.current = window.api.chat.send(
      expandUserMacro(text),
      attachments.length ? attachments : undefined,
    )
    setInput('')
    setAttachments([])
  }
  sendRef.current = send

  // Send a chat message originated outside the main input box (currently the
  // sidebar quick-add). Mirrors `send()` but takes the text as an argument
  // instead of reading from `input` state.
  function sendText(text: string): void {
    const t = text.trim()
    if (!t) return
    if (busy) {
      pendingSendRef.current = true
      return
    }
    setError(null)
    setBusy(true)
    setMessages((prev) => [
      ...prev,
      { role: 'user', text: t },
      { role: 'assistant', text: '' },
    ])
    accumulatedTextRef.current = ''
    activeIdRef.current = window.api.chat.send(expandUserMacro(t), undefined)
  }


  /**
   * Voice input: toggle between idle / recording. When stopping, we
   * decode the MediaRecorder blob via AudioContext, resample to 16 kHz
   * mono Float32, ship to main for Whisper transcription, and put the
   * result into the chat input box (user can edit before Send).
   */
  /**
   * Quick screen-react — user clicks the 👀 button. Main captures all
   * displays, vision LLM comments in persona+tier voice, result lands
   * in chat as an assistant bubble via the existing proactive:remark
   * pipe (so TTS + emotion classifier + memory persistence all run
   * for free). Disabled while a previous call is in flight.
   */
  async function triggerQuickScreenReact(): Promise<void> {
    if (quickScreenBusy) return
    setQuickScreenBusy(true)
    try {
      const result = await window.api.chat.quickScreenReact()
      if (!result.ok) {
        // Show as a transient error — don't add an assistant bubble.
        setError(result.error)
        setTimeout(() => setError(null), 4000)
      }
      // On success the proactive:remark broadcast already added the
      // assistant bubble + ran TTS + classifier. Nothing more to do.
    } finally {
      setQuickScreenBusy(false)
    }
  }

  async function toggleVoiceInput(): Promise<void> {
    if (voiceState === 'transcribing') return // ignore mid-transcribe clicks
    if (voiceState === 'recording') {
      // Stop. The dataavailable handler set up at start time will fire
      // ondataavailable, then the onstop handler kicks off transcription.
      voiceRecorderRef.current?.stop()
      return
    }
    // Start.
    try {
      // Honor the user's mic preference if set. Empty string = OS default,
      // so we send `audio: true` rather than a deviceId constraint with
      // an empty value (which getUserMedia treats as "match nothing").
      const deviceId = config?.stt.deviceId
      const audioConstraint: MediaTrackConstraints | true = deviceId
        ? { deviceId: { exact: deviceId } }
        : true
      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint })
      voiceStreamRef.current = stream
      voiceChunksRef.current = []
      const rec = new MediaRecorder(stream)
      voiceRecorderRef.current = rec
      rec.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) voiceChunksRef.current.push(ev.data)
      }
      rec.onstop = async () => {
        // Release the mic immediately — keeping it open after stop shows
        // the OS recording indicator longer than necessary.
        voiceStreamRef.current?.getTracks().forEach((t) => t.stop())
        voiceStreamRef.current = null
        const blob = new Blob(voiceChunksRef.current, { type: rec.mimeType })
        voiceChunksRef.current = []
        if (blob.size === 0) {
          setVoiceState('idle')
          return
        }
        setVoiceState('transcribing')
        try {
          const samples = await decodeBlobTo16kMono(blob)
          if (samples.length < 800) {
            // <50ms of audio — almost certainly a misfire, not a real
            // utterance. Skip without flashing an error.
            setVoiceState('idle')
            return
          }
          const result = await window.api.stt.transcribe(samples)
          if (result.ok) {
            const text = result.text.trim()
            if (text) setInput((prev) => (prev ? prev + ' ' + text : text))
          } else {
            console.warn('[stt] transcribe failed:', result.error)
          }
        } catch (err) {
          console.warn('[stt] decode/transcribe error:', err)
        } finally {
          setVoiceState('idle')
        }
      }
      rec.start()
      setVoiceState('recording')
    } catch (err) {
      console.warn('[stt] mic permission denied or capture failed:', err)
      setVoiceState('idle')
    }
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

  // Background: persona-appropriate room image painted via CSS background
  // on the root container itself (NOT an absolute-positioned sibling — that
  // approach created a stacking context where chat / Live2D occasionally
  // rendered underneath, making the whole UI look "frozen"). Toggled via
  // a title-bar button → cfg.window.transparentBackground. Zoom multiplier
  // applies as a background-size percentage (>100% = closer-in crop).
  const showBackground = config ? !config.window.transparentBackground : true
  const backgroundUrl = config
    ? backgroundFor(config.persona.preset, config.window.customBackgrounds)
    : null
  const zoom = config?.window.backgroundZoom ?? 1

  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        // Window is `transparent: true, frame: false`. Root stays
        // transparent; the bg layer below paints the room image (with
        // independent zoom). Bottom-anchor pairs with Live2D's
        // bottom-anchor so the floor stays put across resizes.
        background: 'transparent',
        position: 'relative',
        // Without overflow:hidden, a zoom > 1 background layer would
        // visually leak outside the window edges.
        overflow: 'hidden',
        // Rounded outer frame. The BrowserWindow's actual rectangle
        // stays — corners are just transparent pixels showing the
        // desktop. Anything painted (top bar / bg layer / sidebar /
        // chat panel) gets clipped to this rounded shape. Result:
        // looks like a rounded card sitting on the desktop.
        borderRadius: 16,
      }}
    >
      {showBackground && backgroundUrl && (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            backgroundImage: `url("${backgroundUrl}")`,
            // Always `cover` here — zoom is applied via transform below
            // so we don't have to fight CSS background-size semantics
            // (which can't express "cover × multiplier" directly).
            backgroundSize: 'cover',
            backgroundPosition: 'center bottom',
            backgroundRepeat: 'no-repeat',
            backgroundColor: '#000',
            transform: `scale(${zoom})`,
            transformOrigin: 'center bottom',
            pointerEvents: 'none',
            zIndex: 0,
          }}
        />
      )}
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
          // Render above the bg layer.
          position: 'relative',
          zIndex: 1,
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
            dot={config?.tts.enabled ? '#3fb950' : '#888'}
            label={
              config?.tts.enabled
                ? config.tts.backend === 'sovits'
                  ? 'TTS · SoVITS'
                  : `TTS · ${shortVoiceLabel(config.tts.voice)}`
                : 'TTS off'
            }
            title={
              config?.tts.enabled
                ? config.tts.backend === 'sovits'
                  ? `GPT-SoVITS @ ${config.tts.sovits.baseUrl}（点击进设置）`
                  : `语音：${config.tts.voice}（点击进设置切换）`
                : 'TTS 未开启（点击进设置开启）'
            }
            onClick={() => setSettingsOpen(true)}
          />
        </div>
        <div style={{ ...noDragRegion, display: 'flex', gap: 6, alignItems: 'center' }}>
          {/* Proactive mute toggle. Persists immediately (no Settings
              round-trip) — "shut her up right now" is too common a
              reflex to bury in a 4-click navigation.
              Binary: mute ⇄ auto. The 'chatty' mode lives in Settings
              for users who explicitly opt in; the button's job is the
              urgent case. 🔕 = currently muted; 🔔 = she'll speak up. */}
          <button
            onClick={async () => {
              if (!config) return
              const next = config.proactive.mode === 'mute' ? 'auto' : 'mute'
              const direction: 'mute' | 'unmute' =
                next === 'mute' ? 'mute' : 'unmute'
              // Persist mode immediately so the engine state matches the
              // button visual even if the feedback line / TTS still fires
              // a tick later.
              void window.api.config.set({
                ...config,
                proactive: { ...config.proactive, mode: next },
              })
              // Score read for tier bucketing. Failure (no memory yet on a
              // fresh install) silently falls to 0, which lands in the
              // "low" bucket — appropriate for a stranger relationship.
              let score = 0
              try {
                const rec = await window.api.affinity.get()
                if (rec) score = rec.score
              } catch {
                /* keep 0 */
              }
              const line = pickMuteFeedback(
                linesRef.current ?? PRESET_LINES_DEFAULTS,
                config.persona.preset,
                direction,
                score,
                recentMuteLinesRef.current,
              )
              recentMuteLinesRef.current = [
                ...recentMuteLinesRef.current,
                line,
              ].slice(-3)
              // Inject as if she said it — display locally so the user
              // sees instant feedback (zero IPC latency).
              const idx = messagesRef.current.length
              setMessages((prev) => [...prev, { role: 'assistant', text: line }])
              // Mute direction → never speak (the user just asked for
              // silence; TTS-ing the "I'll be quiet" line is exactly the
              // wrong move). Unmute → speak if autoPlay is on.
              //
              // Fire TTS BEFORE the persist call so a missing
              // window.api.mute (e.g. running against an old preload
              // bundle in dev where the namespace hasn't been rebuilt
              // yet) can't kill the speech path. Both calls are
              // independent; do persist as best-effort.
              if (
                direction === 'unmute' &&
                config.tts.enabled &&
                config.tts.autoPlay
              ) {
                void speakRef.current(line, idx)
              }
              // Persist to memory via mute:announce so the NEXT user
              // reply has this turn in context — without it, "主人你
              // 回来了" → user replies "是啊我回来了" lands as a
              // dangling turn with no antecedent and her next response
              // gets confused. Best-effort; failure here only loses
              // context for ONE turn, not the whole feature.
              try {
                void window.api.mute?.announce(line)
              } catch (err) {
                console.warn('[mute] announce failed:', err)
              }
            }}
            title={
              config?.proactive.mode === 'mute'
                ? '她现在闭着嘴。点击让她可以主动开口'
                : config?.proactive.mode === 'chatty'
                  ? '多话模式 · 点击改成闭嘴'
                  : '自动模式（按好感度决定频率）· 点击改成闭嘴'
            }
            style={{
              width: 26,
              height: 22,
              border: 'none',
              borderRadius: 6,
              background:
                config?.proactive.mode === 'mute'
                  ? 'rgba(248,81,73,0.22)'
                  : 'rgba(0,0,0,0.18)',
              color: '#444',
              fontSize: 13,
              lineHeight: '22px',
              cursor: 'pointer',
              padding: 0,
              fontWeight: 600,
            }}
          >
            {config?.proactive.mode === 'mute' ? '🔕' : '🔔'}
          </button>
          {/* Background-mode toggle. Persists immediately (no Settings round-
              trip) so the user can flip it in 1 click. The icon flips:
              ◐ when bg is shown (suggesting "make me transparent"),
              ◯ when transparent (suggesting "give me a room back"). */}
          <button
            onClick={() => {
              if (!config) return
              void window.api.config.set({
                ...config,
                window: {
                  ...config.window,
                  transparentBackground: !config.window.transparentBackground,
                },
              })
            }}
            title={
              config?.window.transparentBackground
                ? '切换到房间背景'
                : '切换到透明背景'
            }
            style={{
              width: 26,
              height: 22,
              border: 'none',
              borderRadius: 6,
              background: 'rgba(0,0,0,0.18)',
              color: '#444',
              fontSize: 14,
              lineHeight: '22px',
              cursor: 'pointer',
              padding: 0,
              fontWeight: 600,
            }}
          >
            {config?.window.transparentBackground ? '◯' : '◐'}
          </button>
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
            title="关闭"
            style={{
              width: 20,
              height: 20,
              border: 'none',
              borderRadius: 10,
              background: 'rgba(0,0,0,0.25)',
              color: 'white',
              // The "×" / "✕" glyphs sit visually high above the
              // baseline in most fonts, so vertical lineHeight
              // centering looked off. Flex-center the glyph and use
              // ✕ (U+2715) which has a more rectangular bounding
              // box than × (U+00D7).
              fontSize: 12,
              cursor: 'pointer',
              padding: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Stage container — Live2D fills the FULL area below the status
          bar (chat panel does NOT carve out space from it). Chat panel
          overlays the bottom portion, so the model's lower body sits
          BEHIND the chat. This matches the desktop-companion-with-desk
          visual: she's standing in the room and the chat box covers
          her legs. */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', zIndex: 1 }}>
        {/* Live2D canvas — absolute inset 0 so it spans the entire
            stage container, including the area the chat panel covers.
            Model anchored at the bottom of THIS container = full window
            height (minus status bar), not just the visible-above-chat
            portion. */}
        <div style={{ position: 'absolute', inset: 0, zIndex: 1 }}>
          {config && modelUrl && (
            <Live2DCanvas
              ref={live2dRef}
              modelPath={modelUrl}
              fitMode="portrait"
              portraitZoom={config.live2d.portraitZoom}
              onCoverageChange={handleLive2DCoverage}
            />
          )}
        </div>
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
            zIndex: 2,
          }}
        >
          <button onClick={() => live2dRef.current?.randomExpression()}>随机表情</button>
          <button onClick={() => live2dRef.current?.clearExpression()}>回默认</button>
          <button onClick={() => live2dRef.current?.randomMotion()}>随机动作</button>
          <button onClick={() => live2dRef.current?.resetPosition()}>复位</button>
        </div>

        {/* Affinity badge — floats top-right of the Live2D area so the
            user can see relationship state at a glance even when the
            sidebar is collapsed. Updates live via the affinity:changed
            broadcast. */}
        <Live2DAffinityBadge />

        {/* Center-screen golden overlay for onboarding-milestone +5
            celebrations (first API key, first advanced TTS). Distinct
            from the small chip-side +N popup that fires on every
            judgement — this is "you just hit a major milestone" UX. */}
        <CelebrationOverlay />

        {/* Bottom-right pill prompting restart when a background update
            finishes downloading. Non-blocking, dismissable, doesn't
            interrupt whatever the user is doing. */}
        <UpdaterPill />

        {/* Screen-capture indicator — brief 📷 flash whenever main runs
            captureAllScreensPng (proactive observer, onboarding peek,
            quick-screen-react, chat screen tool). Privacy transparency:
            users SEE the moment their screen is sampled instead of
            having to trust a Settings toggle. */}
        <ScreenCaptureIndicator />

        {/* Demo-mode badge — visible when launched with --demo so the
            audience knows the data on screen (mail / tasks / facts /
            affinity) is synthetic, not real. */}
        <DemoModeBadge />

      {/* Chat panel — overlays the bottom of the stage container. zIndex
          2 puts it above the Live2D canvas (zIndex 1) so the model's
          lower body is genuinely covered by the chat card, not just
          clipped at the canvas edge. */}
      <div
        style={{
          ...noDragRegion,
          position: 'absolute',
          // Small inset on all sides so the chat panel reads as a
          // floating card with rounded corners, not a card glued to
          // the window edges. The transparent gap shows the desktop
          // beneath — that's the desktop-companion visual language.
          //
          // Right inset DEPENDS on sidebar state. Sidebar is flush
          // right: open=260px, closed=18px strip. Chat panel needs to
          // sit clear of whichever is showing, with 6px breathing
          // room so the rounded corners read.
          left: 6,
          right: sidebarOpen ? 266 : 24,
          bottom: 6,
          height: chatHeight,
          background: 'rgba(255, 255, 255, 0.88)',
          backdropFilter: 'blur(8px)',
          borderRadius: 16,
          display: 'flex',
          flexDirection: 'column',
          // fontFamily inherits from html — softer chain in index.html.
          overflow: 'hidden',
          boxShadow: '0 4px 24px rgba(0, 0, 0, 0.12)',
          zIndex: 2,
          // Smooth the sidebar open/close transition so the chat panel
          // glides rather than jumps when right edge changes.
          transition: 'right 0.2s ease-out',
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
            {memoryError && (
              <div
                style={{
                  fontSize: 11,
                  color: '#a55',
                  background: 'rgba(255, 200, 200, 0.5)',
                  padding: '4px 8px',
                  borderRadius: 4,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <span>⚠ {memoryError}</span>
                <button
                  onClick={() => setMemoryError(null)}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    color: '#a55',
                    cursor: 'pointer',
                    fontSize: 13,
                    padding: '0 4px',
                  }}
                >
                  ×
                </button>
              </div>
            )}

            {/* Naive-memory-mode banner. Persists until the embed model is
                downloaded. Becomes a progress bar during the download. */}
            {naiveMode && (
              <div
                style={{
                  fontSize: 11,
                  color: '#664',
                  background: 'rgba(255, 240, 180, 0.65)',
                  padding: '6px 10px',
                  borderRadius: 4,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                {downloadInProgress ? (
                  <>
                    <span style={{ flex: 1 }}>
                      正在下载嵌入模型 ({downloadProgress.file ?? '...'}) —{' '}
                      {downloadProgress.total > 0
                        ? `${Math.round((100 * downloadProgress.received) / downloadProgress.total)}%`
                        : `${(downloadProgress.received / 1_000_000).toFixed(1)} MB`}
                    </span>
                    <div
                      style={{
                        flex: '0 0 auto',
                        width: 100,
                        height: 6,
                        background: 'rgba(0,0,0,0.1)',
                        borderRadius: 3,
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          height: '100%',
                          background: '#cb9',
                          width:
                            downloadProgress.total > 0
                              ? `${(100 * downloadProgress.received) / downloadProgress.total}%`
                              : '20%',
                          transition: 'width 200ms ease-out',
                        }}
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <span style={{ flex: 1 }}>
                      💡 暂未启用长期记忆。下载嵌入模型（约 95 MB）后女仆能记住更久之前的事。
                    </span>
                    <button
                      onClick={() => {
                        void window.api.embed.download()
                      }}
                      style={{
                        padding: '3px 10px',
                        fontSize: 11,
                        background: '#cb9',
                        color: 'white',
                        border: 'none',
                        borderRadius: 3,
                        cursor: 'pointer',
                      }}
                    >
                      下载
                    </button>
                  </>
                )}
              </div>
            )}
            {messages.length === 0 && !busy && (
              <div style={{ color: '#999', fontSize: 12 }}>开始聊天吧 ✨</div>
            )}
            {messages.map((m, i) => (
              <MessageBubble
                key={i}
                message={m}
                busy={busy && i === messages.length - 1}
                ttsEnabled={config?.tts.enabled ?? false}
                speaking={speakingIdx === i}
                onSpeak={() => void speak(m.text, i)}
                onDraftIterate={(replyToUid, previousBody, feedback) => {
                  // Iterate the draft: send a chat turn that nudges the
                  // model to call draftEmailReply again with the
                  // previousDraft arg. The model picks up the cues
                  // (id + feedback) and routes through the same tool.
                  sendText(
                    `请重新拟一版回信。要回的邮件 id 是 ${replyToUid}。` +
                      `用户的修改意见：${feedback}\n\n` +
                      `上一版正文（请基于这版调整）：\n${previousBody}`,
                  )
                }}
              />
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

          {/* Cold-start prompt — visible when AI isn't configured yet.
              Without this the chat panel just shows hardcoded fallback
              replies + the maid keeps telling the user "去 Settings 配
              AI" via TTS, but there's no clickable affordance — they
              had to find the gear icon themselves. The banner is
              louder (orange + button) than the embedding-model banner
              because no-AI is a blocking state, not optional. */}
          {config && !config.backend.apiKey.trim() && (
            <div
              style={{
                ...noDragRegion,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 14px',
                marginBottom: 8,
                // Stronger amber backdrop + crisp text for the chat-
                // panel translucent background. The previous 0.12
                // alpha + '#ddc' text was washed out to the point of
                // being unreadable on the dark chat surface.
                background: 'rgba(255, 180, 80, 0.22)',
                border: '1px solid rgba(255, 180, 80, 0.65)',
                borderRadius: 6,
                fontSize: 12.5,
                color: '#ffe7c2',
                lineHeight: 1.5,
                fontWeight: 500,
              }}
            >
              <span style={{ fontSize: 16 }}>⚙</span>
              <span style={{ flex: 1 }}>
                还没配置 AI，她只能念预录台词。点右边配置后才能真正聊。
              </span>
              <button
                onClick={() => setSettingsOpen(true)}
                style={{
                  padding: '4px 12px',
                  fontSize: 11,
                  background: '#ffb950',
                  color: '#3a2a08',
                  border: 'none',
                  borderRadius: 4,
                  cursor: 'pointer',
                  fontWeight: 600,
                  flexShrink: 0,
                }}
              >
                立即配置 →
              </button>
            </div>
          )}

          {/* Quick-action chips — only visible when the input is empty.
              Once the user starts typing, they fade out (CSS) and the
              chat input takes the full space back. Discovery surface
              for tools the LLM has but new users don't know to ask
              about (mail / tasks / summary). Each chip is just a
              canned prompt that gets sent through the normal sendText
              path — no special wiring, no new IPC. */}
          {input.trim() === '' && (
            <div
              style={{
                ...noDragRegion,
                display: 'flex',
                flexWrap: 'wrap',
                gap: 6,
                marginBottom: 6,
                padding: '0 2px',
              }}
            >
              {[
                { emoji: '📧', label: '看邮件', text: '帮我看一下最近的邮件' },
                { emoji: '📋', label: '任务清单', text: '我现在有哪些任务？' },
                { emoji: '✨', label: '总结一下', text: '总结一下我们今天聊了什么' },
                { emoji: '🙂', label: '跟我聊聊', text: '跟我随便聊聊吧' },
              ].map((q) => (
                <button
                  key={q.label}
                  onClick={() => sendText(q.text)}
                  disabled={busy}
                  title={q.text}
                  style={{
                    padding: '4px 10px',
                    fontSize: 11,
                    background: 'rgba(120, 160, 255, 0.08)',
                    border: '1px solid rgba(120, 160, 255, 0.22)',
                    borderRadius: 14,
                    color: '#7aa',
                    cursor: busy ? 'not-allowed' : 'pointer',
                    opacity: busy ? 0.5 : 1,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  <span>{q.emoji}</span>
                  <span>{q.label}</span>
                </button>
              ))}
            </div>
          )}

          {/* Input row pinned to the bottom of the chat card. */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
            <button
              onClick={captureScreen}
              disabled={capturing || busy}
              title={`截屏给${config ? resolvePersona(config.persona).name : '她'}看（多屏自动全截，附在下一条消息）`}
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
            {config?.stt.enabled !== false && (
            <button
              onClick={toggleVoiceInput}
              disabled={voiceState === 'transcribing'}
              title={
                voiceState === 'recording'
                  ? '停止录音并转成文字'
                  : voiceState === 'transcribing'
                    ? '转写中…'
                    : '按住说话（再点一次停止）'
              }
              style={{
                ...noDragRegion,
                padding: '4px 8px',
                width: 32,
                background:
                  voiceState === 'recording'
                    ? 'rgba(255, 80, 80, 0.25)'
                    : voiceState === 'transcribing'
                      ? 'rgba(120, 160, 255, 0.25)'
                      : undefined,
                color: voiceState === 'recording' ? '#c00' : '#555',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {voiceState === 'transcribing' ? (
                '…'
              ) : voiceState === 'recording' ? (
                /* solid red dot */
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
                  <circle cx="7" cy="7" r="6" fill="currentColor" />
                </svg>
              ) : (
                /* mic outline */
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
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="23" />
                  <line x1="8" y1="23" x2="16" y2="23" />
                </svg>
              )}
            </button>
            )}
            <button
              onClick={() => void triggerQuickScreenReact()}
              disabled={quickScreenBusy}
              title="让她看一眼你的屏幕，主动评论一下"
              style={{
                ...noDragRegion,
                padding: '4px 8px',
                width: 32,
                background: quickScreenBusy
                  ? 'rgba(120, 160, 255, 0.25)'
                  : undefined,
                color: '#555',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 16,
                cursor: quickScreenBusy ? 'default' : 'pointer',
                opacity: quickScreenBusy ? 0.6 : 1,
              }}
            >
              {quickScreenBusy ? '…' : '👀'}
            </button>
            {/* Smaller placeholder font so rotating onboarding tips
                fit in narrow chat panels. Doesn't shrink user-typed
                text — only the ::placeholder pseudo-element. */}
            <style>{`
              .chat-input::placeholder {
                font-size: 11px;
                opacity: 0.7;
              }
            `}</style>
            <input
              className="chat-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onFocus={() => console.log('[diag] input FOCUS', new Date().toISOString())}
              onBlur={(e) => {
                const next = e.relatedTarget as HTMLElement | null
                console.log(
                  '[diag] input BLUR → next focus =',
                  next ? `${next.tagName}.${next.className || ''}` : '(none)',
                  'doc.activeElement now =',
                  document.activeElement?.tagName ?? 'null',
                  new Date().toISOString(),
                )
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
              placeholder={
                voiceState === 'recording'
                  ? '🎤 录音中…再点麦克风结束'
                  : voiceState === 'transcribing'
                    ? '正在转成文字…'
                    : busy
                      ? '女仆思考中…可以先写下一句'
                      : attachments.length
                      ? '可以加一句问她（也可以直接 Send）'
                      : // Idle: rotate onboarding tips so the empty input
                        // teaches features instead of staying blank.
                        ONBOARDING_TIPS[tipIdx] ?? ''
              }
              // minWidth: 0 is the unblock — without it, flex items default
              // to min-width: auto (= intrinsic content width), so when the
              // app gets narrow the input refuses to shrink below its
              // placeholder/value width, pushing the Send button off-screen
              // even though Send has flexShrink: 0. With minWidth: 0 the
              // input gives ground first and Send stays anchored.
              style={{ flex: 1, minWidth: 0, padding: '6px 10px', fontSize: 13 }}
            />
            <button
              onClick={send}
              disabled={!input.trim() && attachments.length === 0}
              title={busy ? '女仆还在回复，按发送会排队，等她说完自动发出' : '发送'}
              style={{
                padding: '6px 16px',
                background: '#5a8edf',
                color: '#fff',
                fontWeight: 600,
                fontSize: 13,
                borderRadius: 8,
                flexShrink: 0,
                marginRight: 2,
              }}
            >
              {busy ? '…' : '发送'}
            </button>
          </div>
        </div>
      </div>
      {/* end chat panel */}
      </div>
      {/* end stage container */}

      {/* Sidebar — live view of tasks (reminders + TODOs) + recent activity.
          Toggle hits main via `sidebar.setOpen` so the window grows/shrinks
          by 260px on the right; sidebar then fills the new space rather
          than overlapping existing chat content. */}
      <Sidebar
        open={sidebarOpen}
        onToggle={() => {
          const next = !sidebarOpen
          setSidebarOpen(next)
          void window.api.sidebar.setOpen(next)
        }}
        refreshActivityToken={activityRefreshToken}
        onSendChat={sendText}
      />

      {settingsOpen && config && (
        <Settings initial={config} onClose={() => setSettingsOpen(false)} />
      )}

      {/* First-run setup wizard. Sits above everything (z-index 2000),
          blocking interaction until the user either saves a key or skips. */}
      {wizardState === 'open' && config && (
        <SetupWizard
          initial={config}
          onSkip={async () => {
            // Persist completion even on skip — user made an explicit
            // choice to not configure now, don't keep re-prompting on
            // every launch.
            await window.api.config.set({
              ...config,
              onboarding: { ...config.onboarding, wizardCompleted: true },
            })
            setWizardState('dismissed')
          }}
          onSave={async (next) => {
            await window.api.config.set({
              ...next,
              onboarding: { ...next.onboarding, wizardCompleted: true },
            })
            setWizardState('dismissed')
          }}
        />
      )}

      {/* In-app confirm dialog — replaces window.confirm() to avoid the
          OS-level focus storm Chromium's native dialog triggers on
          transparent+frameless windows. See ./confirm.tsx for why. */}
      <ConfirmHost />
    </div>
  )
}

/**
 * Single label-and-optional-dot status item in the top bar. Whole pill is
 * clickable when an onClick is passed (we use that to deep-link into the
 * matching Settings tab). Text truncates with ellipsis on narrow windows.
 */
/**
 * Inline email-draft card rendered below an assistant message. Three
 * affordances: copy the body to clipboard, show the subject/recipient
 * for context, and an "improve" input that fires another LLM round
 * via the parent's `onIterate(feedback)` callback. New drafts for the
 * same email replace the prior card (no stacking) — that's handled in
 * the chat event handler upstream.
 */
function EmailDraftCard({
  draft,
  onIterate,
}: {
  draft: DraftCard
  onIterate: (feedback: string) => void
}) {
  const [copied, setCopied] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [iterOpen, setIterOpen] = useState(false)

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(draft.body)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard API may be denied in some Electron sandbox modes — ignore */
    }
  }

  function handleSubmitFeedback(): void {
    const f = feedback.trim()
    if (!f) return
    onIterate(f)
    setFeedback('')
    setIterOpen(false)
  }

  return (
    <div
      style={{
        marginTop: 6,
        border: '1px solid rgba(0, 0, 0, 0.12)',
        borderRadius: 8,
        background: 'rgba(255, 255, 255, 0.7)',
        fontSize: 12,
      }}
    >
      <div
        style={{
          padding: '6px 8px',
          borderBottom: '1px solid rgba(0,0,0,0.08)',
          fontSize: 11,
          color: '#555',
        }}
      >
        <div>
          <b>主题</b>：{draft.subject}
        </div>
        <div>
          <b>收件人</b>：{draft.to}
        </div>
      </div>
      <div
        style={{
          padding: '8px',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: 240,
          overflowY: 'auto',
          color: '#222',
          fontFamily: 'system-ui, sans-serif',
          lineHeight: 1.5,
        }}
      >
        {draft.body}
      </div>
      <div
        style={{
          display: 'flex',
          gap: 6,
          padding: '6px 8px',
          borderTop: '1px solid rgba(0,0,0,0.08)',
          alignItems: 'center',
        }}
      >
        <button
          onClick={handleCopy}
          style={{
            padding: '3px 10px',
            fontSize: 11,
            background: copied ? '#3fb950' : '#5a8edf',
            color: 'white',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          {copied ? '✓ 已复制' : '📋 复制正文'}
        </button>
        <button
          onClick={() => setIterOpen((v) => !v)}
          style={{
            padding: '3px 10px',
            fontSize: 11,
            background: 'rgba(0,0,0,0.06)',
            color: '#444',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          ✎ 改一版
        </button>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: '#999' }}>{draft.body.length} 字</span>
      </div>
      {iterOpen && (
        <div style={{ padding: '6px 8px', borderTop: '1px solid rgba(0,0,0,0.08)' }}>
          <div
            style={{
              display: 'flex',
              gap: 6,
              alignItems: 'flex-start',
            }}
          >
            <textarea
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleSubmitFeedback()
                }
              }}
              placeholder="比如：更简短 / 更正式 / 加一句确认时间 / 删掉客套话"
              rows={2}
              style={{
                flex: 1,
                fontSize: 11,
                padding: '4px 6px',
                border: '1px solid rgba(0,0,0,0.15)',
                borderRadius: 4,
                resize: 'vertical',
                fontFamily: 'inherit',
              }}
            />
            <button
              onClick={handleSubmitFeedback}
              disabled={!feedback.trim()}
              style={{
                padding: '3px 10px',
                fontSize: 11,
                background: feedback.trim() ? '#5a8edf' : 'rgba(0,0,0,0.1)',
                color: feedback.trim() ? 'white' : '#888',
                border: 'none',
                borderRadius: 4,
                cursor: feedback.trim() ? 'pointer' : 'default',
                whiteSpace: 'nowrap',
              }}
            >
              发
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Tier band edges (inclusive). Mirrors src/shared/affinity.ts but kept
 *  local to avoid a runtime import from the renderer just for one number. */
const TIER_BANDS: { label: string; min: number; max: number }[] = [
  { label: 'Lv.1', min: 0,  max: 19 },
  { label: 'Lv.2', min: 20, max: 39 },
  { label: 'Lv.3', min: 40, max: 59 },
  { label: 'Lv.4', min: 60, max: 79 },
  { label: 'Lv.5', min: 80, max: 100 },
]

function bandForScore(score: number): (typeof TIER_BANDS)[number] {
  return TIER_BANDS.find((b) => score >= b.min && score <= b.max) ?? TIER_BANDS[0]!
}

/**
 * Floating affinity readout pinned top-right of the Live2D pane. Shows
 *   - score + tier label
 *   - progress bar (% to next tier) — gives the early-game user a
 *     visible sense of "she's warming up" instead of just "current
 *     number". Without this, Lv.1 users see no signal that they're
 *     making progress and drop off
 *   - floating "+N" / "-N" popup on every judge / presence update, like
 *     MMO damage numbers — makes affinity gain a small dopamine moment
 *     rather than invisible bookkeeping
 *
 * Hover tooltip surfaces the last judge reason + exact score. Listens
 * to the affinity:changed broadcast so the chip updates the moment the
 * engine writes a new score (no settings round-trip required).
 */
function Live2DAffinityBadge() {
  const [info, setInfo] = useState<{
    score: number
    band: (typeof TIER_BANDS)[number]
    reason: string | null
  } | null>(null)
  // Ring of in-flight floating delta animations. Each gets a unique
  // id so React's diff keeps them stable as they animate; auto-removed
  // 1.4s after creation (matches the CSS animation duration).
  const [floaters, setFloaters] = useState<{ id: number; delta: number }[]>([])
  const floaterIdRef = useRef(0)

  const reload = async (): Promise<void> => {
    const rec = await window.api.affinity.get()
    if (!rec) return
    setInfo({
      score: rec.score,
      band: bandForScore(rec.score),
      reason: rec.lastReason,
    })
  }
  useEffect(() => {
    void reload()
    const offCh = window.api.affinity.onChanged((i) => {
      setInfo({
        score: i.score,
        band: bandForScore(i.score),
        reason: i.reason,
      })
      // Surface the +N / -N animation only when the engine actually
      // calculated a delta. Decay + dev override pass null → silent
      // update, by design.
      if (typeof i.delta === 'number' && Math.abs(i.delta) >= 0.5) {
        const id = ++floaterIdRef.current
        // Round so "+0.85" doesn't show as "+0.85" — display +1 / +2.
        // Sign is preserved.
        const rounded = i.delta > 0 ? Math.ceil(i.delta) : Math.floor(i.delta)
        setFloaters((prev) => [...prev, { id, delta: rounded }])
        setTimeout(() => {
          setFloaters((prev) => prev.filter((f) => f.id !== id))
        }, 1400)
      }
    })
    const offSw = window.api.affinity.onPersonaSwitched(() => void reload())
    return () => {
      offCh()
      offSw()
    }
  }, [])
  if (!info) return null

  // Progress within the current tier band (0..1). At score=100 the
  // user is at the top of Lv.5 — show the bar full.
  const bandWidth = info.band.max - info.band.min || 1
  const progress = Math.max(
    0,
    Math.min(1, (info.score - info.band.min) / bandWidth),
  )
  const isMaxTier = info.band.label === 'Lv.5'
  const toNext = isMaxTier ? null : info.band.max + 1 - info.score

  return (
    <div
      style={{
        position: 'absolute',
        top: 4,
        // Clear of the sidebar collapsed-strip (right:0, width:18,
        // zIndex:2) — without this margin the chip's last 10px get
        // covered.
        right: 24,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        // width: max-content so the column collapses to the chip's
        // natural width; the bar below sets width:100% to match. This
        // is what makes the bar exactly as wide as the chip — no more
        // "差一点点" offset.
        width: 'max-content',
        gap: 2,
        pointerEvents: 'auto',
        userSelect: 'none',
      }}
    >
      {/* Inline keyframes for the floating delta animation. Defined
          here (vs a global stylesheet) so this component is fully
          self-contained — no CSS file to thread through Vite. */}
      <style>{`
        @keyframes affinityFloat {
          0%   { opacity: 0; transform: translateY(0) scale(0.85); }
          15%  { opacity: 1; transform: translateY(-4px) scale(1.08); }
          80%  { opacity: 1; transform: translateY(-26px) scale(1); }
          100% { opacity: 0; transform: translateY(-34px) scale(0.95); }
        }
      `}</style>

      <div
        title={
          `${info.score.toFixed(2)} / 100\n` +
          `${info.band.label}（${info.band.min}-${info.band.max}）` +
          (toNext !== null ? `，离下一档还有 ${toNext.toFixed(1)} 分` : '·已封顶') +
          `\n${info.reason ?? '还没有判定记录'}`
        }
        style={{
          padding: '3px 8px',
          borderRadius: 999,
          background: 'rgba(0,0,0,0.45)',
          backdropFilter: 'blur(6px)',
          color: '#fff',
          fontSize: 11,
          fontFamily: 'system-ui, sans-serif',
          display: 'inline-flex',
          gap: 4,
          alignItems: 'center',
          position: 'relative',
        }}
      >
        <span style={{ color: '#f6a4b3' }}>❤️</span>
        <span>{Math.round(info.score)}</span>
        <span style={{ color: '#bbb', fontSize: 10 }}>· {info.band.label}</span>

        {/* Floating +N / -N animations. Absolute-positioned over the
            chip; auto-cleared after the CSS animation finishes. */}
        {floaters.map((f) => (
          <span
            key={f.id}
            style={{
              position: 'absolute',
              top: -2,
              right: 8,
              color: f.delta > 0 ? '#7be489' : '#f88',
              fontSize: 13,
              fontWeight: 700,
              textShadow: '0 1px 4px rgba(0,0,0,0.5)',
              pointerEvents: 'none',
              animation: 'affinityFloat 1.4s ease-out forwards',
            }}
          >
            {f.delta > 0 ? `+${f.delta}` : f.delta}
          </span>
        ))}
      </div>

      {/* Progress bar to next tier. Hidden at Lv.5 max (no "next" to
          aim at) — chip alone communicates "you made it". width:100%
          → stretches to match the chip above (parent is width:max-content
          + alignItems:stretch). */}
      {!isMaxTier && (
        <div
          style={{
            width: '100%',
            height: 3,
            borderRadius: 999,
            background: 'rgba(0,0,0,0.35)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${(progress * 100).toFixed(1)}%`,
              height: '100%',
              background: 'linear-gradient(90deg, #f6a4b3, #ffd3a2)',
              transition: 'width 0.4s ease-out',
            }}
          />
        </div>
      )}
    </div>
  )
}

/**
 * Big center-screen golden overlay fired when the user crosses an
 * onboarding milestone (first API key, first advanced TTS). Distinct
 * from the small chip-side floater that fires on every judgement —
 * this is "you just hit a major milestone" UX, deliberately disruptive
 * so the user notices and feels rewarded.
 *
 * Subscribes to `affinity:celebration` (main → renderer). On fire:
 *   - kind drives the subtitle ("AI 配置完成" / "声音模型升级")
 *   - amount renders as the headline ("+5 好感度")
 *   - 2.6s total animation: scale-in → linger → float-up + fade
 *   - non-blocking — pointer-events: none so clicks pass through
 *
 * Queues multiple celebrations if they fire in quick succession (e.g.
 * user pasted API key + switched TTS in one Save). Each plays in
 * sequence so the +5 / +5 reads as two distinct moments.
 */
function CelebrationOverlay() {
  const [queue, setQueue] = useState<
    { id: number; kind: 'ai' | 'tts'; amount: number }[]
  >([])
  const idRef = useRef(0)
  useEffect(() => {
    const off = window.api.affinity.onCelebration((info) => {
      const id = ++idRef.current
      setQueue((q) => [...q, { id, kind: info.kind, amount: info.amount }])
      // Auto-clear after one full animation cycle. We use the queue
      // tail's id rather than a static index so concurrent fires don't
      // step on each other's timers.
      setTimeout(() => {
        setQueue((q) => q.filter((c) => c.id !== id))
      }, 2600)
    })
    return off
  }, [])
  if (queue.length === 0) return null
  const active = queue[0]!
  const subtitle = active.kind === 'ai' ? 'AI 配置完成' : '声音模型升级'
  return (
    <>
      <style>{`
        @keyframes celebrationPop {
          0%   { opacity: 0; transform: translate(-50%, -50%) scale(0.6); }
          18%  { opacity: 1; transform: translate(-50%, -50%) scale(1.18); }
          32%  { opacity: 1; transform: translate(-50%, -50%) scale(1.0); }
          75%  { opacity: 1; transform: translate(-50%, -56%) scale(1.0); }
          100% { opacity: 0; transform: translate(-50%, -70%) scale(0.96); }
        }
        @keyframes celebrationGlow {
          0%, 100% { box-shadow: 0 0 40px rgba(255, 200, 80, 0.45); }
          50%      { box-shadow: 0 0 80px rgba(255, 220, 120, 0.7); }
        }
      `}</style>
      <div
        // Center the absolute child via top/left + transform translate
        // (-50%, -50%) — pure viewport center, no flex parent needed.
        // pointer-events: none so the chat panel beneath remains
        // interactive during the 2.6s celebration.
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'none',
          // Above sidebar (z:2) and chat panel (z:2) but under any
          // Settings modal (no fixed zIndex but layered on top by mount
          // order). 50 is safe headroom either way.
          zIndex: 50,
          animation: 'celebrationPop 2.6s cubic-bezier(0.2, 0.7, 0.3, 1) forwards',
        }}
        key={active.id}
      >
        <div
          style={{
            padding: '18px 32px 22px',
            borderRadius: 24,
            background:
              'linear-gradient(135deg, rgba(40,30,12,0.92), rgba(70,50,18,0.92))',
            border: '1px solid rgba(255, 215, 130, 0.55)',
            textAlign: 'center',
            animation: 'celebrationGlow 1.8s ease-in-out infinite',
            backdropFilter: 'blur(8px)',
          }}
        >
          <div
            style={{
              fontFamily: '"Times New Roman", "STSong", serif',
              fontWeight: 700,
              fontSize: 56,
              lineHeight: 1.0,
              // Gold gradient text. background-clip:text + transparent
              // color is the cross-browser way to fill glyphs.
              background:
                'linear-gradient(180deg, #ffe98a 0%, #d99a30 100%)',
              WebkitBackgroundClip: 'text',
              backgroundClip: 'text',
              color: 'transparent',
              textShadow: '0 2px 8px rgba(255, 200, 80, 0.35)',
              letterSpacing: 1,
              marginBottom: 6,
            }}
          >
            +{active.amount} 好感度
          </div>
          <div
            style={{
              fontFamily: 'system-ui, sans-serif',
              fontSize: 13,
              color: 'rgba(255, 230, 180, 0.85)',
              letterSpacing: 2,
            }}
          >
            {subtitle}
          </div>
        </div>
      </div>
    </>
  )
}

/**
 * Bottom-right banner for the auto-update lifecycle. Three states the
 * user can be in, each with its own affordance:
 *
 *   1. 'available' — main detected a new GitHub release. Banner says
 *      "发现新版本 v0.X.Y — 立即更新?" + 更新 button + ×. Click → moves
 *      to (2). Dismiss → banner hides, no download starts.
 *   2. 'downloading' — user consented; download in flight. Banner
 *      shows live "下载中 v0.X.Y · 23% · 8.4 MB/s" with a progress
 *      bar. No dismiss during download (the user already opted in;
 *      we'd just throw the bytes away).
 *   3. 'downloaded' — download complete. Banner says "v0.X.Y 已就绪
 *      — 立即重启" + restart button + ×. Click → quitAndInstall.
 *
 * We DO NOT auto-download (autoDownload=false in main). Surprise
 * 395 MB downloads on metered networks would be hostile. The banner's
 * 更新 button is the consent step.
 *
 * Dismissing 'available' clears state for the session; if the
 * periodic 6h check finds the same version again later, banner
 * reappears (cheap re-prompt; if user really doesn't want it they
 * stay on the dismiss).
 */
type UpdaterState =
  | { kind: 'hidden' }
  | { kind: 'available'; version: string }
  | {
      kind: 'downloading'
      version: string
      percent: number
      bytesPerSecond: number
    }
  | { kind: 'downloaded'; version: string }

function UpdaterPill() {
  const [state, setState] = useState<UpdaterState>({ kind: 'hidden' })
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    // Catch-up query — if an updater event already fired before this
    // component mounted (e.g. download completed during boot), main's
    // lastState replay lets us recover. v0.1.6 missed pill broadcasts
    // because there was no replay; queryState fixes it.
    void window.api.updater.queryState().then((s) => {
      if (s.kind === 'idle') return
      if (s.kind === 'available') {
        setState({ kind: 'available', version: s.version })
      } else if (s.kind === 'progress') {
        setState({
          kind: 'downloading',
          version: s.version,
          percent: s.percent,
          bytesPerSecond: s.bytesPerSecond,
        })
      } else if (s.kind === 'downloaded') {
        setState({ kind: 'downloaded', version: s.version })
      }
    })
    const offA = window.api.updater.onAvailable((info) => {
      setState({ kind: 'available', version: info.version })
    })
    const offP = window.api.updater.onProgress((info) => {
      setState((prev) => {
        // Use whatever version we currently know about. If we somehow
        // missed the 'available' event (rare race) fall back to '?'.
        const version =
          prev.kind === 'available' ||
          prev.kind === 'downloading' ||
          prev.kind === 'downloaded'
            ? prev.version
            : '?'
        return {
          kind: 'downloading',
          version,
          percent: info.percent,
          bytesPerSecond: info.bytesPerSecond,
        }
      })
    })
    const offD = window.api.updater.onDownloaded((info) => {
      setState({ kind: 'downloaded', version: info.version })
      setBusy(false)
    })
    return () => {
      offA()
      offP()
      offD()
    }
  }, [])

  if (state.kind === 'hidden') return null

  const styleBase: React.CSSProperties = {
    position: 'fixed',
    right: 16,
    bottom: 16,
    zIndex: 40,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 14px',
    background: 'rgba(40, 50, 70, 0.94)',
    border: '1px solid rgba(120, 160, 255, 0.45)',
    borderRadius: 8,
    boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
    backdropFilter: 'blur(8px)',
    color: '#eee',
    fontSize: 12,
    fontFamily: 'system-ui, sans-serif',
    maxWidth: 360,
  }

  if (state.kind === 'available') {
    return (
      <div style={styleBase}>
        <span style={{ fontSize: 16 }}>✨</span>
        <span style={{ flex: 1, lineHeight: 1.4 }}>
          发现新版本 <b>v{state.version}</b>，立即下载？
        </span>
        <button
          onClick={async () => {
            if (busy) return
            setBusy(true)
            try {
              await window.api.updater.download()
            } catch (err) {
              console.warn('[updater] download request failed:', err)
              setBusy(false)
            }
          }}
          disabled={busy}
          style={{
            padding: '4px 12px',
            fontSize: 11,
            background: '#5a8edf',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            cursor: busy ? 'wait' : 'pointer',
            fontWeight: 500,
          }}
        >
          {busy ? '准备中…' : '立即更新'}
        </button>
        <button
          onClick={() => setState({ kind: 'hidden' })}
          title="忽略本次。下次自动检查时如果还有更新会再提示"
          aria-label="dismiss"
          style={dismissBtnStyle}
        >
          ×
        </button>
      </div>
    )
  }

  if (state.kind === 'downloading') {
    const pct = Math.max(0, Math.min(100, state.percent))
    const mbps = state.bytesPerSecond / (1024 * 1024)
    return (
      <div style={{ ...styleBase, flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 16 }}>⬇</span>
          <span style={{ flex: 1, lineHeight: 1.4 }}>
            下载中 <b>v{state.version}</b>
          </span>
          <span style={{ fontSize: 11, color: '#aad4ff', fontFamily: 'monospace' }}>
            {pct.toFixed(0)}% · {mbps.toFixed(1)} MB/s
          </span>
        </div>
        <div
          style={{
            width: '100%',
            height: 4,
            background: 'rgba(255,255,255,0.08)',
            borderRadius: 2,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${pct}%`,
              height: '100%',
              background: 'linear-gradient(90deg, #5a8edf, #7ab8ff)',
              transition: 'width 200ms ease-out',
            }}
          />
        </div>
      </div>
    )
  }

  // state.kind === 'downloaded'
  return (
    <div style={styleBase}>
      <span style={{ fontSize: 16 }}>✓</span>
      <span style={{ flex: 1, lineHeight: 1.4 }}>
        新版本 <b>v{state.version}</b> 已就绪
      </span>
      <button
        onClick={async () => {
          if (busy) return
          setBusy(true)
          try {
            await window.api.updater.install()
          } catch (err) {
            console.warn('[updater] install request failed:', err)
            setBusy(false)
          }
        }}
        disabled={busy}
        style={{
          padding: '4px 12px',
          fontSize: 11,
          background: '#5a8edf',
          color: '#fff',
          border: 'none',
          borderRadius: 4,
          cursor: busy ? 'wait' : 'pointer',
          fontWeight: 500,
        }}
      >
        {busy ? '准备中…' : '立即重启'}
      </button>
      <button
        onClick={() => setState({ kind: 'hidden' })}
        title="本次会话不再提示（下次正常退出时自动安装）"
        aria-label="dismiss"
        style={dismissBtnStyle}
      >
        ×
      </button>
    </div>
  )
}

const dismissBtnStyle: React.CSSProperties = {
  width: 20,
  height: 20,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'transparent',
  border: 'none',
  color: '#888',
  fontSize: 16,
  lineHeight: 1,
  cursor: 'pointer',
  padding: 0,
  borderRadius: 4,
}

/**
 * Persistent "🎬 DEMO" pill in the top-left when launched with --demo.
 * Lets anyone watching a screen recording see immediately that the
 * mail / tasks / facts / affinity on display are synthetic, not real.
 * Stays visible the entire session — disappearing partway would be
 * misleading.
 */
function DemoModeBadge() {
  const [active, setActive] = useState(false)
  useEffect(() => {
    void window.api.app.isDemoMode().then(setActive)
  }, [])
  if (!active) return null
  return (
    <div
      title="演示模式：邮件/任务/事实/好感度都是假数据，不会污染真实安装"
      style={{
        // Top-center to avoid colliding with the top-left screen-
        // capture flash and the top-right affinity chip / Settings
        // gear. Hard to miss for anyone screen-recording.
        position: 'absolute',
        top: 8,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 25,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        background: 'rgba(120, 80, 200, 0.92)',
        color: '#fff',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
        pointerEvents: 'none',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <span style={{ fontSize: 13 }}>🎬</span>
      <span>DEMO</span>
    </div>
  )
}

/**
 * Brief 📷 flash whenever the main process captures the screen.
 * Privacy transparency — users SEE the moment their screen is sampled,
 * not just trust a config toggle. Each fire shows a small icon near
 * the top-left of the stage area for ~700ms then fades.
 *
 * Bumps a key on every new capture so a second capture during the
 * fade-out doesn't get swallowed — React remounts the inner element
 * with the new ts as key, re-running the animation from frame 0.
 */
function ScreenCaptureIndicator() {
  const [visible, setVisible] = useState<{ ts: string } | null>(null)
  useEffect(() => {
    const off = window.api.screen.onCaptured((info) => {
      setVisible(info)
      // Auto-clear after the animation duration. Subsequent captures
      // overwrite this timer naturally via the new info object.
      const myTs = info.ts
      setTimeout(() => {
        setVisible((cur) => (cur && cur.ts === myTs ? null : cur))
      }, 1200)
    })
    return off
  }, [])
  if (!visible) return null
  return (
    <>
      <style>{`
        @keyframes screenCaptureFlash {
          0%   { opacity: 0; transform: scale(0.7); }
          12%  { opacity: 1; transform: scale(1.15); }
          25%  { opacity: 1; transform: scale(1); }
          75%  { opacity: 1; transform: scale(1); }
          100% { opacity: 0; transform: scale(0.95); }
        }
      `}</style>
      <div
        key={visible.ts}
        title="她刚看了一眼屏幕"
        aria-label="她刚看了一眼屏幕"
        style={{
          position: 'absolute',
          top: 8,
          left: 8,
          zIndex: 30,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 10px',
          background: 'rgba(255, 180, 80, 0.92)',
          color: '#3a2a08',
          borderRadius: 999,
          fontSize: 11,
          fontWeight: 600,
          boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
          pointerEvents: 'none',
          animation: 'screenCaptureFlash 1.2s ease-out forwards',
        }}
      >
        <span style={{ fontSize: 13 }}>📷</span>
        <span>看了一眼</span>
      </div>
    </>
  )
}

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

function MessageBubble({
  message,
  busy,
  ttsEnabled,
  speaking,
  onSpeak,
  onDraftIterate,
}: {
  message: ChatMessage
  busy: boolean
  ttsEnabled: boolean
  speaking: boolean
  onSpeak: () => void
  /** Called when the user submits feedback on the inline draft card —
   *  parent (App) sends a new chat turn that re-runs draftEmailReply
   *  with the previous draft + the feedback. */
  onDraftIterate: (replyToUid: string, previousBody: string, feedback: string) => void
}) {
  const isUser = message.role === 'user'
  // Speaker button: only on assistant bubbles, only when TTS is enabled,
  // and only when the message has text (skip empty placeholder bubbles).
  const showSpeaker = !isUser && ttsEnabled && message.text.trim().length > 0
  // Work-turn marker. An assistant bubble with non-empty toolCalls is the
  // result of a productivity turn — the chat backend's `wasToolTurn`
  // gate applies, so this exchange does NOT move affinity and is filtered
  // out of long-term reflection. Surfacing a small 💼 next to the bubble
  // makes that boundary visible to the user (so they don't worry their
  // work chatter is "training her" the way personal chat is).
  //
  // Inclusion list lives in shared/work-tools.ts so the main-side
  // classifyTurnType and this UI flag agree. Earlier they diverged on
  // `presentTable`, causing iterative table-edit turns (e.g. "只列出
  // 广告" → only calls presentTable) to render without the 💼.
  const isWorkTurn =
    !isUser &&
    (message.toolCalls?.length ?? 0) > 0 &&
    message.toolCalls!.some((tc) => isWorkToolName(tc.name))
  // Strip markdown formatting from assistant text before display — the
  // model sometimes emits `**bold**` / `- bullets` / `# headers` and we
  // don't render markdown, so those would show as raw asterisks/hashes.
  // User messages stay raw (user might intentionally paste markdown).
  const visibleText = isUser ? message.text : stripMarkdown(message.text)
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        position: 'relative',
      }}
    >
      <div
        style={{
          maxWidth: '85%',
          padding: '6px 10px',
          borderRadius: 10,
          background: isUser ? 'rgba(120, 160, 255, 0.18)' : 'rgba(0, 0, 0, 0.05)',
          whiteSpace: 'pre-wrap',
          // Subtle outline pulse while speaking — confirms which bubble
          // owns the current audio when scrolling.
          outline: speaking ? '2px solid rgba(120, 200, 120, 0.55)' : 'none',
          outlineOffset: 1,
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
        {visibleText || (busy ? <span style={{ color: '#aaa' }}>thinking…</span> : '')}
        {showSpeaker && (
          <button
            onClick={onSpeak}
            title={speaking ? '停止朗读' : '朗读这条'}
            style={{
              marginLeft: 6,
              padding: '0 4px',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              // Bumped from 12/0.5 — at 12px + 50% opacity on a
              // rgba(0,0,0,0.05) bubble the speaker emoji was almost
              // invisible. 14px + 90% opacity lands "obviously a button"
              // without dominating the bubble.
              fontSize: 14,
              verticalAlign: 'middle',
              opacity: speaking ? 1 : 0.9,
            }}
          >
            {speaking ? '⏹' : '🔊'}
          </button>
        )}
        {isWorkTurn && (
          <span
            title="工作内容 · 不计入好感度 / 长期记忆"
            style={{
              marginLeft: 4,
              fontSize: 14,
              opacity: 0.75,
              cursor: 'help',
              verticalAlign: 'middle',
              userSelect: 'none',
            }}
            aria-label="work-turn"
          >
            💼
          </span>
        )}
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
        {message.draft && (
          <EmailDraftCard
            draft={message.draft}
            onIterate={(feedback) =>
              onDraftIterate(message.draft!.replyToUid, message.draft!.body, feedback)
            }
          />
        )}
      </div>
    </div>
  )
}
