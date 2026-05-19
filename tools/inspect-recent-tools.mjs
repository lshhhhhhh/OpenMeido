/**
 * Dump the most-recent N episodes with their tool_data — used to debug
 * "model didn't use the prior list result" issues. Read-only; safe to run
 * while the app is up.
 *
 * Run: node tools/inspect-recent-tools.mjs
 */

import { DatabaseSync as Database } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const dbPath = join(process.env.APPDATA, 'openmeido', 'memory.sqlite')
if (!existsSync(dbPath)) {
  console.error('DB not found at', dbPath)
  process.exit(1)
}

const db = new Database(dbPath, { readOnly: true })

const rows = db
  .prepare(
    `SELECT id, ts, speaker, session_id, substr(text, 1, 80) AS preview, tool_data
     FROM episodes ORDER BY id DESC LIMIT 30`,
  )
  .all()
  .reverse()

for (const r of rows) {
  const sid = r.session_id ? r.session_id.slice(0, 6) : '------'
  console.log(`#${r.id} [${sid}] ${r.speaker.padEnd(9)} ${r.preview}`)
  if (r.tool_data) {
    try {
      const parts = JSON.parse(r.tool_data)
      for (const p of parts) {
        if (p.type === 'tool-call') {
          console.log(
            `    └─ call ${p.toolName}(${JSON.stringify(p.input).slice(0, 80)}) id=${p.toolCallId}`,
          )
        } else if (p.type === 'tool-result') {
          const out = JSON.stringify(p.output).slice(0, 120)
          console.log(`    └─ result ${p.toolName} id=${p.toolCallId} → ${out}…`)
        }
      }
    } catch {
      console.log(`    └─ (unparseable tool_data: ${r.tool_data.slice(0, 80)}…)`)
    }
  }
}

db.close()
