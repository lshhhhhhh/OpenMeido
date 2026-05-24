/**
 * Persona-lore host — wires the lore-seeding pipeline to IPC.
 *
 * Flow:
 *   1. Wizard / Settings calls `persona:seed-lore` with (personaId, archetype).
 *   2. We look up the lore pack in shared/persona-lore.ts.
 *   3. Wipe any existing lore episodes + anchor facts for this persona
 *      (idempotent — switching archetypes won't leave stale rows).
 *   4. Write the new anchor facts (scope='persona', injected into every
 *      system prompt via factsBlock).
 *   5. Embed + write the new lore episodes (kind='lore', filtered from
 *      recent windows but indexed in vec0 for RAG retrieval).
 *
 * If the persona has no lore pack configured (imouto / butler / ojou
 * currently), the call resolves with `{ ok: true, seeded: 0 }` — a
 * no-op, not an error. That keeps the wizard's "skip archetype"
 * branch safe for personas that haven't gotten lore packs yet.
 *
 * Concurrency: seeding runs serially per call. Each anchor fact + lore
 * episode is awaited so a slow embed model doesn't drop the tail.
 */

import { ipcMain } from 'electron'

import { getMemoryService } from './memory-host.js'
import { getArchetypeLore, type PersonaArchetype } from '../shared/persona-lore.js'

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
 * Wipe + re-seed lore for a (persona, archetype) pair. Safe to call
 * repeatedly; the wipe step makes it idempotent. Called by the wizard
 * after archetype pick, and by Settings if the user changes archetype
 * later.
 */
export async function seedPersonaLore(
  personaId: string,
  archetype: PersonaArchetype,
): Promise<SeedLoreResult> {
  const memory = getMemoryService()
  if (!memory) {
    return { ok: false, loreSeeded: 0, anchorsSeeded: 0, error: 'memory service unavailable' }
  }

  const pack = getArchetypeLore(personaId, archetype)
  if (!pack) {
    // No lore configured for this persona+archetype — silent no-op.
    // (e.g. butler hasn't gotten lore packs yet; wizard still works.)
    return { ok: true, loreSeeded: 0, anchorsSeeded: 0 }
  }

  try {
    // Step 1: wipe prior lore episodes + anchor facts for this persona.
    await memory.clearLore(personaId)
    await memory.clearFactsByPrefix(personaId, ANCHOR_KEY_PREFIX)

    // Step 2: write anchor facts. These appear in every system prompt
    // for this persona via factsBlock's scope='persona' inclusion.
    let anchors = 0
    for (const { key, value } of pack.anchorFacts) {
      await memory.seedAnchorFact(personaId, key, value)
      anchors++
    }

    // Step 3: write lore episodes. Each one gets a real embedding so RAG
    // can surface it by topical similarity. seedLoreEpisode awaits per
    // call so a slow embed model doesn't lose the tail of the array.
    let lore = 0
    for (const text of pack.loreEpisodes) {
      const id = await memory.seedLoreEpisode(personaId, text)
      if (id !== null) lore++
    }

    console.log(
      `[persona-lore] seeded ${personaId}/${archetype}: ${anchors} anchors + ${lore}/${pack.loreEpisodes.length} lore episodes`,
    )
    return { ok: true, loreSeeded: lore, anchorsSeeded: anchors }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[persona-lore] seed failed for ${personaId}/${archetype}:`, err)
    return { ok: false, loreSeeded: 0, anchorsSeeded: 0, error: message }
  }
}

/**
 * Register the IPC endpoint. Called once from main/index.ts during
 * app boot, BEFORE the renderer can fire the wizard's seed action.
 */
export function registerPersonaLoreIpc(): void {
  ipcMain.handle(
    'persona:seed-lore',
    async (
      _e,
      payload: { personaId: string; archetype: PersonaArchetype },
    ): Promise<SeedLoreResult> => {
      if (!payload || typeof payload.personaId !== 'string' || !payload.archetype) {
        return {
          ok: false,
          loreSeeded: 0,
          anchorsSeeded: 0,
          error: 'invalid payload',
        }
      }
      return seedPersonaLore(payload.personaId, payload.archetype)
    },
  )
}
