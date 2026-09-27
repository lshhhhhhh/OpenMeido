/**
 * Electron smoke for config boot + credential encryption (main/config.ts).
 * Runs in a throwaway userData dir — never touches the real profile.
 *
 * Phases (each a fresh Electron process, because config.ts reads the file
 * once at import):
 *   upgrade   — v0.3.x-style config.json: plaintext keys, a retired Kimi
 *               model, a legacy proactive.enabled=false. Expect keys
 *               decrypted in memory but `enc:v1:` on disk, model remapped,
 *               migration actually persisted.
 *   reopen    — same dir again: keys decrypt back to the same plaintext.
 *   corrupt   — unparseable config.json: app boots on defaults, original
 *               moved aside as config.corrupt-*.json.
 *   invalid   — one bad enum: only that field reset, keys survive.
 *
 * Run: npm run test:config-boot
 */
import { app } from 'electron'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const phase = process.argv.find((a) => a.startsWith('--phase='))?.slice(8)
const dir = process.argv.find((a) => a.startsWith('--dir='))?.slice(6)

let pass = 0
let fail = 0
const t = (label, ok, detail = "") => {
  if (ok) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

async function orchestrate() {
  // Orchestrator: run each phase in its own Electron process.
  const root = mkdtempSync(join(tmpdir(), 'om-config-boot-'))
  const self = fileURLToPath(import.meta.url)
  let failed = false
  for (const p of ['upgrade', 'reopen', 'corrupt', 'invalid']) {
    const d = p === 'reopen' ? join(root, 'upgrade') : join(root, p)
    console.log(`\n[${p}]`)
    const r = spawnSync(process.execPath, [self, `--phase=${p}`, `--dir=${d}`], {
      stdio: 'inherit',
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: '' },
    })
    if (r.status !== 0) failed = true
  }
  rmSync(root, { recursive: true, force: true })
  console.log(failed ? '\n✗ config-boot smoke FAILED' : '\n✓ config-boot smoke passed')
  app.exit(failed ? 1 : 0)
}

/** Write the phase's starting config.json (before config.ts loads). */
function seed() {
  const file = join(dir, 'config.json')
  mkdirSync(dir, { recursive: true })
  if (phase === 'upgrade') {
    writeFileSync(
      file,
      JSON.stringify({
        backend: {
          baseUrl: 'https://api.moonshot.cn/v1',
          apiKey: 'sk-plain-kimi',
          apiKeys: { 'https://api.moonshot.cn/v1': 'sk-plain-kimi', 'https://api.deepseek.com/v1': 'sk-plain-ds' },
          model: 'kimi-k2-turbo-preview',
        },
        tts: { minimax: { apiKey: 'mm-secret' } },
        proactive: { enabled: false },
      }),
    )
  } else if (phase === 'corrupt') {
    writeFileSync(file, '{"backend": {"apiKey": "sk-x", ')
  } else if (phase === 'invalid') {
    writeFileSync(
      file,
      JSON.stringify({ backend: { apiKey: 'sk-keep', baseUrl: 'https://api.deepseek.com/v1' }, proactive: { mode: 'bogus' } }),
    )
  }

}

async function runPhase() {
  const file = join(dir, 'config.json')
  // Load electron-store (→ ajv) with Node's own loader first: under tsx's
  // loader ajv's bundled .json refs get mangled. The app itself is bundled
  // by Vite and never goes through tsx.
  await import('electron-store')
  const { register } = await import('tsx/esm/api')
  register()
  const cfgMod = await import('../src/main/config.ts')
  await cfgMod.unlockConfigSecrets()
  const cfg = cfgMod.getConfig()
  const disk = () => readFileSync(file, 'utf-8')

  if (phase === 'upgrade') {
    t('key decrypted in memory', cfg.backend.apiKey === 'sk-plain-kimi', cfg.backend.apiKey)
    t('key map in memory', cfg.backend.apiKeys['https://api.deepseek.com/v1'] === 'sk-plain-ds')
    t('no plaintext key on disk', !disk().includes('sk-plain') && !disk().includes('mm-secret'))
    t('keys stored as enc:v1:', JSON.parse(disk()).backend.apiKey.startsWith('enc:v1:'))
    t('retired kimi model remapped', cfg.backend.model === 'kimi-k2.6')
    t('remap persisted to disk', JSON.parse(disk()).backend.model === 'kimi-k2.6')
    t('legacy proactive opt-out survived', cfg.proactive.mode === 'mute', cfg.proactive.mode)
    cfgMod.setConfig({ ...cfg, backend: { ...cfg.backend, apiKey: 'sk-new-key' } })
    await new Promise((r) => setTimeout(r, 300))
    t('new key never written in plaintext', !disk().includes('sk-new-key'))
    t('new key in memory', cfgMod.getConfig().backend.apiKey === 'sk-new-key')
  } else if (phase === 'reopen') {
    t('encrypted key decrypts on next launch', cfg.backend.apiKey === 'sk-new-key', cfg.backend.apiKey)
    t('map entries decrypt', cfg.backend.apiKeys['https://api.deepseek.com/v1'] === 'sk-plain-ds')
    t('minimax token decrypts', cfg.tts.minimax.apiKey === 'mm-secret')
    t('no boot issues', !cfgMod.getConfigBootIssues().secretsLost)
  } else if (phase === 'corrupt') {
    const issues = cfgMod.getConfigBootIssues()
    t('booted on defaults', cfg.backend.apiKey === '')
    t('corrupt file moved aside', !!issues.corruptBackup && readdirSync(dir).some((f) => f.startsWith('config.corrupt-')))
    t('fresh config.json is valid JSON', (() => { try { JSON.parse(disk()); return true } catch { return false } })())
  } else if (phase === 'invalid') {
    const issues = cfgMod.getConfigBootIssues()
    t('bad field reported', issues.dropped.includes('proactive.mode'), JSON.stringify(issues.dropped))
    t('bad field reset to default', cfg.proactive.mode === 'auto', cfg.proactive.mode)
    t('api key survived', cfg.backend.apiKey === 'sk-keep')
    t('backup written', !!issues.invalidBackup)
  }
  console.log(`  ${pass} passed, ${fail} failed`)
  app.exit(fail > 0 ? 1 : 0)
}

if (phase) {
  // userData must be set before ready AND before config.ts is imported.
  app.setPath('userData', dir)
  seed()
}
app
  .whenReady()
  .then(phase ? runPhase : orchestrate)
  .catch((err) => {
    console.error(err)
    app.exit(1)
  })
