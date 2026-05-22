/**
 * Renderer-side TTS playback + Live2D lip-sync amplitude extraction.
 *
 * Flow:
 *   1. Main synthesizes MP3 bytes via msedge-tts, sends as base64.
 *   2. We decode via Web Audio AudioContext.decodeAudioData.
 *   3. Play the decoded buffer through a gain + AnalyserNode chain.
 *   4. On each RAF tick during playback, read time-domain samples from
 *      the analyser, compute RMS, multiply by gain, clamp to [0, 1],
 *      and call onMouth(value).
 *
 * The AnalyserNode is preferable to manually decoding PCM frames because
 * it tracks playback position automatically — when we read samples, we
 * get the audio that's about to leave the speakers, which keeps the
 * mouth motion in sync with what the user is hearing.
 */

export interface PlayOptions {
  /** Multiplier on the raw RMS (typically 0..0.3 for speech) to produce mouth-open 0..1. */
  mouthGain?: number
  /** Called every animation frame with the current mouth-open value. */
  onMouth?: (value: number) => void
  /** Called when playback ends or is cancelled. */
  onEnd?: () => void
}

export interface PlayHandle {
  /** Cancel playback. Safe to call after natural end (no-op). */
  stop(): void
  /** Resolves when playback finishes naturally OR is stopped. */
  done: Promise<void>
}

let sharedCtx: AudioContext | null = null

function getCtx(): AudioContext {
  // Lazy-init the AudioContext. We pair this with main.ts's
  // `--autoplay-policy=no-user-gesture-required` switch so the
  // first audio at launch (greeting TTS) actually plays from the
  // beginning instead of being held until the user first clicks.
  if (sharedCtx && sharedCtx.state !== 'closed') return sharedCtx
  sharedCtx = new AudioContext({ sampleRate: 24000 })
  return sharedCtx
}

/**
 * Pre-create the shared AudioContext at renderer mount so the first
 * playback (often the boot greeting) doesn't pay both the construction
 * cost AND the autoplay-resume cost in the same frame. Safe to call
 * repeatedly — idempotent on an already-open context.
 */
export function warmupAudioContext(): void {
  try {
    const ctx = getCtx()
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
  } catch (err) {
    console.warn('[tts] warmup failed:', err)
  }
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64)
  const buf = new ArrayBuffer(bin.length)
  const view = new Uint8Array(buf)
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i)
  return buf
}

/**
 * Decode + play. Returns immediately with a handle; the `done` promise
 * resolves when playback completes or stop() is called.
 */
export async function playMp3Base64(b64: string, opts: PlayOptions = {}): Promise<PlayHandle> {
  const gain = opts.mouthGain ?? 3.5
  const ctx = getCtx()
  if (ctx.state === 'suspended') {
    // Some platforms suspend on tab switch; this is harmless on success.
    await ctx.resume().catch(() => {})
  }
  const bytes = base64ToArrayBuffer(b64)
  const audio = await ctx.decodeAudioData(bytes)

  const source = ctx.createBufferSource()
  source.buffer = audio
  const analyser = ctx.createAnalyser()
  // 1024 samples gives ~42ms windows at 24kHz — close to imouto-oss's 50ms
  // envelope, fine enough to look like lip-sync without overdriving Live2D.
  analyser.fftSize = 1024
  source.connect(analyser)
  analyser.connect(ctx.destination)

  const sampleBuf = new Float32Array(analyser.fftSize)
  let raf = 0
  let stopped = false
  let resolveDone!: () => void
  const done = new Promise<void>((r) => {
    resolveDone = r
  })

  const tick = (): void => {
    if (stopped) return
    analyser.getFloatTimeDomainData(sampleBuf)
    let sumSq = 0
    for (let i = 0; i < sampleBuf.length; i++) {
      const v = sampleBuf[i]!
      sumSq += v * v
    }
    const rms = Math.sqrt(sumSq / sampleBuf.length)
    const mouth = Math.max(0, Math.min(1, rms * gain))
    opts.onMouth?.(mouth)
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)

  source.onended = (): void => {
    if (stopped) return
    stopped = true
    cancelAnimationFrame(raf)
    opts.onMouth?.(0)
    opts.onEnd?.()
    resolveDone()
  }

  source.start()

  return {
    stop(): void {
      if (stopped) return
      stopped = true
      cancelAnimationFrame(raf)
      try {
        source.stop()
      } catch {
        /* already stopped — ignore */
      }
      try {
        source.disconnect()
        analyser.disconnect()
      } catch {
        /* harmless */
      }
      opts.onMouth?.(0)
      opts.onEnd?.()
      resolveDone()
    },
    done,
  }
}
