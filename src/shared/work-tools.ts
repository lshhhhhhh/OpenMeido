/**
 * Single source of truth for "which tool calls count as work".
 *
 * Two consumers share this list:
 *   - src/main/chat/turn-classify.ts — `classifyTurnType` returns 'work'
 *     when any of these names appear, which drives reflection routing
 *     (work counter) and affinity skip.
 *   - src/renderer/src/App.tsx — message bubble `isWorkTurn` flag,
 *     drives the 💼 indicator next to the speaker icon.
 *
 * Before the merge, each side had its own list — main was an inclusion
 * list, renderer was an exclusion list — and they disagreed on
 * `presentTable`: main treated it as neutral, renderer treated it as
 * "not work". Symptom: a turn that ONLY called presentTable (e.g., the
 * user iterating on a filtered email table) showed no 💼 even though
 * it was clearly continuing the work flow. Fixed by putting
 * `presentTable` here and centralizing the definition.
 *
 * Heuristic for what belongs here:
 *   - Tool touches user's external data (email, files, web, search)
 *   - Tool produces structured output the user will act on (tables)
 *   - Tool is what a "productivity assistant" would call
 *
 * Excluded on purpose (lives in the "neutral / utility" bucket):
 *   - addTask / listTasks / markTaskDone — TODO management, more like
 *     a notepad than work
 *   - readClipboard — too generic; clipboard content is often personal
 */

export const WORK_TOOLS = [
  'listMailFolders',
  'listRecentEmails',
  'readEmail',
  'draftEmailReply',
  'readFile',
  'readWebPage',
  'google_search',
  'presentTable',
] as const

export type WorkToolName = (typeof WORK_TOOLS)[number]

export function isWorkToolName(name: string): boolean {
  return (WORK_TOOLS as readonly string[]).includes(name)
}
