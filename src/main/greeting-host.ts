/**
 * On-launch greeting — the maid says hi when the app opens.
 *
 * Fires ONCE per main-process lifetime (an Electron-vite dev restart counts
 * as a new launch). Uses the existing `proactive:remark` broadcast channel
 * so the renderer's spontaneous-remark handler displays the bubble and TTS
 * speaks it — no new renderer wiring needed.
 *
 * Prompt is built via shared/daily-prompts so the operational tool-rule
 * block in chat.ts doesn't leak into casual moments.
 */

import { BrowserWindow } from 'electron'

import { runExtraction } from './chat-host.js'
import { getMemoryService } from './memory-host.js'
import { noteAssistantActivity } from './proactive-host.js'
import { getConfig } from './config.js'
import { resolvePersona } from '../shared/config.js'
import { buildGreetingPrompt } from '../shared/daily-prompts.js'
import { formatLocalNow } from '../shared/time-format.js'
import type { MemoryService } from '../core/memory/service.js'

/** Maximum chars of any one persisted message we replay into the greeting
 *  prompt. Replies can run hundreds of chars; truncating keeps the prompt
 *  small and forces the model to summarize the topic rather than parrot. */
const RECENT_EXCHANGE_MAX_CHARS_PER_MSG = 160

let greetedThisLaunch = false

/**
 * Pull the most recent natural-text exchange from memory and return it in
 * the shape the greeting prompt expects (oldest-to-newest user/assistant).
 *
 * What "natural" means here: we skip tool-role episodes, skip assistant
 * episodes whose `text` is empty (those were pure tool-call wrappers),
 * and trim each remaining message to MAX_CHARS so the prompt stays small.
 *
 * Why not just dump all recent N: tool noise + long replies would balloon
 * the greeting prompt; the model would then dwell on operational stuff
 * rather than picking up the human thread.
 */
async function getRecentExchange(
  memory: MemoryService,
): Promise<{ speaker: 'user' | 'assistant'; text: string }[]> {
  try {
    const episodes = await memory.listRecent(20)
    // Filter to natural-text turns and pick the trailing 4 — enough for
    // ~2 user-assistant pairs without bloating prompt context.
    const natural = episodes.filter(
      (e) =>
        (e.speaker === 'user' || e.speaker === 'assistant') &&
        e.text &&
        e.text.trim().length > 0,
    )
    const tail = natural.slice(-4)
    return tail.map((e) => ({
      speaker: e.speaker as 'user' | 'assistant',
      text:
        e.text.length > RECENT_EXCHANGE_MAX_CHARS_PER_MSG
          ? e.text.slice(0, RECENT_EXCHANGE_MAX_CHARS_PER_MSG) + '…'
          : e.text,
    }))
  } catch (err) {
    console.warn('[greeting] failed to read recent exchange:', err)
    return []
  }
}

/**
 * Wait until at least one renderer window has finished loading, then run
 * the greeting. The check is necessary because BrowserWindow.getAllWindows()
 * returns the window immediately after `new BrowserWindow()` — even before
 * the renderer process has booted, before the chat-event listener attaches.
 * Sending `proactive:remark` too early means the renderer never sees it.
 */
function waitForFirstReadyWindow(timeoutMs = 10_000): Promise<BrowserWindow | null> {
  return new Promise((resolve) => {
    const findReady = (): BrowserWindow | null => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed() && !w.webContents.isLoading()) return w
      }
      return null
    }
    const immediate = findReady()
    if (immediate) return resolve(immediate)

    const deadline = Date.now() + timeoutMs
    const tick = (): void => {
      const w = findReady()
      if (w) return resolve(w)
      if (Date.now() > deadline) return resolve(null)
      setTimeout(tick, 200)
    }
    tick()
  })
}

/**
 * Public entry — call once from main during boot. Idempotent; subsequent
 * calls no-op.
 */
export async function greetOnLaunch(): Promise<void> {
  if (greetedThisLaunch) return
  greetedThisLaunch = true

  const win = await waitForFirstReadyWindow()
  if (!win) {
    console.warn('[greeting] no ready window after timeout — skipping')
    return
  }
  // Tiny extra beat so the renderer's chat panel is mounted (window-loaded
  // fires when the document is loaded, but React might still be hydrating).
  await new Promise((r) => setTimeout(r, 500))

  const persona = resolvePersona(getConfig().persona)
  const now = formatLocalNow()
  const memory = getMemoryService()
  const userName = memory ? await memory.getUserName().catch(() => null) : null
  const recentExchange = memory ? await getRecentExchange(memory) : []

  let line = ''
  try {
    const raw = await runExtraction(
      buildGreetingPrompt({ persona, now, userName, recentExchange }),
      // Creative temperature — at 0.2 the maid would greet identically
      // every launch given the same time-of-day + persona.
      { temperature: 0.7 },
    )
    line = raw.trim()
  } catch (err) {
    console.warn('[greeting] LLM call failed, using fallback:', err)
  }
  // Fallback line — kept persona-neutral too. The persona's NAME is fine
  // to use (it's the character's own name, not an addressing assumption).
  if (!line) line = `（${persona.name}回来了。）`

  // Persist so the model remembers it spoke first this turn — otherwise
  // the very next user message would land in a session with no prior
  // assistant context and the model might re-greet.
  if (memory) {
    try {
      await memory.addEpisode('assistant', line)
    } catch (err) {
      console.warn('[greeting] failed to persist:', err)
    }
  }
  noteAssistantActivity()

  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      w.webContents.send('proactive:remark', {
        text: line,
        ts: new Date().toISOString(),
        triggers: ['greeting'],
      })
    }
  }
  console.log(`[greeting] ${line}`)
}
