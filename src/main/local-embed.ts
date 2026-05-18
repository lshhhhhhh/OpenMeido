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
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** bge-small-zh native dimension. Fixed; do not change without re-embedding. */
export const LOCAL_EMBED_DIM = 512
export const LOCAL_EMBED_MODEL = 'Xenova/bge-small-zh-v1.5'

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null

function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (extractorPromise) return extractorPromise
  const cacheDir = join(app.getPath('userData'), 'hf-cache')
  mkdirSync(cacheDir, { recursive: true })
  // transformers.js looks here for downloaded model files. Stays put across
  // dev/build/upgrade — no re-download per launch.
  env.cacheDir = cacheDir
  console.log(`[embed] loading ${LOCAL_EMBED_MODEL} (cache: ${cacheDir})`)
  const t0 = Date.now()
  extractorPromise = pipeline('feature-extraction', LOCAL_EMBED_MODEL, {
    dtype: 'fp32',
  }).then((p) => {
    console.log(`[embed] loaded in ${Date.now() - t0}ms`)
    return p as FeatureExtractionPipeline
  })
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
