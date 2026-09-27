/**
 * Local embedding host. Loads bge-small-zh-v1.5 via transformers.js once,
 * exposes embed(text): Promise<Float32Array>.
 *
 * Why local instead of cloud:
 *   - No API key, no per-call cost, no rate limits
 *   - Works offline + identical behavior in / out of China
 *   - Embedding-model lock-in problem dissolves (vectors never depend
 *     on which LLM provider the user picked for chat)
 *
 * The model is ~95MB, cached in <userData>/hf-cache on first run. First
 * load takes ~1-3s after that; per-embed call is ~30-200ms on CPU.
 */

import { app } from 'electron'
import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** bge-small-zh native dimension. Fixed; do not change without re-embedding. */
export const LOCAL_EMBED_DIM = 512
export const LOCAL_EMBED_MODEL = 'Xenova/bge-small-zh-v1.5'

/**
 * Every file the feature-extraction pipeline needs, relative to
 * `<root>/Xenova/bge-small-zh-v1.5/`. Shared with embed-download-host so
 * "what we download" and "what counts as installed" can't drift apart.
 *
 * `minBytes` is a floor that rejects obviously-truncated files. It is NOT
 * the completeness check for model.onnx — see LOCAL_EMBED_ONNX_BYTES.
 */
export const LOCAL_EMBED_FILES = [
  { path: 'config.json', minBytes: 100 },
  { path: 'tokenizer.json', minBytes: 100_000 },
  { path: 'tokenizer_config.json', minBytes: 100 },
  { path: 'onnx/model.onnx', minBytes: 50_000_000 },
] as const
export type LocalEmbedFile = (typeof LOCAL_EMBED_FILES)[number]

const ONNX_FILE = 'onnx/model.onnx'

/**
 * Exact size of the fp32 onnx/model.onnx on the HF `main` revision we've
 * downloaded since v0.0.14. model.onnx is always the LAST file written
 * and the only one big enough for a download to die halfway through, so
 * it's the one that needs an exact check: builds up to v0.3.5 streamed
 * it straight to its final path, and an interrupted download left a
 * truncated file that the old existence-only check treated as installed
 * (full mode on every launch, every embed failing).
 */
export const LOCAL_EMBED_ONNX_BYTES = 94_851_877

/**
 * Sidecar written by embed-download-host after it has verified each file
 * against the server's Content-Length. Lets a future upstream re-export
 * of model.onnx (different size than LOCAL_EMBED_ONNX_BYTES) still count
 * as complete without shipping a new constant.
 */
const VERIFIED_MANIFEST = '.openmeido-verified.json'

function readVerifiedManifest(modelDir: string): Record<string, number> {
  try {
    const parsed = JSON.parse(readFileSync(join(modelDir, VERIFIED_MANIFEST), 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {}
  } catch {
    return {}
  }
}

/** Record verified byte sizes (merged into any existing manifest). */
export function writeVerifiedManifest(modelDir: string, sizes: Record<string, number>): void {
  const merged = { ...readVerifiedManifest(modelDir), ...sizes }
  writeFileSync(join(modelDir, VERIFIED_MANIFEST), JSON.stringify(merged, null, 2))
}

/**
 * True when `file` under `modelDir` is present and complete. model.onnx
 * must match either the known size or the size the downloader verified;
 * the small JSON files only need to clear their floor (they're written
 * atomically and are useless truncated anyway — JSON.parse would throw).
 */
export function embedFileComplete(modelDir: string, file: LocalEmbedFile): boolean {
  let size: number
  try {
    size = statSync(join(modelDir, file.path)).size
  } catch {
    return false
  }
  if (size < file.minBytes) return false
  if (file.path !== ONNX_FILE) return true
  return size === LOCAL_EMBED_ONNX_BYTES || size === readVerifiedManifest(modelDir)[ONNX_FILE]
}

function hfCacheDir(): string {
  return join(app.getPath('userData'), 'hf-cache')
}

/**
 * Cheap synchronous check for whether a COMPLETE model is on disk
 * somewhere we can load it from. Memory-host uses this at boot to decide
 * between full mode and naive mode (see naive-memory docs), and its
 * isNaiveMemoryMode self-heal polls it — so it must never say yes to a
 * half-written download. Returns the root dir (the one containing
 * `Xenova/…`) when present, null otherwise.
 */
export function findBundledModel(): { path: string } | null {
  const candidates: string[] = []
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, 'models'))
  }
  // Dev only: repo-root models/. A packaged build's cwd is wherever the
  // shortcut / shell started it, so probing it would let a stray models/
  // dir there shadow the real one.
  if (!app.isPackaged) {
    candidates.push(join(process.cwd(), 'models'))
  }
  // userData/hf-cache catches users who already downloaded via the
  // in-app download flow (the naive→full upgrade path). This is the only
  // location in shipped builds since v0.0.14 stopped bundling the model.
  candidates.push(hfCacheDir())
  for (const dir of candidates) {
    const modelDir = join(dir, LOCAL_EMBED_MODEL)
    if (LOCAL_EMBED_FILES.every((f) => embedFileComplete(modelDir, f))) {
      return { path: dir }
    }
  }
  return null
}

