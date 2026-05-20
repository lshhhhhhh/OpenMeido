import { useEffect, useRef, useState } from 'react'

import type { ChatEvent, ChatImageAttachment } from '../../shared/ipc'
import { resolvePersona } from '../../shared/config'
import { Live2DCanvas } from './live2d/Live2DCanvas'
import type { Live2DController, Coverage } from './live2d/stage'
import { playMp3Base64, type PlayHandle } from './tts/player'
import { Settings } from './Settings'
import { SetupWizard } from './SetupWizard'
import { Sidebar } from './Sidebar'
import { useConfig } from './useConfig'
import { ConfirmHost } from './confirm'
import { matchHotkey } from '../../shared/demos'
import { stripMarkdown } from '../../shared/strip-markdown'

interface ToolCall {
  name: string
  args: unknown
  result?: unknown
}

interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
  /** Data URLs of attached images (one per screen, plus future paste/drop). */
  imageDataUrls?: string[]
  toolCalls?: ToolCall[]
}

// `-webkit-app-region` isn't in @types/react's CSSProperties yet. Bridge it.
type AppRegionStyle = React.CSSProperties & { WebkitAppRegion?: 'drag' | 'no-drag' }

const DEFAULT_CHAT_HEIGHT = 180
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
  const [chatHeight, setChatHeight] = useState(DEFAULT_CHAT_HEIGHT)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Pending attachments for the NEXT send. Cleared after send fires.
  const [attachments, setAttachments] = useState<ChatImageAttachment[]>([])
  const [capturing, setCapturing] = useState(false)
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
  // hasn't dismissed within this session yet, pop the wizard.
  //
  // Only runs once per mount — once dismissed, the user can re-trigger by
  // clearing apiKey + restarting, or just use Settings → AI directly.
  useEffect(() => {
    if (!config) return
    if (wizardState !== 'checking') return
    let canceled = false
    void window.api.chat.test(config.backend).then((r) => {
      if (canceled) return
      setWizardState(r.ok ? 'dismissed' : 'open')
    })
    return () => {
      canceled = true
    }
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
  const handleLive2DCoverage = (cov: Coverage): void => {
    if (!config?.window.clickThroughTransparent) {
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
    activeIdRef.current = window.api.chat.send(text, attachments.length ? attachments : undefined)
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
    activeIdRef.current = window.api.chat.send(t, undefined)
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

  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        // Window is `transparent: true, frame: false`, so the whole root must
        // also be transparent to let the desktop show through.
        background: 'transparent',
      }}
    >
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
            title="Close"
            style={{
              width: 20,
              height: 20,
              border: 'none',
              borderRadius: 10,
              background: 'rgba(0,0,0,0.25)',
              color: 'white',
              fontSize: 13,
              lineHeight: '20px',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            ×
          </button>
        </div>
      </div>

      {/* Live2D stage — fills the bulk of the window, transparent BG so the
          desktop shows through everywhere except where the character renders. */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {config && modelUrl && (
          <Live2DCanvas
            ref={live2dRef}
            modelPath={modelUrl}
            fitMode="portrait"
            portraitZoom={config.live2d.portraitZoom}
            onCoverageChange={handleLive2DCoverage}
          />
        )}
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
          }}
        >
          <button onClick={() => live2dRef.current?.randomExpression()}>随机表情</button>
          <button onClick={() => live2dRef.current?.clearExpression()}>清</button>
          <button onClick={() => live2dRef.current?.randomMotion()}>随机动作</button>
          <button onClick={() => live2dRef.current?.resetPosition()}>复位</button>
        </div>
      </div>

      {/* Chat panel — translucent card at the bottom, no-drag so the input
          and buttons receive normal clicks instead of starting a window drag.
          Height is controlled by chatHeight + the resize strip below.
          Rounded top corners make the top edge look like an intentional card
          boundary, not a frame. */}
      <div
        style={{
          ...noDragRegion,
          flex: '0 0 auto',
          height: chatHeight,
          background: 'rgba(255, 255, 255, 0.88)',
          backdropFilter: 'blur(8px)',
          borderRadius: '14px 14px 0 0',
          display: 'flex',
          flexDirection: 'column',
          fontFamily: 'system-ui, sans-serif',
          overflow: 'hidden',
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

          {/* Input row pinned to the bottom of the chat card. */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
            <button
              onClick={captureScreen}
              disabled={capturing || busy}
              title="截屏给妹妹看（多屏自动全截）"
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
            <input
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
                busy
                  ? '女仆思考中…可以先写下一句'
                  : attachments.length
                  ? '可以加一句问她（也可以直接 Send）'
                  : '试试：提醒我五分钟后喝水'
              }
              style={{ flex: 1, padding: '6px 10px', fontSize: 13 }}
            />
            <button
              onClick={send}
              disabled={!input.trim() && attachments.length === 0}
              title={busy ? '女仆还在回复，按 Send 会排队，等她说完自动发出' : 'Send'}
              style={{ padding: '6px 14px' }}
            >
              {busy ? '…' : 'Send'}
            </button>
          </div>
        </div>
      </div>

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
          onSkip={() => setWizardState('dismissed')}
          onSave={async (next) => {
            await window.api.config.set(next)
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
}: {
  message: ChatMessage
  busy: boolean
  ttsEnabled: boolean
  speaking: boolean
  onSpeak: () => void
}) {
  const isUser = message.role === 'user'
  // Speaker button: only on assistant bubbles, only when TTS is enabled,
  // and only when the message has text (skip empty placeholder bubbles).
  const showSpeaker = !isUser && ttsEnabled && message.text.trim().length > 0
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
              fontSize: 12,
              verticalAlign: 'middle',
              opacity: speaking ? 1 : 0.5,
            }}
          >
            {speaking ? '⏹' : '🔊'}
          </button>
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
      </div>
    </div>
  )
}
