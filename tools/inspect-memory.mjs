#!/usr/bin/env node
/**
 * Read the user's actual OpenMeido memory.sqlite + config.json and
 * dump the most recent episodes for the currently active persona.
 *
 * Use this when iterating on prompts that affect what the maid says —
 * lets the debug session see what she ACTUALLY said in the user's
 * running app, rather than only what isolated test scripts produce.
 *
 * Paths (Windows):
 *   - config:  %APPDATA%\openmeido\config.json
 *   - memory:  %APPDATA%\openmeido\memory.sqlite
 *
 * Plain node (no electron). better-sqlite3 is a native module that
 * loads fine outside electron. Database opened read-only so a
 * concurrently running dev app stays unaffected.
 *
 * Usage:
 *   node tools/inspect-memory.mjs              # last 30 episodes
 *   node tools/inspect-memory.mjs 100          # last 100
 *   node tools/inspect-memory.mjs 30 imouto    # override persona
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
// Use Node 22+'s built-in sqlite (no native compilation) instead of
// better-sqlite3 — the project's bundled better-sqlite3 is compiled
// against Electron's Node ABI, which a plain `node` binary can't load.
import { DatabaseSync } from 'node:sqlite'

function userDataDir() {
  if (process.platform === 'win32') return join(process.env.APPDATA, 'openmeido')
  if (process.platform === 'darwin')
    return join(process.env.HOME, 'Library', 'Application Support', 'openmeido')
  return join(process.env.HOME, '.config', 'openmeido')
}

function readActivePersona(dir) {
  const cfgPath = join(dir, 'config.json')
  if (!existsSync(cfgPath)) return 'maid'
  try {
    return JSON.parse(readFileSync(cfgPath, 'utf-8'))?.persona?.preset ?? 'maid'
  } catch {
    return 'maid'
  }
}

function readAffinity(db, personaId) {
  try {
    return db
      .prepare(
        'SELECT score, last_updated, last_reason, last_milestone FROM persona_affinity WHERE persona_id = ?',
      )
      .get(personaId)
  } catch (err) {
    // Older DBs (pre-affinity) won't have this table — silent miss is fine.
    return null
  }
}

function tagFor(speaker) {
  if (speaker === 'user') return '👤 USER     '
  if (speaker === 'tool') return '🔧 TOOL     '
  return '💬 ASSISTANT'
}

function fmt(iso) {
  const d = new Date(iso)
  return (
    d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) +
    ' ' +
    d.toLocaleTimeString('zh-CN', { hour12: false })
  )
}

const argLimit = Number(process.argv[2])
const limit = Number.isFinite(argLimit) && argLimit > 0 ? argLimit : 30
const personaOverride = process.argv[3]

const dir = userDataDir()
console.log(`userData = ${dir}`)

const dbPath = join(dir, 'memory.sqlite')
if (!existsSync(dbPath)) {
  console.error(`memory.sqlite not found at ${dbPath}. App never launched?`)
  process.exit(1)
}

const personaId = personaOverride || readActivePersona(dir)
console.log(`active persona = ${personaId}`)

const db = new DatabaseSync(dbPath, { readOnly: true })

const aff = readAffinity(db, personaId)
if (aff) {
  console.log(
    `affinity: ${aff.score}/100 · milestone ${aff.last_milestone} · ${aff.last_updated}`,
  )
  if (aff.last_reason) console.log(`  reason: ${aff.last_reason}`)
}

// node:sqlite uses positional bindings; cast types for safety.
const rows = db
  .prepare(
    `SELECT id, ts, speaker, text, session_id, tool_data
     FROM episodes
     WHERE archived = 0 AND persona_id = ?
     ORDER BY id DESC
     LIMIT ?`,
  )
  .all(personaId, limit)
  .reverse() // chronological for reading

console.log(`\n──── last ${rows.length} episode(s) (oldest first) ────\n`)

for (const r of rows) {
  let toolNote = ''
  if (r.tool_data) {
    try {
      const parts = JSON.parse(r.tool_data)
      const names = parts
        .filter((p) => p.type === 'tool-call')
        .map((p) => p.toolName)
      if (names.length > 0) toolNote = `  [${names.join(', ')}]`
    } catch {
      /* ignore */
    }
  }
  const text = r.text.length > 400 ? r.text.slice(0, 400) + '…' : r.text
  console.log(`#${r.id} ${tagFor(r.speaker)} ${fmt(r.ts)}${toolNote}`)
  console.log(`  ${text.replace(/\n/g, '\n  ')}`)
  console.log()
}

db.close()
