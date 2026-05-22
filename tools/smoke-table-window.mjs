/**
 * Smoke test for the table-window pipeline. Spawns an Electron app,
 * invokes openTableWindow with fixture data, and reports whether the
 * window successfully loaded the table.html page. Bypasses the LLM
 * and IMAP entirely so we can pinpoint whether the "no window pops"
 * symptom is in:
 *
 *   - table.html path resolution (dev vs packaged)
 *   - BrowserWindow creation
 *   - hash encoding / URL construction
 *
 * If THIS test shows the window loads, the bug is upstream (model
 * not calling presentTable, or IMAP hanging). If it FAILS, the bug
 * is in src/main/table-host.ts or src/renderer/public/table.html.
 *
 * Run: npm run test:table-window
 */

import { app, BrowserWindow } from 'electron'

async function main() {
  const { register } = await import('tsx/esm/api')
  register()
  const { openTableWindow } = await import('../src/main/table-host.ts')

  await app.whenReady()

  // v0.0.29: rows is array-of-arrays (position-aligned to columns).
  // Deliberately synthetic data — no real names, projects, or workflow
  // details. Test fixtures must not leak anything from a real user's
  // inbox into the repo.
  const fixture = {
    title: '示例表格 (smoke)',
    columns: ['序号', '发件人', '主题', '最新进展', '时间'],
    rows: [
      [1, 'alpha@example.test', '虚构项目 A 验收', '占位文本：第一行示例进展', '示例时间 1'],
      [2, 'beta@example.test', '虚构项目 B 评审', '占位文本：第二行示例进展', '示例时间 2'],
      [3, 'gamma@example.test', '虚构项目 C 周报', '占位文本：第三行示例进展', '示例时间 3'],
    ],
  }

  console.log('[smoke] calling openTableWindow with fixture...')
  openTableWindow(fixture, {})

  // Capture load events from any new window. Mirror the diagnostics we
  // wired into table-host so the test report is self-contained.
  let loaded = false
  let failed = null
  const onCreate = (_event, win) => {
    win.webContents.on('did-finish-load', () => {
      console.log(`[smoke] window did-finish-load url=${win.webContents.getURL()}`)
      loaded = true
    })
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.warn(
        `[smoke] window did-fail-load code=${code} desc="${desc}" url="${url}"`,
      )
      failed = { code, desc, url }
    })
  }
  app.on('browser-window-created', onCreate)
  // Pick up the one we just opened too — order of events vs callback
  // registration isn't guaranteed across Electron versions.
  for (const win of BrowserWindow.getAllWindows()) onCreate(null, win)

  // Wait up to 5s for the load to complete.
  const start = Date.now()
  while (Date.now() - start < 5000) {
    if (loaded || failed) break
    await new Promise((r) => setTimeout(r, 100))
  }

  console.log(`\n[smoke] result: loaded=${loaded} failed=${failed ? JSON.stringify(failed) : 'no'}`)
  console.log(`[smoke] open windows: ${BrowserWindow.getAllWindows().length}`)
  for (const w of BrowserWindow.getAllWindows()) {
    console.log(`  · "${w.getTitle()}" visible=${w.isVisible()} url=${w.webContents.getURL()}`)
  }

  // Give the user 8 more seconds to visually confirm before quitting.
  console.log('\n[smoke] keeping window open for 8s for visual inspection...')
  await new Promise((r) => setTimeout(r, 8000))

  app.quit()
  if (!loaded) process.exit(1)
}

main().catch((err) => {
  console.error('[smoke] crashed:', err)
  process.exit(1)
})
