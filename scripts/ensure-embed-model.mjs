#!/usr/bin/env node
/**
 * Pre-build helper: make sure the bge-small-zh-v1.5 ONNX model is present
 * on disk before `electron-builder` runs. The model is bundled into
 * `resources/models/` of the installer (see electron-builder.yml), so the
 * files have to exist locally at build time.
 *
 * We don't ship the model in git (it's a ~94MB build artifact, not source),
 * so developers / CI need a fetch step. This script:
 *   1. Checks if models/Xenova/bge-small-zh-v1.5/ has all required files.
 *   2. If anything's missing, downloads from huggingface.co; falls back
 *      to hf-mirror.com if HF is unreachable.
 *   3. Verifies file sizes are non-trivial (catches partial downloads).
 *
 * Idempotent — re-runs cheaply when everything is already in place.
 */
import { existsSync, mkdirSync, statSync, createWriteStream } from 'node:fs'
import { join, dirname } from 'node:path'
import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'

const MODEL_ID = 'Xenova/bge-small-zh-v1.5'
const REPO = `${MODEL_ID}/resolve/main`
const FILES = [
  { path: 'config.json', minBytes: 100 },
  { path: 'tokenizer.json', minBytes: 100_000 },
  { path: 'tokenizer_config.json', minBytes: 100 },
  { path: 'onnx/model.onnx', minBytes: 50_000_000 },
]
const HOSTS = ['https://huggingface.co', 'https://hf-mirror.com']

const localRoot = join(process.cwd(), 'models', MODEL_ID)

function fileOk(path, minBytes) {
  if (!existsSync(path)) return false
  try {
    return statSync(path).size >= minBytes
  } catch {
    return false
  }
}

async function downloadOne(host, file) {
  const url = `${host}/${REPO}/${file.path}`
  const dest = join(localRoot, file.path)
  mkdirSync(dirname(dest), { recursive: true })
  console.log(`  ↓ ${file.path} from ${host}`)
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'openmeido-build/1.0',
    },
  })
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`)
  }
  // @ts-ignore — Node's Readable.fromWeb is fine in Node 18+
  await finished(Readable.fromWeb(res.body).pipe(createWriteStream(dest)))
  if (!fileOk(dest, file.minBytes)) {
    throw new Error(
      `downloaded ${dest} is shorter than expected (got ${statSync(dest).size}, want ≥ ${file.minBytes})`,
    )
  }
}

async function main() {
  const missing = FILES.filter((f) => !fileOk(join(localRoot, f.path), f.minBytes))
  if (missing.length === 0) {
    console.log(`[ensure-embed-model] all ${FILES.length} files present at ${localRoot}`)
    return
  }
  console.log(
    `[ensure-embed-model] ${missing.length}/${FILES.length} files missing or short, downloading ${MODEL_ID}…`,
  )
  let lastErr
  for (const host of HOSTS) {
    try {
      for (const f of missing) {
        await downloadOne(host, f)
      }
      console.log(`[ensure-embed-model] ✓ ready (${localRoot})`)
      return
    } catch (err) {
      lastErr = err
      console.warn(`[ensure-embed-model] ${host} failed: ${err instanceof Error ? err.message : err}`)
      // Try the next host. We don't roll back partial downloads — the
      // next attempt will re-fetch only the still-missing files.
    }
  }
  throw lastErr ?? new Error('all hosts failed and no error captured')
}

main().catch((err) => {
  console.error('[ensure-embed-model] FAILED:', err)
  process.exit(1)
})
