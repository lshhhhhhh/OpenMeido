/**
 * Persona-lore host — wires the lore-seeding pipeline to IPC.
 *
 * Flow:
 *   1. Wizard / Settings calls `persona:seed-lore` with personaId.
 *   2. We look up the lore pack in shared/persona-lore.ts.
 *   3. Wipe any existing lore episodes + anchor facts for this persona
 *      (idempotent — re-seeding is safe).
 *   4. Write new anchor facts (scope='persona', injected into every
 *      system prompt via factsBlock).
 *   5. Embed + write the new lore episodes (kind='lore', filtered from
 *      recent windows but indexed in vec0 for RAG retrieval).
 *
 * Personas without a lore pack (butler, ojou, custom): the call
 * resolves with `{ ok: true, anchorsSeeded: 0, loreSeeded: 0 }` — a
 * silent no-op, not an error.
 *
 * Concurrency: seeding runs serially. Each anchor + lore episode is
 * awaited so a slow embed model doesn't drop the tail.
 */

import { ipcMain } from 'electron'

import { getMemoryService, onNaiveModeExit } from './memory-host.js'
import { getConfig } from './config.js'
import { getPersonaLore } from '../shared/persona-lore.js'

const ANCHOR_KEY_PREFIX = 'persona.relationship.'

export interface SeedLoreResult {
  ok: boolean
  /** How many lore episodes were written; 0 means the persona has no pack. */
  loreSeeded: number
  /** How many anchor facts were written. */
  anchorsSeeded: number
  /** Any error message; empty on success. */
  error?: string
}

/**
 * Wipe + re-seed lore for a persona. Idempotent — safe to call
 * repeatedly. Called by the wizard after persona pick and by Settings
 * via the "重新种入" button.
 */
export async function seedPersonaLore(personaId: string): Promise<SeedLoreResult> {
  const memory = getMemoryService()
  if (!memory) {
    return { ok: false, loreSeeded: 0, anchorsSeeded: 0, error: 'memory service unavailable' }
  }

  const pack = getPersonaLore(personaId)
  if (!pack) {
    // No lore configured for this persona — silent no-op. butler /
    // ojou / custom personas hit this path; wizard still saves the
    // persona pick without complaint.
    return { ok: true, loreSeeded: 0, anchorsSeeded: 0 }
  }

  try {
    // Step 1: wipe prior lore episodes + anchor facts for this persona.
    await memory.clearLore(personaId)
    await memory.clearFactsByPrefix(personaId, ANCHOR_KEY_PREFIX)

    // Step 2: write anchor facts. Show up in every system prompt for
    // this persona via factsBlock's scope='persona' inclusion.
    let anchors = 0
    for (const { key, value } of pack.anchorFacts) {
      await memory.seedAnchorFact(personaId, key, value)
      anchors++
    }

    // Step 3: write lore episodes. Each gets a real embedding so RAG
    // can surface it by topical similarity. seedLoreEpisode awaits
    // per call so a slow embed model doesn't lose the tail.
    let lore = 0
    for (const text of pack.loreEpisodes) {
      const id = await memory.seedLoreEpisode(personaId, text)
      if (id !== null) lore++
    }

    console.log(
      `[persona-lore] seeded ${personaId}: ${anchors} anchors + ${lore}/${pack.loreEpisodes.length} lore episodes`,
    )
    return { ok: true, loreSeeded: lore, anchorsSeeded: anchors }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[persona-lore] seed failed for ${personaId}:`, err)
    return { ok: false, loreSeeded: 0, anchorsSeeded: 0, error: message }
  }
}

/**
 * Register the IPC endpoint + the naive→full transition hook.
 * Called once from main/index.ts during boot.
 */
export function registerPersonaLoreIpc(): void {
  ipcMain.handle(
    'persona:seed-lore',
    async (_e, payload: { personaId: string }): Promise<SeedLoreResult> => {
      if (!payload || typeof payload.personaId !== 'string') {
        return {
          ok: false,
          loreSeeded: 0,
          anchorsSeeded: 0,
          error: 'invalid payload',
        }
      }
      return seedPersonaLore(payload.personaId)
    },
  )

  // When the embed model finishes downloading mid-session, lore
  // episodes that silently skipped during naive-mode seeding (embed
  // throw → seeder swallowed → 0 episodes written) get auto-replayed
  // here. Anchor facts persist OK without embeddings, so they don't
  // need this catch-up. Only fires if the active persona has a pack.
  onNaiveModeExit(() => {
    const cfg = getConfig()
    const personaId = cfg.persona.preset
    const pack = getPersonaLore(personaId)
    if (!pack) return
    console.log(
      `[persona-lore] naive→full transition — re-seeding ${personaId}`,
    )
    seedPersonaLore(personaId).catch((err) => {
      console.warn('[persona-lore] auto-reseed on naive-exit failed:', err)
    })
  })
}
