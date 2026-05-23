/**
 * Preset台词 loader.
 *
 * Reads `%APPDATA%/openmeido/lines.json` at boot, validates against the
 * Zod schema, deep-merges over the bundled defaults so the renderer
 * always gets a fully-populated structure even when the user only
 * overrode a few lines.
 *
 * Failure modes (file missing / malformed JSON / Zod errors / IO
 * error) all fall back to bundled defaults with a warning. Never
 * throws to callers — the picker has its own '...' fallback for the
 * worst case but we shouldn't get there in practice.
 *
 * Re-reads are intentionally not automatic — edit + restart is the
 * documented flow (matches demos.json semantics). Adding a file
 * watcher would mean every notepad save during an edit session
 * triggers a re-parse with the file in a half-written state.
 */

import { app } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { presetLinesSchema } from '../shared/preset-lines-schema.js'
import { PRESET_LINES_DEFAULTS } from '../shared/preset-lines-defaults.js'
import type { PresetLines } from '../shared/preset-lines-defaults.js'

let cached: PresetLines = PRESET_LINES_DEFAULTS

/** Where the user-editable file lives. */
export function getLinesFilePath(): string {
  return join(app.getPath('userData'), 'lines.json')
}

/**
 * Deep-merge user override onto defaults. Object keys in the override
 * take precedence; arrays in the override REPLACE the default array
 * (rather than concatenating) — that's what a user expects when they
 * edit "the 4 maid mute-low lines" down to 2: they get 2, not 6.
 */
function mergeOnDefaults(override: unknown): PresetLines {
  const o = override as Partial<PresetLines>
  const muteOverride = o?.mute ?? {}
  const muteDefaults = PRESET_LINES_DEFAULTS.mute
  const coldOverride = o?.coldStart ?? {}
  const coldDefaults = PRESET_LINES_DEFAULTS.coldStart
  const celebrateOverride = o?.celebrations ?? {}
  const celebrateDefaults = PRESET_LINES_DEFAULTS.celebrations
  const merged: PresetLines = {
    mute: { ...muteDefaults },
    coldStart: { ...coldDefaults },
    celebrations: { ...celebrateDefaults },
  }
  for (const personaId of Object.keys({ ...muteDefaults, ...muteOverride })) {
    const def = muteDefaults[personaId]
    const ov = muteOverride[personaId]
    if (!ov) {
      // No override for this persona — use default verbatim (or skip
      // if it's a user-added persona key with no defaults, which is
      // legal but unusual).
      if (def) merged.mute[personaId] = def
      continue
    }
    const base = def ?? muteDefaults.default!
    merged.mute[personaId] = {
      mute: {
        low: ov.mute?.low && ov.mute.low.length > 0 ? ov.mute.low : base.mute.low,
        mid: ov.mute?.mid && ov.mute.mid.length > 0 ? ov.mute.mid : base.mute.mid,
        high: ov.mute?.high && ov.mute.high.length > 0 ? ov.mute.high : base.mute.high,
      },
      unmute: {
        low: ov.unmute?.low && ov.unmute.low.length > 0 ? ov.unmute.low : base.unmute.low,
        mid: ov.unmute?.mid && ov.unmute.mid.length > 0 ? ov.unmute.mid : base.unmute.mid,
        high: ov.unmute?.high && ov.unmute.high.length > 0 ? ov.unmute.high : base.unmute.high,
      },
    }
  }
  for (const personaId of Object.keys({ ...coldDefaults, ...coldOverride })) {
    const def = coldDefaults[personaId]
    const ov = coldOverride[personaId]
    if (!ov) {
      if (def) merged.coldStart[personaId] = def
      continue
    }
    const base = def ?? coldDefaults.default!
    merged.coldStart[personaId] = {
      greeting:
        ov.greeting && ov.greeting.length > 0 ? ov.greeting : base.greeting,
      chatReply:
        ov.chatReply && ov.chatReply.length > 0 ? ov.chatReply : base.chatReply,
    }
  }
  for (const personaId of Object.keys({ ...celebrateDefaults, ...celebrateOverride })) {
    const def = celebrateDefaults[personaId]
    const ov = celebrateOverride[personaId]
    if (!ov) {
      if (def) merged.celebrations[personaId] = def
      continue
    }
    const base = def ?? celebrateDefaults.default!
    merged.celebrations[personaId] = {
      aiSetup:
        ov.aiSetup && ov.aiSetup.length > 0 ? ov.aiSetup : base.aiSetup,
      advancedTts:
        ov.advancedTts && ov.advancedTts.length > 0
          ? ov.advancedTts
          : base.advancedTts,
    }
  }
  return merged
}

/**
 * Load lines.json at boot. Safe to call before any IPC handler runs;
 * if init hasn't been called, getLines() returns bundled defaults.
 */
export async function initLines(): Promise<void> {
  const path = getLinesFilePath()
  if (!existsSync(path)) {
    // No user override yet — defaults stay in `cached`. Don't
    // pre-create the file; that'd lock the user into our shape before
    // they decide to customize. The first "open lines file" click
    // will create it on demand (see ensureLinesFile).
    cached = PRESET_LINES_DEFAULTS
    return
  }
  try {
    const raw = await readFile(path, 'utf8')
    const json = JSON.parse(raw) as unknown
    const parsed = presetLinesSchema.parse(json)
    cached = mergeOnDefaults(parsed)
    console.log(`[lines] loaded user overrides from ${path}`)
  } catch (err) {
    console.warn(
      `[lines] failed to load ${path} — falling back to bundled defaults:`,
      err instanceof Error ? err.message : String(err),
    )
    cached = PRESET_LINES_DEFAULTS
  }
}

/** Sync accessor — what the IPC handler hands back to renderer. */
export function getLines(): PresetLines {
  return cached
}

/**
 * Random pick from the cold-start pool for a persona. Falls back through
 * persona → 'default' → a literal "please set up AI" string so callers
 * never need to defend against an empty array. Use this from greeting-
 * host and chat-host instead of poking into getLines() directly.
 */
export function pickColdStartLine(
  personaId: string,
  kind: 'greeting' | 'chatReply',
): string {
  const cs = cached.coldStart
  const pool = cs[personaId]?.[kind] ?? cs.default?.[kind] ?? []
  if (pool.length === 0) {
    return '请先在 Settings 里设置 AI。'
  }
  return pool[Math.floor(Math.random() * pool.length)]!
}

/**
 * Random pick from the celebration pool — same fallthrough rules as
 * pickColdStartLine. Used by the +5 celebration broadcast.
 */
export function pickCelebrationLine(
  personaId: string,
  kind: 'aiSetup' | 'advancedTts',
): string {
  const cb = cached.celebrations
  const pool = cb[personaId]?.[kind] ?? cb.default?.[kind] ?? []
  if (pool.length === 0) {
    return '配置完成了，谢谢。'
  }
  return pool[Math.floor(Math.random() * pool.length)]!
}

/**
 * Create the lines.json file with bundled defaults if it doesn't
 * exist. Returns the path either way. Used by the "open lines file"
 * button so notepad doesn't open an empty file.
 */
export async function ensureLinesFile(): Promise<string> {
  const path = getLinesFilePath()
  if (!existsSync(path)) {
    await mkdir(dirname(path), { recursive: true })
    const seed = JSON.stringify(PRESET_LINES_DEFAULTS, null, 2)
    await writeFile(path, seed, 'utf8')
    console.log(`[lines] seeded user file at ${path}`)
  }
  return path
}
