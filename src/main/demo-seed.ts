/**
 * Demo-mode data seeding. Runs once after the normal app boot finishes,
 * but only when `--demo` is on argv. Populates the sandbox profile
 * (see demo-mode.ts for the separate userData path) with:
 *
 *   - 3 L3 facts about the "demo user" — so callback / "she remembers
 *     you" moments fire naturally during a demo without grinding chat
 *   - affinity → 50 (Lv.3 acquaintance) on the active persona — same
 *     reason: stranger-tier defaults read as cold and don't show off
 *     the tier-driven trait system
 *   - 3 demo tasks — so the "📋 任务清单" quick-action button has
 *     something to show
 *
 * Idempotent on facts + affinity (upsert / set semantics). Tasks would
 * dup on each launch, so we check existing count first and skip when
 * the demo profile already has any.
 *
 * Bypasses the affinity dev-override skip-on-reset guard because the
 * point IS to set a baseline. Bypasses the daily-cap because this
 * isn't a normal +1 / -1 judgement.
 */

import { isDemoMode } from './demo-mode.js'
import { getMemoryService, getMemoryAdapter } from './memory-host.js'
import { getTaskService } from './tasks-host.js'
import { getConfig } from './config.js'
import { setAffinityForTest } from './affinity-host.js'

const DEMO_FACTS = [
  { key: 'user.preferred_address', value: '主人' },
  { key: 'user.occupation', value: '产品经理' },
  { key: 'user.interest', value: '桌面伴侣 / Live2D / 独立软件' },
]

const DEMO_TASKS = [
  '回邮件给设计师 (PRD v2 评审)',
  '15:00 之前提交本周 OKR 进展',
  '周末读一下《xxx》',
]

const DEMO_AFFINITY = 50 // Lv.3 acquaintance — warm but not over-familiar

export async function seedDemoData(): Promise<void> {
  if (!isDemoMode()) return

  const memory = getMemoryService()
  const adapter = getMemoryAdapter()
  const tasks = getTaskService()
  const cfg = getConfig()
  const personaId = cfg.persona.preset

  // Facts — upsert is idempotent so re-seeding is safe. Use the adapter
  // directly (service.upsertFact requires the LLM-extraction tags we
  // don't have at seed time).
  if (adapter) {
    for (const f of DEMO_FACTS) {
      try {
        await adapter.upsertFact(personaId, { key: f.key, value: f.value })
      } catch (err) {
        console.warn(`[demo-seed] fact ${f.key} failed:`, err)
      }
    }
  }

  // Affinity — set hard via the test path so we bypass per-turn clamp /
  // daily cap. Single source of truth: affinity-host.setAffinityForTest.
  try {
    await setAffinityForTest(personaId, DEMO_AFFINITY, 'demo seed')
  } catch (err) {
    console.warn('[demo-seed] affinity seed failed:', err)
  }

  // Tasks — only add when the demo profile is fresh (no tasks yet).
  // Otherwise every launch piles 3 more onto the existing list and
  // the demo gets noisy.
  if (tasks) {
    try {
      const existing = await tasks.listAll()
      if (existing.length === 0) {
        for (const text of DEMO_TASKS) {
          await tasks.add({ text })
        }
      }
    } catch (err) {
      console.warn('[demo-seed] tasks seed failed:', err)
    }
  }

  console.log(`[demo-seed] applied · persona=${personaId} affinity=${DEMO_AFFINITY}`)
}
