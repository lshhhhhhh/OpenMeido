/**
 * Barrel for the chat subsystem. The implementation lives under
 * `src/main/chat/*` — split out of one 1959-LOC file in v0.0.35 so each
 * tool, the agent loop, and shared helpers each have their own home.
 *
 * Re-exports here keep the public surface that callers and smoke tests
 * have always imported from `./chat.js`:
 *   - runChat               (src/main/index.ts — the agent loop entry)
 *   - classifyTurnType      (tools/smoke-turn-classification.mjs)
 *   - isRetractionOrCorrection (tools/smoke-memory-negation.mjs)
 *   - readEmail, draftEmailReply (tools/smoke-user-bugs-repro.mjs)
 */

export { runChat } from './chat/run.js'
export { classifyTurnType, isRetractionOrCorrection } from './chat/turn-classify.js'
export { readEmail, draftEmailReply } from './chat/tools/mail.js'
