#!/usr/bin/env node
/**
 * Smoke test for the local STT host. Reads a handful of paired .wav +
 * .lab files from a GPT-SoVITS dataset directory, runs each through
 * whisper, and compares the transcript to the ground-truth .lab text.
 *
 * Not a strict equality check — Whisper Chinese transcripts often
 * differ in punctuation, choice of synonym, traditional vs simplified.
 * We score by character-level overlap (LCS-style) and require ≥ 0.6
 * to call it a pass.
 *
 * Run: SOVITS_DIR="E:/GPT-SoVITS/中文 - Chinese" electron tools/smoke-stt-sovits.mjs
 *
 * Why electron-as-runner: the STT host pulls in @huggingface/transformers
 * which uses Node-native ONNX bindings that only resolve correctly
 * inside Electron's runtime in our project setup (same reason
 * smoke-task-adapter / smoke-naive-memory use electron).
 */

import { app } from 'electron'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'

/** Minimal 16-bit PCM WAV decoder. Avoids a dep — the format is fixed
 *  enough that 30 lines covers what GPT-SoVITS spits out. Returns
 *  { samples: Float32Array, sampleRate }. */
function decodeWav(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (view.getUint32(0, false) !== 0x52494646) throw new Error('not a RIFF file')
  if (view.getUint32(8, false) !== 0x57415645) throw new Error('not a WAVE file')
  // Walk chunks to find "fmt " and "data" (some encoders prepend others).
  let pos = 12
  let fmt = null
  let dataOffset = -1
  let dataLen = 0
  while (pos < buf.byteLength - 8) {
    const id = view.getUint32(pos, false)
    const sz = view.getUint32(pos + 4, true)
    if (id === 0x666d7420) {
      fmt = {
        format: view.getUint16(pos + 8, true),
        channels: view.getUint16(pos + 10, true),
        sampleRate: view.getUint32(pos + 12, true),
        bitsPerSample: view.getUint16(pos + 22, true),
      }
    } else if (id === 0x64617461) {
      dataOffset = pos + 8
      dataLen = sz
      break
    }
    pos += 8 + sz + (sz % 2) // pad odd-sized chunks
  }
  if (!fmt) throw new Error('no fmt chunk')
  if (dataOffset < 0) throw new Error('no data chunk')
  if (fmt.format !== 1) throw new Error(`only PCM supported, got format ${fmt.format}`)
  if (fmt.bitsPerSample !== 16) throw new Error(`only 16-bit PCM supported, got ${fmt.bitsPerSample}`)
  const sampleCount = dataLen / 2 / fmt.channels
  const out = new Float32Array(sampleCount)
  for (let i = 0; i < sampleCount; i++) {
    // Average channels for stereo → mono. Whisper wants mono.
    let sum = 0
    for (let c = 0; c < fmt.channels; c++) {
      const off = dataOffset + (i * fmt.channels + c) * 2
      const s16 = view.getInt16(off, true)
      sum += s16 / 32768
    }
    out[i] = sum / fmt.channels
  }
  return { samples: out, sampleRate: fmt.sampleRate }
}

/** Linear resampler. Whisper wants 16 kHz; SoVITS data is typically
 *  32 kHz or 44.1 kHz. Linear is rough but adequate for STT — we're
 *  not preserving spectral detail, just intelligibility. */
function resample(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples
  const ratio = fromRate / toRate
  const outLen = Math.floor(samples.length / ratio)
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const srcPos = i * ratio
    const srcIdx = Math.floor(srcPos)
    const frac = srcPos - srcIdx
    const a = samples[srcIdx] ?? 0
    const b = samples[srcIdx + 1] ?? a
    out[i] = a + (b - a) * frac
  }
  return out
}

/** Character-level overlap score in [0,1]. Strips whitespace + common
 *  punctuation so "你好。" matches "你好" perfectly. */
function similarity(a, b) {
  const clean = (s) => s.replace(/[\s。，、！？!?,.\-—…"'""''《》()（）]/g, '')
  const aa = clean(a)
  const bb = clean(b)
  if (!aa || !bb) return 0
  // Count chars from the shorter that appear (in order) in the longer.
  const [short, long] = aa.length <= bb.length ? [aa, bb] : [bb, aa]
  let j = 0
  let matched = 0
  for (const ch of short) {
    const idx = long.indexOf(ch, j)
    if (idx >= 0) {
      matched++
      j = idx + 1
    }
  }
  return matched / short.length
}

async function main() {
  const dir = process.env.SOVITS_DIR ?? 'E:/GPT-SoVITS/中文 - Chinese'
  if (!existsSync(dir)) {
    console.error(`SOVITS_DIR not found: ${dir}`)
    app.exit(1)
    return
  }

  const { register } = await import('tsx/esm/api')
  register()
  const { transcribeSamples, STT_SAMPLE_RATE } = await import('../src/main/stt-host.ts')

  // Pick the first speaker dir and grab the first N pairs.
  const speakers = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())
  if (speakers.length === 0) {
    console.error(`no speaker subdirs in ${dir}`)
    app.exit(1)
    return
  }
  const speakerDir = join(dir, speakers[0].name)
  const wavs = readdirSync(speakerDir).filter((f) => f.endsWith('.wav')).slice(0, 5)
  console.log(`Speaker: ${speakers[0].name} — testing ${wavs.length} clips\n`)

  let pass = 0
  let fail = 0
  for (const wav of wavs) {
    const wavPath = join(speakerDir, wav)
    const labPath = wavPath.replace(/\.wav$/, '.lab')
    if (!existsSync(labPath)) {
      console.log(`⏭  ${wav} — no .lab transcript, skipping`)
      continue
    }
    const truth = readFileSync(labPath, 'utf8').trim()
    const buf = readFileSync(wavPath)
    const { samples, sampleRate } = decodeWav(buf)
    const resampled = resample(samples, sampleRate, STT_SAMPLE_RATE)
    const t0 = Date.now()
    let predicted
    try {
      predicted = await transcribeSamples(resampled, STT_SAMPLE_RATE, 'chinese')
    } catch (err) {
      console.log(`❌  ${wav}: transcribe threw — ${err.message ?? err}`)
      fail++
      continue
    }
    const score = similarity(truth, predicted)
    const dur = ((Date.now() - t0) / 1000).toFixed(2)
    const ok = score >= 0.6
    const mark = ok ? '✅' : '❌'
    console.log(`${mark} ${basename(wav)} (sim=${score.toFixed(2)}, ${dur}s)`)
    console.log(`   truth:     ${truth}`)
    console.log(`   predicted: ${predicted}`)
    if (ok) pass++
    else fail++
  }
  console.log(`\n${pass} passed · ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
}

app.whenReady().then(main).catch((err) => {
  console.error('crashed:', err)
  app.exit(1)
})
