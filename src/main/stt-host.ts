/**
 * Local speech-to-text host. Loads Whisper via transformers.js (already a
 * dep for the embedding model), runs offline, no cloud key required.
 *
 * Why not the browser Web Speech API: it routes through Google STT which
 * is blocked in mainland China. Why not OpenAI Whisper API: per-call cost
 * + same access issue. Local Whisper handles Chinese well (whisper-base
 * is 74MB and gives accurate zh-CN transcripts in ~1-3s per ~10s clip).
 *
 * Loading discipline matches local-embed: lazy on first call, cached in
 * `<userData>/hf-cache` so a second launch doesn't re-download. Failure
 * clears the cached promise so the next call retries instead of
 * returning the same rejection forever.
 */

import { app, BrowserWindow } from 'electron'
import { pipeline, env, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * whisper-base is the sweet spot: ~74 MB, ~5x faster than -small, still
 * good Chinese accuracy. -tiny (39 MB) loses too much; -small (244 MB)
 * is overkill for chat-length utterances.
 */
const STT_MODEL = 'Xenova/whisper-base'
/** Whisper expects 16 kHz mono PCM. Callers must resample before passing. */
export const STT_SAMPLE_RATE = 16_000

let transcriberPromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null

const HF_MIRRORS = ['https://huggingface.co', 'https://hf-mirror.com']

/**
 * Cheap check for whether the whisper model files are already on disk
 * — used by status IPC + the "downloaded?" indicator in Settings.
 * transformers.js writes per-file blobs into a sharded cache:
 *   <userData>/hf-cache/Xenova/whisper-base/onnx/encoder_model.onnx
 *   <userData>/hf-cache/Xenova/whisper-base/onnx/decoder_model_merged.onnx
 * If both ONNX files exist and look non-empty, the model is usable.
 */
export function findSttModel(): { path: string } | null {
  const base = join(app.getPath('userData'), 'hf-cache', STT_MODEL)
  const encoder = join(base, 'onnx', 'encoder_model.onnx')
  const decoder = join(base, 'onnx', 'decoder_model_merged.onnx')
  if (!existsSync(encoder) || !existsSync(decoder)) return null
  try {
    if (statSync(encoder).size < 1_000_000) return null
    if (statSync(decoder).size < 10_000_000) return null
  } catch {
    return null
  }
  return { path: base }
}

interface DownloadState {
  inProgress: boolean
  totalBytes: number
  receivedBytes: number
  currentFile: string | null
}

const downloadState: DownloadState = {
  inProgress: false,
  totalBytes: 0,
  receivedBytes: 0,
  currentFile: null,
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

export function getSttStatus(): DownloadState & { modelPresent: boolean } {
  return { ...downloadState, modelPresent: !!findSttModel() }
}

/**
 * transformers.js progress callback shape. We don't import their types
 * (they aren't fully exported); we narrow inline.
 */
interface ProgressEvent {
  status: 'initiate' | 'download' | 'progress' | 'done' | 'ready'
  file?: string
  loaded?: number
  total?: number
}

async function tryLoad(remoteHost: string): Promise<AutomaticSpeechRecognitionPipeline> {
  env.remoteHost = remoteHost
  const t0 = Date.now()
  console.log(`[stt] loading ${STT_MODEL} via ${remoteHost}`)
  // Track per-file bytes so the renderer can show aggregate progress.
  // transformers.js emits 'progress' events with loaded/total bytes per
  // file; we sum across files. 'done' on the final file finishes the bar.
  const perFile = new Map<string, { loaded: number; total: number }>()
  const handleProgress = (ev: ProgressEvent): void => {
    if (!ev.file) return
    if (ev.status === 'progress') {
      perFile.set(ev.file, { loaded: ev.loaded ?? 0, total: ev.total ?? 0 })
      let recv = 0
      let total = 0
      for (const v of perFile.values()) {
        recv += v.loaded
        total += v.total
      }
      downloadState.receivedBytes = recv
      downloadState.totalBytes = total
      downloadState.currentFile = ev.file
      broadcast('stt:downloadProgress', { ...downloadState })
    } else if (ev.status === 'done' && ev.file) {
      // Pin to 100% for this file so the bar doesn't backslide.
      const e = perFile.get(ev.file)
      if (e && e.total > 0) e.loaded = e.total
    }
  }
  const p = await pipeline('automatic-speech-recognition', STT_MODEL, {
    dtype: 'fp32',
    progress_callback: handleProgress,
  } as unknown as Parameters<typeof pipeline>[2])
  console.log(`[stt] loaded from ${remoteHost} in ${Date.now() - t0}ms`)
  return p as AutomaticSpeechRecognitionPipeline
}

function getTranscriber(): Promise<AutomaticSpeechRecognitionPipeline> {
  if (transcriberPromise) return transcriberPromise
  const cacheDir = join(app.getPath('userData'), 'hf-cache')
  mkdirSync(cacheDir, { recursive: true })
  env.cacheDir = cacheDir
  env.allowRemoteModels = true
  // Mark "downloading" before we start so the UI can show a spinner from
  // the moment the user taps mic / clicks "下载". cleared on success or
  // failure below.
  const modelAlreadyPresent = !!findSttModel()
  if (!modelAlreadyPresent) {
    downloadState.inProgress = true
    downloadState.receivedBytes = 0
    downloadState.totalBytes = 0
    downloadState.currentFile = null
    broadcast('stt:downloadProgress', { ...downloadState })
  }
  const attempt = (async (): Promise<AutomaticSpeechRecognitionPipeline> => {
    let lastErr: unknown
    for (const host of HF_MIRRORS) {
      try {
        const p = await tryLoad(host)
        downloadState.inProgress = false
        if (!modelAlreadyPresent) {
          broadcast('stt:downloadComplete', { ok: true })
        }
        return p
      } catch (err) {
        lastErr = err
        console.warn(`[stt] ${host} failed:`, err instanceof Error ? err.message : err)
      }
    }
    downloadState.inProgress = false
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'unknown')
    if (!modelAlreadyPresent) {
      broadcast('stt:downloadComplete', { ok: false, error: msg })
    }
    throw lastErr ?? new Error('all whisper mirrors failed')
  })()
  attempt.catch(() => {
    if (transcriberPromise === attempt) transcriberPromise = null
  })
  transcriberPromise = attempt
  return transcriberPromise
}

/** Triggered by the Settings → 语音 panel "下载语音模型" button. Just
 *  calls getTranscriber() — the same code path that lazy-loads on first
 *  use, so the broadcasts in there drive the UI either way. */
export function startSttDownload(): Promise<{ ok: true } | { ok: false; error: string }> {
  return getTranscriber().then(
    () => ({ ok: true as const }),
    (err) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }),
  )
}