/**
 * transformers.js keeps its loader config (`env.remoteHost`,
 * `env.allowRemoteModels`, `env.localModelPath`, …) in ONE process-global
 * object that the embed model here and Whisper in stt-host both use, and
 * it re-reads it for every file of a multi-file load. Two rules keep the
 * loaders from clobbering each other mid-download:
 *   1. Local-only loads pass `local_files_only` per call and never touch
 *      `env.allowRemoteModels` (flipping it false here used to kill an
 *      in-flight Whisper download with "allowRemoteModels=false").
 *   2. Loads that may hit the network go through this lock and set
 *      `allowRemoteModels` / `remoteHost` inside it, right before
 *      calling pipeline(), so one loader's mirror fallback can't swap the
 *      host under another's remaining files.
 */
let hfRemoteChain: Promise<void> = Promise.resolve()
export function withHfRemoteLoad<T>(fn: () => Promise<T>): Promise<T> {
  const run = hfRemoteChain.then(fn)
  hfRemoteChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null

/**
 * Mirrors used ONLY when no complete model is on disk (naive-mode
 * warmup, or a dev without models/). transformers.js fetches from
 * `env.remoteHost` and caches into env.cacheDir (userData/hf-cache).
 */
const HF_MIRRORS = ['https://huggingface.co', 'https://hf-mirror.com']

async function tryLoadExtractor(
  remoteHost: string,
  cacheDir: string,
): Promise<FeatureExtractionPipeline> {
  // Caller holds withHfRemoteLoad — safe to set the shared env here.
  env.allowRemoteModels = true
  env.remoteHost = remoteHost
  const t0 = Date.now()
  console.log(`[embed] loading ${LOCAL_EMBED_MODEL} via ${remoteHost}`)
  const p = await pipeline('feature-extraction', LOCAL_EMBED_MODEL, {
    dtype: 'fp32',
    cache_dir: cacheDir,
  })
  console.log(`[embed] loaded from ${remoteHost} in ${Date.now() - t0}ms`)
  return p as FeatureExtractionPipeline
}

function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (extractorPromise) return extractorPromise
  const cacheDir = hfCacheDir()
  mkdirSync(cacheDir, { recursive: true })
  env.cacheDir = cacheDir
  const bundled = findBundledModel()
  const attempt = (async (): Promise<FeatureExtractionPipeline> => {
    if (bundled) {
      // Happy path: a complete model on disk (the in-app download under
      // hf-cache, or a dev models/ dir). Local-only via the per-call flag
      // (see withHfRemoteLoad for why not env.allowRemoteModels=false),
      // so even a transient network blip can't touch our loading. No
      // lock: nothing here depends on remoteHost, and localModelPath is
      // only meaningful for this model.
      env.localModelPath = bundled.path
      env.allowLocalModels = true
      const t0 = Date.now()
      console.log(`[embed] loading ${LOCAL_EMBED_MODEL} from local ${bundled.path}`)
      const p = await pipeline('feature-extraction', LOCAL_EMBED_MODEL, {
        dtype: 'fp32',
        local_files_only: true,
        cache_dir: cacheDir,
      })
      console.log(`[embed] loaded from disk in ${Date.now() - t0}ms`)
      return p as FeatureExtractionPipeline
    }
    // Fallback path: no complete model on disk, let transformers.js pull
    // it (naive-mode warmup in memory-host relies on this).
    console.warn(`[embed] no complete local model, falling back to remote`)
    return withHfRemoteLoad(async () => {
      let lastErr: unknown
      for (const host of HF_MIRRORS) {
        try {
          return await tryLoadExtractor(host, cacheDir)
        } catch (err) {
          lastErr = err
          console.warn(`[embed] ${host} failed:`, err instanceof Error ? err.message : err)
        }
      }
      throw lastErr ?? new Error('all embed mirrors failed')
    })
  })()
  // Clear the cached promise on rejection so the next call retries
  // instead of returning the same rejection forever.
  attempt.catch(() => {
    if (extractorPromise === attempt) extractorPromise = null
  })
  extractorPromise = attempt
  return extractorPromise
}

/**
 * Embed a single string. bge models want CLS pooling + L2 normalization,
 * which is what the pipeline does with these options.
 */
export async function embedLocal(text: string): Promise<Float32Array> {
  const extractor = await getExtractor()
  const out = await extractor(text, { pooling: 'cls', normalize: true })
  // out.data is a tensor-backed TypedArray view; copy into a fresh
  // Float32Array so the caller can keep it past the next call.
  return Float32Array.from(out.data as ArrayLike<number>)
}

/**
 * Preload the model in the background so the first embed call doesn't
 * pay the cold-start cost during a real user interaction.
 */
export function preloadLocalEmbed(): void {
  void getExtractor().catch((err) => {
    console.warn('[embed] preload failed:', err)
  })
}
