/**
 * Live2D model registry + zip importer for the main process.
 *
 * One storage root: `<userData>/live2d-models/<name>/`. The bundled
 * `src/renderer/public/live2d-models/*` ships with the app as starter
 * content — we copy it into userData on first run, then never touch the
 * bundled location again. From then on the user can:
 *   - import more models via a zip picker (drops into userData)
 *   - edit each model's `openmeido.json` sidecar from Settings
 *   - delete models
 *
 * Files are served to the renderer via the `meido-live2d://` protocol
 * registered in main/index.ts. URL shape: `meido-live2d://<name>/<file-path>`.
 */

import { app } from 'electron'
import { promises as fsp, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import AdmZip from 'adm-zip'

import {
  EMOTIONS,
  type Emotion,
  type ModelListEntry,
  type ModelSidecar,
} from '../shared/live2d-models.js'

const SIDECAR_NAME = 'openmeido.json'

let userRoot: string | null = null
function getUserRoot(): string {
  if (!userRoot) userRoot = join(app.getPath('userData'), 'live2d-models')
  return userRoot
}

/**
 * Path to the bundled starter models — different in dev vs production.
 * Dev: project tree (`<repo>/src/renderer/public/live2d-models/`).
 * Prod: extraResources copies `src/renderer/public/` to `<resources>/public/`,
 *       so the models end up at `<resourcesPath>/public/live2d-models/`.
 * Returns `null` when neither path exists, so the host still works when there
 * are no bundled models at all (e.g. user-only deployments).
 */
function findBundledRoot(): string | null {
  const candidates = [
    join(process.resourcesPath, 'public', 'live2d-models'),
    // electron-vite runs main from out/main/, so __dirname-style join would
    // need '../..'. cwd is the project root in dev — use it for simplicity.
    join(process.cwd(), 'src', 'renderer', 'public', 'live2d-models'),
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

/**
 * On first launch, copy bundled starter models into userData. Skipped if the
 * userData dir already has any model — we never overwrite the user's edits
 * or imports.
 */
export async function initLive2DModels(): Promise<void> {
  const dst = getUserRoot()
  await fsp.mkdir(dst, { recursive: true })
  const existing = await fsp.readdir(dst).catch(() => [])
  if (existing.length > 0) return

  const src = findBundledRoot()
  if (!src) {
    console.log('[live2d] no bundled models to seed; userData live2d-models is empty')
    return
  }
  // Node's fs.cp (v16.7+) recursively copies; matches `cp -r src/. dst/`.
  await fsp.cp(src, dst, { recursive: true })
  console.log(`[live2d] seeded userData live2d-models from ${src}`)
}

/**
 * Disk path for a model's directory. Caller is responsible for ensuring
 * the directory actually exists.
 */
export function modelDir(name: string): string {
  return join(getUserRoot(), name)
}

/**
 * Locate the first *.model3.json under a model directory, recursing into
 * subdirectories. Many Live2D distributions (the official Cubism samples in
 * particular) nest the runtime files one level deep under `<modelName>/runtime/`;
 * a flat top-level scan would miss those. Returns the path relative to `dir`
 * with forward slashes (so the renderer can use it directly as a URL segment).
 *
 * Caps depth at 3 to avoid pathological zip bombs walking the filesystem.
 */
async function findModel3Json(dir: string): Promise<string | null> {
  async function walk(rel: string, depth: number): Promise<string | null> {
    if (depth > 3) return null
    const here = rel ? join(dir, rel) : dir
    const entries = await fsp.readdir(here, { withFileTypes: true }).catch(() => [])
    // Files first, then directories — most models have model3.json at the
    // same level as moc3/textures, so checking files first short-circuits.
    const files = entries.filter((e) => e.isFile()).map((e) => e.name).sort()
    for (const f of files) {
      if (f.endsWith('.model3.json')) return rel ? `${rel}/${f}` : f
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      // Skip hidden / weird dirs like __MACOSX that some zips ship with.
      if (e.name.startsWith('.') || e.name.startsWith('_')) continue
      const nextRel = rel ? `${rel}/${e.name}` : e.name
      const found = await walk(nextRel, depth + 1)
      if (found) return found
    }
    return null
  }
  return walk('', 0)
}

/**
 * Read & parse the sidecar, OR synthesize a default sidecar from what's on
 * disk when the file is missing. We don't write the default back to disk —
 * `setSidecar()` does that once the user makes an edit.
 */
async function readOrDefaultSidecar(name: string): Promise<ModelSidecar | null> {
  const dir = modelDir(name)
  const sidePath = join(dir, SIDECAR_NAME)
  try {
    const raw = await fsp.readFile(sidePath, 'utf-8')
    const parsed = JSON.parse(raw) as ModelSidecar
    return parsed
  } catch {
    // No sidecar yet — build defaults from the model files.
  }
  const modelFile = await findModel3Json(dir)
  if (!modelFile) return null
  return {
    modelFile,
    fitMode: 'portrait',
    lipSyncParam: 'ParamMouthOpenY',
    emotionMapping: {},
    motionMapping: {},
  }
}

/**
 * Read expression names from the model3.json's `FileReferences.Expressions[].Name`
 * array — that's where Cubism stores the human-readable label. Falls back to
 * stripped filenames if Expressions is missing (some hand-built models).
 *
 * NOTE: don't use filenames as a primary source — community models almost
 * always have generic `expression1.exp3.json` filenames and the real Chinese /
 * English label only lives in the model3.json registry.
 */
async function listExpressionNames(dir: string, modelFile: string): Promise<string[]> {
  try {
    const raw = await fsp.readFile(join(dir, modelFile), 'utf-8')
    const m3 = JSON.parse(raw) as {
      FileReferences?: { Expressions?: { Name?: string; File?: string }[] }
    }
    const exps = m3.FileReferences?.Expressions
    if (Array.isArray(exps) && exps.length > 0) {
      const names = exps
        .map((e) => (typeof e.Name === 'string' && e.Name.trim() ? e.Name : null))
        .filter((n): n is string => n !== null)
      if (names.length > 0) return names
    }
  } catch {
    // Fall through to filename-based listing.
  }
  const entries = await fsp.readdir(dir).catch(() => [] as string[])
  return entries
    .filter((f) => f.endsWith('.exp3.json'))
    .map((f) => f.replace(/\.exp3\.json$/, ''))
    .sort()
}

/**
 * Parse motion groups from the Cubism model3.json. Returns `[{group, count}]`
 * so the UI can show "Tap: 2, Idle: 3" without making the user open files.
 */
async function listMotionGroups(
  dir: string,
  modelFile: string,
): Promise<{ group: string; count: number }[]> {
  try {
    const raw = await fsp.readFile(join(dir, modelFile), 'utf-8')
    const m3 = JSON.parse(raw) as {
      FileReferences?: { Motions?: Record<string, unknown[]> }
    }
    const motions = m3.FileReferences?.Motions ?? {}
    return Object.entries(motions)
      .map(([group, arr]) => ({ group, count: Array.isArray(arr) ? arr.length : 0 }))
      .sort((a, b) => a.group.localeCompare(b.group))
  } catch {
    return []
  }
}

/**
 * List all installed models. Returns one entry per top-level dir that
 * contains a model3.json file. Dirs without one (e.g. a zip that unpacked
 * something weird) are silently skipped — we don't want a half-good
 * directory to crash the picker.
 */
export async function listModels(): Promise<ModelListEntry[]> {
  const root = getUserRoot()
  const dirs = await fsp.readdir(root, { withFileTypes: true }).catch(() => [])
  const out: ModelListEntry[] = []
  for (const ent of dirs) {
    if (!ent.isDirectory()) continue
    const name = ent.name
    const sidecar = await readOrDefaultSidecar(name)
    if (!sidecar) continue
    const dir = modelDir(name)
    const expressionNames = await listExpressionNames(dir, sidecar.modelFile)
    const motionGroups = await listMotionGroups(dir, sidecar.modelFile)
    out.push({
      name,
      sidecar,
      expressionCount: expressionNames.length,
      motionCount: motionGroups.reduce((s, g) => s + g.count, 0),
      expressionNames,
      motionGroups,
    })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

export async function getSidecar(name: string): Promise<ModelSidecar | null> {
  return readOrDefaultSidecar(name)
}

export async function setSidecar(name: string, sidecar: ModelSidecar): Promise<void> {
  const dir = modelDir(name)
  if (!existsSync(dir)) throw new Error(`model not installed: ${name}`)
  // Normalize the emotion keys so a typo in the renderer can't permanently
  // break the file — drop anything that isn't a known emotion.
  const knownEmotions = new Set<Emotion>(EMOTIONS)
  const pickKnown = <T>(rec: Partial<Record<Emotion, T>> = {}): Partial<Record<Emotion, T>> => {
    const out: Partial<Record<Emotion, T>> = {}
    for (const [k, v] of Object.entries(rec)) {
      if (knownEmotions.has(k as Emotion) && v !== undefined && v !== null) {
        out[k as Emotion] = v as T
      }
    }
    return out
  }
  const cleaned: ModelSidecar = {
    modelFile: sidecar.modelFile,
    fitMode: sidecar.fitMode ?? 'portrait',
    lipSyncParam: sidecar.lipSyncParam ?? 'ParamMouthOpenY',
    emotionMapping: pickKnown(sidecar.emotionMapping),
    motionMapping: pickKnown(sidecar.motionMapping),
  }
  await fsp.writeFile(join(dir, SIDECAR_NAME), JSON.stringify(cleaned, null, 2), 'utf-8')
}

export async function deleteModel(name: string): Promise<void> {
  const dir = modelDir(name)
  if (!existsSync(dir)) return
  await fsp.rm(dir, { recursive: true, force: true })
}

/**
 * Unpack a Live2D model zip into `<userData>/live2d-models/<derived>/`.
 *
 * Derivation rules (mirrors imouto-oss):
 *   - If the zip has a SINGLE top-level directory, use that dir name.
 *   - Otherwise use the zip filename's stem.
 *
 * Throws on collision — caller (the Settings UI) should ask the user before
 * passing `overwrite: true`.
 *
 * Returns the derived name on success.
 */
export async function importZip(
  zipPath: string,
  opts: { overwrite?: boolean } = {},
): Promise<string> {
  if (!existsSync(zipPath)) throw new Error(`zip not found: ${zipPath}`)
  const zip = new AdmZip(zipPath)
  const entries = zip.getEntries()
  if (entries.length === 0) throw new Error('empty zip')

  // Detect single top-level directory pattern.
  const topSegments = new Set<string>()
  for (const e of entries) {
    const seg = e.entryName.split(/[/\\]/, 1)[0]
    if (seg) topSegments.add(seg)
  }
  const singleTop = topSegments.size === 1 ? [...topSegments][0]! : null
  const stripPrefix = singleTop && entries.some((e) => e.entryName.startsWith(singleTop + '/'))

  const baseName = stripPrefix ? singleTop! : basename(zipPath, '.zip')
  const name = sanitizeName(baseName)
  if (!name) throw new Error('could not derive a usable name from the zip')

  const dst = modelDir(name)
  if (existsSync(dst)) {
    if (!opts.overwrite) throw new Error(`model already exists: ${name}`)
    await fsp.rm(dst, { recursive: true, force: true })
  }
  await fsp.mkdir(dst, { recursive: true })

  // Extract each file relative to dst, stripping the single-top-dir prefix
  // when applicable. We do this entry-by-entry instead of using
  // zip.extractAllTo so we don't leave a leftover top-level dir.
  for (const entry of entries) {
    if (entry.isDirectory) continue
    let rel = entry.entryName.replace(/\\/g, '/')
    if (stripPrefix && rel.startsWith(singleTop + '/')) {
      rel = rel.slice(singleTop!.length + 1)
    }
    if (!rel) continue
    const outPath = join(dst, rel)
    await fsp.mkdir(join(outPath, '..'), { recursive: true })
    await fsp.writeFile(outPath, entry.getData())
  }

  // Verify the unpacked tree actually has a model3.json — otherwise we just
  // littered userData with garbage. Clean up and bail.
  const found = await findModel3Json(dst)
  if (!found) {
    await fsp.rm(dst, { recursive: true, force: true })
    throw new Error('zip did not contain a *.model3.json — is this really a Cubism 4 model?')
  }

  return name
}

/**
 * Replace any character that would be unsafe in a path or URL segment.
 * We keep CJK so Chinese model names round-trip; just kill slashes / quotes /
 * control chars.
 */
function sanitizeName(s: string): string {
  return s
    .replace(/[\\/ -"<>|:?*]/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 96)
}

// ---- AI auto-bind ----

const AUTO_BIND_PROMPT_PREFIX = `你是 Live2D 模型情绪绑定助手。

OpenMeido 内部使用 8 种情绪标签：开心/害羞/无语/难过/慌张/震惊/尴尬/得意。
你的任务：把每种情绪映射到这个模型可用的"表情名"或"动作"，使聊天时的情绪能在 Live2D 形象上自然表现出来。

规则：
- 仅从下面给出的表情列表 / 动作列表里挑，不要发明新名字。
- 如果某种情绪在这个模型里找不到合适表达，留 null（别强行映射"第二套衣服"这种与情绪无关的项）。
- 多个情绪可以共用同一个表情（例如"开心"和"得意"都用"笑脸"）。
- 表情优先于动作：能用表情就别选动作（表情是持续状态，动作是一次性的）。

只输出 JSON，不要解释，不要 markdown 代码块。形如：
{
  "emotionMapping": { "开心": "<expr>", "害羞": "<expr>", ... },
  "motionMapping":   { "开心": {"group": "<g>", "index": 0}, ... }
}
没合适映射的 emotion 留空（即不出现在对应 mapping 里）。

`

/**
 * Tolerant JSON extractor — strips markdown fences, finds the first {...}
 * block. Mirrors what reflection / proactive parsers do.
 */
function extractJsonBlock(raw: string): string {
  let text = raw.trim()
  const fenced = text.match(/```(?:json)?\s*([\s\S]+?)```/i)
  if (fenced) text = fenced[1]!.trim()
  const objMatch = text.match(/\{[\s\S]*\}/)
  return objMatch ? objMatch[0] : text
}

/**
 * Ask the configured LLM to auto-map the 8 emotions onto this model's
 * available expressions / motions. Writes the result back to the sidecar
 * and returns the parsed mapping.
 *
 * Caller supplies `runLLM` because the live2d host can't import chat-host
 * directly (chat-host imports the live2d host for its setLive2DExpression
 * tool — would be a circular dep).
 */
export async function autoBindEmotions(
  name: string,
  runLLM: (prompt: string) => Promise<string>,
): Promise<{ ok: true; sidecar: ModelSidecar } | { ok: false; error: string }> {
  const dir = modelDir(name)
  if (!existsSync(dir)) return { ok: false, error: `model not installed: ${name}` }

  const current = await readOrDefaultSidecar(name)
  if (!current) return { ok: false, error: 'model has no model3.json — cannot bind' }

  const expressionNames = await listExpressionNames(dir, current.modelFile)
  const motionGroups = await listMotionGroups(dir, current.modelFile)
  if (expressionNames.length === 0 && motionGroups.length === 0) {
    return { ok: false, error: '模型既没有表情文件也没有动作组，无法绑定' }
  }

  const motionListText =
    motionGroups.length === 0
      ? '(无)'
      : motionGroups
          .flatMap((g) => Array.from({ length: g.count }, (_, i) => `${g.group}[${i}]`))
          .join('\n')

  const prompt =
    AUTO_BIND_PROMPT_PREFIX +
    `表情列表（共 ${expressionNames.length} 个）：\n` +
    (expressionNames.length === 0 ? '(无)\n' : expressionNames.join('\n') + '\n') +
    `\n动作列表（group[index] 形式）：\n${motionListText}\n`

  let raw: string
  try {
    raw = await runLLM(prompt)
  } catch (err) {
    return {
      ok: false,
      error: `LLM 调用失败：${err instanceof Error ? err.message : String(err)}`,
    }
  }

  let parsed: {
    emotionMapping?: Record<string, unknown>
    motionMapping?: Record<string, unknown>
  }
  try {
    parsed = JSON.parse(extractJsonBlock(raw))
  } catch {
    return { ok: false, error: `模型返回的不是合法 JSON：${raw.slice(0, 200)}…` }
  }

  // Validate against the known sets — drop any hallucinated names so we
  // don't write garbage into the sidecar.
  const knownEmotions = new Set<Emotion>(EMOTIONS)
  const knownExpressions = new Set(expressionNames)
  const knownMotions = new Map<string, number>()
  for (const g of motionGroups) knownMotions.set(g.group, g.count)

  const cleanEmotion: Partial<Record<Emotion, string>> = {}
  for (const [k, v] of Object.entries(parsed.emotionMapping ?? {})) {
    if (!knownEmotions.has(k as Emotion)) continue
    if (typeof v !== 'string' || !knownExpressions.has(v)) continue
    cleanEmotion[k as Emotion] = v
  }
  const cleanMotion: Partial<Record<Emotion, { group: string; index: number }>> = {}
  for (const [k, v] of Object.entries(parsed.motionMapping ?? {})) {
    if (!knownEmotions.has(k as Emotion)) continue
    // Prefer expression — skip motion when this emotion already got one.
    if (cleanEmotion[k as Emotion]) continue
    if (!v || typeof v !== 'object') continue
    const obj = v as { group?: unknown; index?: unknown }
    if (typeof obj.group !== 'string') continue
    const count = knownMotions.get(obj.group)
    if (count === undefined) continue
    const idx = typeof obj.index === 'number' ? Math.floor(obj.index) : 0
    if (idx < 0 || idx >= count) continue
    cleanMotion[k as Emotion] = { group: obj.group, index: idx }
  }

  const next: ModelSidecar = {
    modelFile: current.modelFile,
    fitMode: current.fitMode ?? 'portrait',
    lipSyncParam: current.lipSyncParam ?? 'ParamMouthOpenY',
    emotionMapping: cleanEmotion,
    motionMapping: cleanMotion,
  }
  await fsp.writeFile(join(dir, SIDECAR_NAME), JSON.stringify(next, null, 2), 'utf-8')
  return { ok: true, sidecar: next }
}

/**
 * Resolve a `meido-live2d://<name>/<file...>` URL to an absolute disk path.
 * Returns null when the path escapes the model dir (path traversal attempt)
 * or the model dir doesn't exist.
 */
export function resolveModelFile(name: string, relPath: string): string | null {
  if (!name) return null
  const dir = modelDir(name)
  if (!existsSync(dir)) return null
  // Normalize and reject any segment that tries to climb out.
  const clean = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (clean.split('/').some((seg) => seg === '..' || seg === '')) return null
  return join(dir, clean)
}
