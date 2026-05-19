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
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** bge-small-zh native dimension. Fixed; do not change without re-embedding. */
export const LOCAL_EMBED_DIM = 512
export const LOCAL_EMBED_MODEL = 'Xenova/bge-small-zh-v1.5'

/**
 * Cheap synchronous check for whether the bundled model files are on
 * disk somewhere we can load them from. Memory-host uses this at boot
 * to decide between full mode and naive mode (see naive-memory docs).
 * Returns the resolved path when present, null otherwise.
 */
export function findBundledModel(): { path: string } | null {
  const candidates: string[] = []
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, 'models'))
  }
  candidates.push(join(process.cwd(), 'models'))
  // userData/hf-cache catches users who already downloaded via the
  // in-app download flow (the new naive→full upgrade path).
  candidates.push(join(app.getPath('userData'), 'hf-cache'))
  for (const dir of candidates) {
    if (existsSync(join(dir, LOCAL_EMBED_MODEL, 'onnx', 'model.onnx'))) {
      return { path: dir }
    }
  }
  return null
}

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null

/**
 * Resolve where to load model files from.
 *   - In prod: bundled under `<resourcesPath>/models/` (see
 *     electron-builder.yml extraResources). transformers.js's
 *     `localModelPath` plus `allowRemoteModels=false` makes the loader
 *     read directly from disk and never reach out to huggingface.co.
 *   - In dev: same `models/` dir but relative to the repo root. Same
 *     local-only behavior so devs and shipped builds behave identically.
 *
 * Falls back to remote loading ONLY if the bundled files aren't on disk
 * (e.g. someone ran the build without the models/ dir present). Remote
 * is a developer escape hatch, not a user-facing path — shipped builds
 * always have the bundle.
 */
function resolveModelLocation(): { localPath: string | null } {
  const candidates: string[] = []
  // Production: app is packaged, resourcesPath points at <install>/resources
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, 'models'))
  }
  // Dev: vite serves from project root; cwd is project root.
  candidates.push(join(process.cwd(), 'models'))
  for (const dir of candidates) {
    // The full model dir has the .onnx file under Xenova/<name>/onnx/.
    // If that's missing, the bundle wasn't shipped properly.
    if (existsSync(join(dir, LOCAL_EMBED_MODEL, 'onnx', 'model.onnx'))) {
      return { localPath: dir }
    }
  }
  return { localPath: null }
}

/**
 * Mirrors used ONLY when the bundle is missing (dev without models/ dir,
 * or a corrupted install). transformers.js fetches from `env.remoteHost`.
 */
const HF_MIRRORS = ['https://huggingface.co', 'https://hf-mirror.com']

async function tryLoadExtractor(remoteHost: string): Promise<FeatureExtractionPipeline> {
  env.remoteHost = remoteHost
  const t0 = Date.now()
  console.log(`[embed] loading ${LOCAL_EMBED_MODEL} via ${remoteHost}`)
  const p = await pipeline('feature-extraction', LOCAL_EMBED_MODEL, {
    dtype: 'fp32',
  })
  console.log(`[embed] loaded from ${remoteHost} in ${Date.now() - t0}ms`)
  return p as FeatureExtractionPipeline
}

function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (extractorPromise) return extractorPromise
  const cacheDir = join(app.getPath('userData'), 'hf-cache')
  mkdirSync(cacheDir, { recursive: true })
  env.cacheDir = cacheDir
  const { localPath } = resolveModelLocation()
  const attempt = (async (): Promise<FeatureExtractionPipeline> => {
    if (localPath) {
      // Happy path: bundled model on disk. Force local-only so even a
      // transient network blip can't touch our loading.
      env.localModelPath = localPath
      env.allowLocalModels = true
      env.allowRemoteModels = false
      const t0 = Date.now()
      console.log(`[embed] loading ${LOCAL_EMBED_MODEL} from bundled ${localPath}`)
      const p = await pipeline('feature-extraction', LOCAL_EMBED_MODEL, {
        dtype: 'fp32',
      })
      console.log(`[embed] loaded from bundle in ${Date.now() - t0}ms`)
      return p as FeatureExtractionPipeline
    }
    // Fallback path (developer escape hatch): bundle missing, try remote.
    // Should never happen in a shipped build.
    console.warn(
      `[embed] bundled model not found, falling back to remote — ` +
        `this should never happen in a shipped install`,
    )
    env.allowRemoteModels = true
    let lastErr: unknown
    for (const host of HF_MIRRORS) {
      try {
        return await tryLoadExtractor(host)
      } catch (err) {
        lastErr = err
        console.warn(`[embed] ${host} failed:`, err instanceof Error ? err.message : err)
      }
    }
    throw lastErr ?? new Error('all embed mirrors failed')
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
