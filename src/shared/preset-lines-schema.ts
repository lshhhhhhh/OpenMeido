/**
 * Zod schema for the user-editable preset台词 file.
 *
 * Lives at `%APPDATA%/openmeido/lines.json`. User can hand-edit with
 * notepad; we validate at load time and fall back to bundled defaults
 * if the file is missing, malformed, or partially wrong.
 *
 * Schema is lenient on purpose:
 *   - every nested key has a sensible default → user can drop fields
 *     and we fill them in from bundled defaults
 *   - arrays default to [] → an empty `mute.maid.mute.low` array won't
 *     fail validation; the picker handles empty pools by falling
 *     through to '...' (defensive, not catastrophic)
 *
 * The merge step (see lines-host.ts) does a deep merge of user
 * overrides on top of bundled defaults, so a partial override file is
 * the expected case — most users only want to tweak a few lines, not
 * redefine the whole pool.
 */

import { z } from 'zod'

const lineList = z.array(z.string().min(1)).default([])

const tierBucketTriple = z
  .object({
    low: lineList,
    mid: lineList,
    high: lineList,
  })
  .default({})

const mutePersonaPoolSchema = z
  .object({
    mute: tierBucketTriple,
    unmute: tierBucketTriple,
  })
  .default({})

export const presetLinesSchema = z
  .object({
    /** Per-persona mute/unmute pools. Keys: 'maid' / 'imouto' / 'ojou'
     *  for built-ins; 'default' for the custom-persona fallback. Any
     *  extra key is preserved (custom-persona id matches it). */
    mute: z.record(z.string(), mutePersonaPoolSchema).default({}),
  })
  .default({})

export type PresetLinesInput = z.input<typeof presetLinesSchema>
export type PresetLinesParsed = z.output<typeof presetLinesSchema>
