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

/**
 * Demo-mode line pools used BEFORE the user has configured an AI backend.
 * Without an API key the LLM paths can't run, so we play hardcoded lines
 * via TTS (Edge TTS works with no user credentials) to keep the app
 * feeling alive — every line is required to nudge toward Settings
 * because the dead "nothing happens" state is the bigger UX problem.
 *
 *   greeting  — said by greetOnLaunch when no AI is configured
 *   chatReply — used as the assistant reply whenever the user sends a
 *               chat message but the AI still isn't set up. Different
 *               pool from greeting so the user doesn't hear the same
 *               line twice in a row.
 */
const coldStartPersonaPoolSchema = z
  .object({
    greeting: lineList,
    chatReply: lineList,
  })
  .default({})

/**
 * One-shot celebration lines fired when the user crosses a setup
 * milestone — currently 'aiSetup' (first API key) and 'advancedTts'
 * (first non-edge TTS backend). Spoken via the same proactive:remark
 * channel as the greeting, with extra +5 affinity overlay UX in the
 * renderer.
 */
const celebrationPersonaPoolSchema = z
  .object({
    aiSetup: lineList,
    advancedTts: lineList,
  })
  .default({})

export const presetLinesSchema = z
  .object({
    /** Per-persona mute/unmute pools. Keys: 'maid' / 'imouto' / 'ojou'
     *  for built-ins; 'default' for the custom-persona fallback. Any
     *  extra key is preserved (custom-persona id matches it). */
    mute: z.record(z.string(), mutePersonaPoolSchema).default({}),
    /** Per-persona cold-start (no-AI) pools. Same key conventions as mute. */
    coldStart: z.record(z.string(), coldStartPersonaPoolSchema).default({}),
    /** Per-persona celebration pools, same keying conventions. */
    celebrations: z.record(z.string(), celebrationPersonaPoolSchema).default({}),
  })
  .default({})

export type PresetLinesInput = z.input<typeof presetLinesSchema>
export type PresetLinesParsed = z.output<typeof presetLinesSchema>
