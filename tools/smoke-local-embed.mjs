/**
 * Local embedding smoke test using bge-small-zh-v1.5 via transformers.js.
 *
 * Confirms:
 *   1. ONNX runtime initializes in Electron's Node without crashes
 *   2. bge-small-zh-v1.5 downloads + loads
 *   3. Returns a normalized 512-dim Float32Array
 *   4. Semantic similarity works (related sentences score higher)
 *
 * First run downloads ~95MB to a cache dir; subsequent runs reuse it.
 *
 * Run: npx electron tools/smoke-local-embed.mjs
 */

import { app } from 'electron'
import { pipeline, env } from '@huggingface/transformers'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

async function main() {
  const cacheDir = join(app.getPath('userData'), 'hf-cache')
  mkdirSync(cacheDir, { recursive: true })
  // Park model files under userData so they survive across dev / built runs
  // and don't pollute random temp dirs.
  env.cacheDir = cacheDir
  // Transformers.js can also yank from local filesystem; we let it remote
  // by default but tell it where to cache.
  console.log('Cache dir:', cacheDir)

  console.log('\nLoading BAAI/bge-small-zh-v1.5 ...')
  const t0 = Date.now()
  const extractor = await pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5', {
    // Quantized variant — much smaller / faster, similarity still good.
    dtype: 'fp32',
  })
  console.log(`  loaded in ${Date.now() - t0}ms`)

  async function embed(text) {
    const out = await extractor(text, { pooling: 'cls', normalize: true })
    return Float32Array.from(out.data)
  }

  function cosine(a, b) {
    let dot = 0
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
    return dot // both are already L2-normalized
  }

  console.log('\nEmbedding three sentences and comparing pairs ...')
  const s1 = '我养了一只橘猫，叫阿黄'
  const s2 = '我猫叫什么名字'
  const s3 = '今天天气真不错'

  const v1 = await embed(s1)
  const v2 = await embed(s2)
  const v3 = await embed(s3)

  console.log(`\n  dim: ${v1.length}`)
  console.log(`  cos(我养猫阿黄,    我猫叫什么) = ${cosine(v1, v2).toFixed(4)}`)
  console.log(`  cos(我养猫阿黄,    今天天气真不错) = ${cosine(v1, v3).toFixed(4)}`)
  console.log(`  cos(我猫叫什么,    今天天气真不错) = ${cosine(v2, v3).toFixed(4)}`)

  // The cat-related pair should be much higher than either cat-vs-weather pair.
  const catPair = cosine(v1, v2)
  const offTopic = Math.max(cosine(v1, v3), cosine(v2, v3))
  const ok = v1.length === 512 && catPair > 0.5 && catPair > offTopic + 0.1
  console.log(ok ? '\n✅ Local embedding works' : '\n❌ Embedding sanity check failed')
  app.exit(ok ? 0 : 1)
}

app.whenReady().then(main).catch((err) => {
  console.error('crashed:', err)
  app.exit(1)
})
