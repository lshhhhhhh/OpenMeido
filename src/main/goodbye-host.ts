/**
 * "Goodbye to memory" on app close — explicitly NOT a goodbye the user
 * hears or sees. Earlier versions blocked quit, fired LLM + TTS, and
 * waited ~2.5s. That produced a clipped-mid-word maid voice playing
 * after the user had already closed the window — felt haunted, not
 * warm. The right moment to acknowledge the user is on the NEXT launch
 * (greeting-host reads recent assistant turns and can naturally say
 * "上次没好好道别，主人..."), not now.
 *
 * What we still do: synchronously kick off an LLM call to generate a
 * "what she would have said" line and persist it as an assistant
 * episode. Fire-and-forget; we let the quit proceed without waiting.
 * If the LLM is slow the line never lands, which is fine — the memory
 * hole just means next launch's greeting opens cold.
 */

import { app } from 'electron'

import { runExtraction } from './chat-host.js'
import { getMemoryService } from './memory-host.js'
import { getConfig } from './config.js'
import { resolvePersona } from '../shared/config.js'
import { buildGoodbyePrompt } from '../shared/daily-prompts.js'
import { formatLocalNow } from '../shared/time-format.js'

let kickedOffOnce = false

/**
 * Wire the close hook. Call once during app boot.
 */
export function initGoodbye(): void {
  app.on('before-quit', () => {
    if (kickedOffOnce) return
    kickedOffOnce = true
    // Fire-and-forget — do NOT block the quit. The user wants out;
    // honor that immediately. If the LLM call finishes in time, great
    // — the line lands in memory for next launch. If the main process
    // dies first, the orphaned promise just gets killed.
    void persistGoodbye()
  })
}

async function persistGoodbye(): Promise<void> {
  const persona = resolvePersona(getConfig().persona)
  const now = formatLocalNow()
  const memory = getMemoryService()
  if (!memory) return
  const userName = await memory.getUserName().catch(() => null)

  let line = ''
  try {
    const raw = await runExtraction(buildGoodbyePrompt({ persona, now, userName }), {
      temperature: 0.7,
    })
    line = raw.trim()
  } catch {
    /* LLM unreachable — just skip; next greeting will open cold */
    return
  }
  if (!line) return

  try {
    await memory.addEpisode('assistant', line)
    console.log(`[goodbye→memory] ${line}`)
  } catch (err) {
    console.warn('[goodbye] failed to persist:', err)
  }
}
