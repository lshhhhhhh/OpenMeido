/**
 * Read the running app's memory.sqlite and dump episode counts by session.
 * Helps diagnose "memory tab shows 0 entries" — tells us whether writes
 * are silently failing vs the renderer is misreading.
 *
 * Run: npx electron tools/inspect-memory.mjs
 */

import { app } from 'electron'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

// When run via `npx electron <script>`, Electron uses the default app name
// ("Electron") instead of the OpenMeido app's. Override to match what the
// real app actually writes to.
app.setName('openmeido')

app
  .whenReady()
  .then(() => {
    const dbPath = join(app.getPath('userData'), 'memory.sqlite')
    console.log('DB path:', dbPath)
    if (!existsSync(dbPath)) {
      console.log('❌ DB file does not exist')
      app.exit(1)
      return
    }

    const db = new Database(dbPath, { readonly: true })

    const total = db.prepare('SELECT COUNT(*) AS c FROM episodes').get().c
    console.log(`\nTotal episodes: ${total}`)

    const bySession = db
      .prepare(
        `SELECT COALESCE(session_id, '(null)') AS sid, COUNT(*) AS count,
                MIN(ts) AS firstTs, MAX(ts) AS lastTs
         FROM episodes
         GROUP BY session_id
         ORDER BY MAX(ts) DESC`,
      )
      .all()
    console.log('\nGrouped by session_id:')
    for (const r of bySession) {
      console.log(
        `  ${r.sid}  count=${r.count}  first=${r.firstTs}  last=${r.lastTs}`,
      )
    }

    const recent = db
      .prepare(
        `SELECT id, ts, speaker, session_id, substr(text, 1, 50) AS preview
         FROM episodes
         ORDER BY id DESC
         LIMIT 15`,
      )
      .all()
    console.log('\nRecent 15 episodes:')
    for (const r of recent) {
      const sid = r.session_id ? r.session_id.slice(0, 8) : '(null)'
      console.log(`  #${r.id}  ${r.ts}  sid=${sid}  ${r.speaker}: ${r.preview}`)
    }

    db.close()
    app.exit(0)
  })
  .catch((err) => {
    console.error('crashed:', err)
    app.exit(1)
  })