/**
 * Transcribe raw audio samples. `samples` must be Float32 PCM in the
 * range [-1, 1]. `samplingRate` defaults to 16 kHz (Whisper's native);
 * other rates work but transformers.js will resample internally so it's
 * cheaper to pre-resample upstream if you can.
 *
 * `language` defaults to "chinese" — Whisper has its own ISO names; the
 * full set is in the model's tokenizer config. Callers can pass any
 * Whisper-recognized language string ("english", "japanese", etc.) when
 * the user has set a non-default UI language; for now we let it default.
 */
export async function transcribeSamples(
  samples: Float32Array,
  samplingRate: number = STT_SAMPLE_RATE,
  language: string = 'chinese',
): Promise<string> {
  const transcriber = await getTranscriber()
  // The pipeline expects raw Float32Array at Whisper's native 16 kHz.
  // We DON'T wrap in {data, sampling_rate} — that shape was for older
  // transformers.js versions; current build errors with "expects input
  // to be a Float32Array or Float64Array, but got Object". Callers
  // must pre-resample to 16 kHz; we throw loudly if they didn't.
  if (samplingRate !== STT_SAMPLE_RATE) {
    throw new Error(
      `stt: samples must be ${STT_SAMPLE_RATE} Hz; got ${samplingRate}. ` +
        `Resample upstream before calling transcribeSamples.`,
    )
  }
  const result = (await transcriber(samples, {
    language,
    task: 'transcribe',
  } as unknown as Record<string, never>)) as { text?: string } | { text?: string }[]
  // pipeline returns either an object or array depending on input; we
  // pass a single sample so it's the singular shape.
  const text = Array.isArray(result) ? (result[0]?.text ?? '') : (result.text ?? '')
  return text.trim()
}

/** Preload in the background so first user-triggered transcription
 *  doesn't pay the cold-load cost mid-interaction. */
export function preloadStt(): void {
  void getTranscriber().catch((err) => {
    console.warn('[stt] preload failed:', err)
  })
}
