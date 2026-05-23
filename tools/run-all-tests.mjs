/**
 * Aggregator: runs every non-LLM, non-Electron smoke test in sequence.
 *
 * Lives in tools/ so the npm script alias is `npm run test:all`. Each
 * step is one npm script that ALREADY works on its own — this is just
 * a single-command wrapper for "did I break anything in the testable
 * surface" before a commit.
 *
 * Excluded from this aggregator (each must be run separately when the
 * cost / setup is worth it):
 *   - DeepSeek-backed tests (`test:email-draft`, `test:tier-conversation`,
 *     etc.) — burn real tokens, slow, need .env DEEPSEEK_API_KEY
 *   - Electron-runtime tests (`test:memory-negation-e2e`,
 *     `test:turn-classification`, `test:table-*`) — need an Electron
 *     window context (better-sqlite3 native binding, electron-store)
 *   - Live TTS / live LLM connectivity tests — there aren't any yet,
 *     but if added they'd skip this script too
 *
 * Exits non-zero on the first failing step so a CI hookup sees the
 * failure immediately.
 */

import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'

const STEPS = [
  { label: 'typecheck',                cmd: 'npm', args: ['run', 'typecheck'] },
  { label: 'tts-minimax-body',         cmd: 'npm', args: ['run', 'test:tts-minimax-body'] },
  { label: 'tts-minimax-decode',       cmd: 'npm', args: ['run', 'test:tts-minimax-decode'] },
  { label: 'tts-volcengine-body',      cmd: 'npm', args: ['run', 'test:tts-volcengine-body'] },
  { label: 'tts-volcengine-decode',    cmd: 'npm', args: ['run', 'test:tts-volcengine-decode'] },
  { label: 'proactive-cadence',        cmd: 'npm', args: ['run', 'test:proactive-cadence'] },
  { label: 'proactive-migration',      cmd: 'npm', args: ['run', 'test:proactive-migration'] },
  { label: 'proactive-engine',         cmd: 'npm', args: ['run', 'test:proactive-engine'] },
  { label: 'mute-feedback',            cmd: 'npm', args: ['run', 'test:mute-feedback'] },
  { label: 'lines-host',               cmd: 'npm', args: ['run', 'test:lines-host'] },
  { label: 'onboarding-peek',          cmd: 'npm', args: ['run', 'test:onboarding-peek'] },
  { label: 'celebrations',             cmd: 'npm', args: ['run', 'test:celebrations'] },
  { label: 'openai-compat-body',       cmd: 'npm', args: ['run', 'test:openai-compat-body'] },
  { label: 'mime-snippet',             cmd: 'npm', args: ['run', 'test:mime-snippet'] },
  { label: 'reflection-parse',         cmd: 'npm', args: ['run', 'test:reflection-parse'] },
  { label: 'notif-parse',              cmd: 'npm', args: ['run', 'test:notif-parse'] },
  { label: 'text-filter',              cmd: 'npm', args: ['run', 'test:text-filter'] },
  { label: 'presence-gate',            cmd: 'npm', args: ['run', 'test:presence-gate'] },
  { label: 'affinity-guardrails',      cmd: 'npm', args: ['run', 'test:affinity-guardrails'] },
  { label: 'emotion-pipeline',         cmd: 'npm', args: ['run', 'test:emotion-pipeline'] },
  { label: 'docx-parse',               cmd: 'npm', args: ['run', 'test:docx-parse'] },
  { label: 'fake-mail',                cmd: 'npm', args: ['run', 'test:fake-mail'] },
  { label: 'mail-parent',              cmd: 'npm', args: ['run', 'test:mail-parent'] },
]

function runStep(step) {
  return new Promise((resolve) => {
    const t0 = performance.now()
    const child = spawn(step.cmd, step.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32', // npm.cmd on Windows
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()))
    child.on('close', (code) => {
      const ms = Math.round(performance.now() - t0)
      resolve({ step, code, stdout, stderr, ms })
    })
    child.on('error', (err) => {
      resolve({ step, code: -1, stdout, stderr: stderr + err.message, ms: 0 })
    })
  })
}

console.log(`Running ${STEPS.length} test steps...\n`)

const t0 = performance.now()
const results = []
let bailed = false
for (const step of STEPS) {
  process.stdout.write(`  · ${step.label.padEnd(28)} `)
  const result = await runStep(step)
  results.push(result)
  if (result.code === 0) {
    console.log(`✓  (${result.ms}ms)`)
  } else {
    console.log(`✗  (${result.ms}ms, exit ${result.code})`)
    // Surface the failing step's output so the human doesn't need to
    // re-run it in isolation to see what broke.
    console.log('    ── stdout ──────────────────────────────')
    console.log(
      result.stdout
        .split('\n')
        .slice(-30) // last 30 lines is usually the failing assertions
        .map((l) => '    ' + l)
        .join('\n'),
    )
    if (result.stderr.trim()) {
      console.log('    ── stderr ──────────────────────────────')
      console.log(
        result.stderr
          .split('\n')
          .slice(-15)
          .map((l) => '    ' + l)
          .join('\n'),
      )
    }
    bailed = true
    break
  }
}

const totalMs = Math.round(performance.now() - t0)
const ran = results.length
const skipped = STEPS.length - ran
const passed = results.filter((r) => r.code === 0).length
const failed = ran - passed

console.log()
console.log(
  `${passed}/${STEPS.length} passed${failed > 0 ? `, ${failed} failed` : ''}${skipped > 0 ? `, ${skipped} skipped` : ''} (${(totalMs / 1000).toFixed(1)}s total)`,
)

if (bailed || failed > 0) {
  console.log('\nFailing step blocks the aggregator early — fix it, then re-run.')
  process.exit(1)
}
