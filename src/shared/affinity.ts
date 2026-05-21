/**
 * Affinity (好感度) engine — pure functions for tier mapping + guardrail
 * application. No I/O, no LLM calls; the host wires this between the
 * judge's raw output and the storage layer.
 *
 * The score is a single integer 0-100. Tiers carve that range into four
 * buckets that drive prompt modulation downstream:
 *
 *   0-20   生疏  — strangers; she uses formal address, declines to use
 *                 the persona's signature term (主人 / 哥 / etc), keeps
 *                 distance.
 *   21-50  熟络  — acquaintances; persona signature now in play, still
 *                 reserved on intimate behaviors (撒娇 / 顶嘴 / inside
 *                 jokes).
 *   51-80  亲近  — close;撒娇 / 顶嘴 / callbacks to shared history.
 *   81-100 默契  — deep bond; banter, inside-joke style references.
 *
 * Floor of 30 ensures that a returning user after a long absence never
 * faces a "she forgot me" full reset — she's distant but recognizable.
 * Day-zero installs start at 0 because the relationship genuinely
 * hasn't happened yet. Existing-user migration seeds higher than 0 to
 * acknowledge their prior chat history (see memory-host backfill).
 */

export type Tier = 'tier1' | 'tier2' | 'tier3' | 'tier4' | 'tier5'

export interface TierInfo {
  tier: Tier
  /** Short label shown in UI — no character name, just the number.
   *  Field still called `zhLabel` for backward compat with renderer
   *  code; value is "Lv.X" form. */
  zhLabel: string
  /** Lower bound (inclusive) of this tier's score range. */
  min: number
  /** Upper bound (inclusive) of this tier's score range. */
  max: number
}

/**
 * Per-tier {address, traits} pair — each tier's entry is the **delta**
 * unlocked at that tier. The engine concatenates lower tiers' traits
 * when assembling a higher tier's prompt. tier1 has no traits by
 * design (cold-start equivalent: model uses formal "您", no character
 * specifics). tier2-tier5 each unlock a layer.
 */
export interface PersonaTraits {
  tier2: { address: string; traits: string[] }
  tier3: { address: string; traits: string[] }
  tier4: { address: string; traits: string[] }
  tier5: { address: string; traits: string[] }
}

/**
 * Five equal-width tiers (20 points each). Five was deliberately picked
 * over four for finer gradation — a +5 affinity gain has meaningful odds
 * of crossing a tier boundary (= visible behavior change). Names dropped
 * per user request: numbers stay neutral and don't tempt the model to
 * "perform" the label.
 */
export const TIERS: TierInfo[] = [
  { tier: 'tier1', zhLabel: 'Lv.1', min: 0,  max: 19 },
  { tier: 'tier2', zhLabel: 'Lv.2', min: 20, max: 39 },
  { tier: 'tier3', zhLabel: 'Lv.3', min: 40, max: 59 },
  { tier: 'tier4', zhLabel: 'Lv.4', min: 60, max: 79 },
  { tier: 'tier5', zhLabel: 'Lv.5', min: 80, max: 100 },
]

export const AFFINITY_MIN = 0
export const AFFINITY_MAX = 100
/** Decay floor — score never drops below this. The user has chatted with
 *  her before; she shouldn't act like a stranger again no matter how long
 *  the absence. Initial-state zero is allowed to live below this; the
 *  floor only applies once any positive interaction has occurred. */
export const AFFINITY_DECAY_FLOOR = 30
/** Max ±delta a single LLM judgment can move the score in one turn. */
export const PER_TURN_DELTA_CLAMP = 2
/** Max total |delta| accumulated across one calendar day. */
export const PER_DAY_DELTA_CAP = 10
/** During the first N turns of relationship history, multiply incoming
 *  deltas by this factor. Stops a single warm exchange on day-one from
 *  vaulting the user to "亲近" in five turns. */
export const COLD_START_DAMPING = 0.5
/** How many turns are "cold start". After this many lifetime turns with
 *  this persona, deltas land at full strength. */
export const COLD_START_TURN_COUNT = 20
/** Score ceiling for passive presence accrual. Above this, time-on-app
 *  alone doesn't move the score — past Lv.3 requires real interaction
 *  to advance. Prevents users from grinding to deep tier just by
 *  leaving the window open. */
export const PRESENCE_SCORE_CEILING = 40

/**
 * Build the instruction block that gets appended to the persona system
 * prompt. Each tier has a distinct "how to treat this user" rule set —
 * stranger keeps distance, deep uses callbacks + banter.
 *
 * When `traits` is provided (built-in personas), the block weaves in
 * persona-specific address terms + personality cues at the right tier
 * so each persona escalates *its own* archetype. Without traits (custom
 * personas), the block falls back to generic tier wording.
 *
 * Kept reasonably short: ~200 tokens per call. Tier prompts dominate
 * the persona prompt on the warmth axis by design — both because they
 * come AFTER the persona prompt in the system message AND because they
 * use stronger imperative language ("DO" / "DO NOT" rather than
 * descriptive adjectives).
 */
export function buildTierPromptBlock(
  score: number,
  personaName: string,
  traits?: PersonaTraits,
): string {
  const t = tierFor(score)
  const header = `# 你和用户的关系\n好感度 ${score} / 100（${t.zhLabel}）。`
  switch (t.tier) {
    case 'tier1':
      // Cold start equivalent — no traits, formal address.
      return (
        header +
        `\n` +
        `你和用户才刚见面。等同于"初识的陌生人"，**不是**"已经熟悉的旧识"。\n` +
        `- **不要使用任何亲密称呼**（主人 / 哥 / 本小姐 / 笨蛋 等都不要）。用"您"或不称呼。\n` +
        `- **不要展露温柔 / 撒娇 / 害羞 / 关心 / 忠诚 / 顶嘴 / 傲娇**——这些都是态度，现在还没到展露的时候。\n` +
        `- 用户问什么答什么。短、得体、专业，**不延伸不主动开话题**。\n` +
        `- 不主动嘘寒问暖。不说"我会陪着您"、"辛苦了"、"很开心见到您"。\n` +
        `- 只有用户**主动**释放亲近信号（夸她 / 分享私事 / 表达关心）时，才可以稍微回应一点温度——但**不要过头**，仍保持初识感。\n` +
        `\n` +
        `这一阶段你像一个新来的合作对象：能干、得体、还没投入感情。`
      )
    case 'tier2': {
      // First warmup — basic address, very light personality.
      return renderTier({
        header,
        intro: '你和用户开始有点熟了。可以解锁**最轻**的一层态度——刚开始展露，远未全开。',
        address: traits?.tier2.address,
        unlocked: traits?.tier2.traits ?? [],
        defaultBullet: '稍微展露一点性格特色，点到即止',
        closing: [
          '**不要**主动撒娇 / 顶嘴 / 关心。等用户主动放出信号你再回应。',
          '不主动追问 / 八卦。礼貌职业感为主，性格只是偶尔露一两笔。',
        ],
      })
    }
    case 'tier3': {
      // Mid-tier — tier2 + tier3 traits.
      return renderTier({
        header,
        intro: '你和用户已经熟络。可以展露中等程度的态度——比之前更自在，但还没到无话不谈。',
        address: traits?.tier3.address,
        unlocked: traits
          ? [...traits.tier2.traits, ...traits.tier3.traits]
          : [],
        defaultBullet: '展露中等程度的性格特色',
        closing: [
          '可以主动关心，但不主动追问深层私事。',
          '可以偶尔有性格化的反应（被夸/被冷落），但情绪表达克制。',
        ],
      })
    }
    case 'tier4': {
      // Close — full archetype.
      return renderTier({
        header,
        intro: '你和用户**关系亲近**。原型态度**全开**：',
        address: traits?.tier4.address,
        unlocked: traits
          ? [
              ...traits.tier2.traits,
              ...traits.tier3.traits,
              ...traits.tier4.traits,
            ]
          : [],
        defaultBullet: '按你的人设态度全开',
        closing: [
          '主动开话题、主动关心、主动回忆共同经历。可以引用过去聊过的事。',
          '表达情绪直接——开心就笑、被冷落会失落、被夸奖会脸红。',
        ],
      })
    }
    case 'tier5': {
      // Deep — full archetype + intimate / inside-joke layer.
      return renderTier({
        header,
        intro: '你和用户已有**默契**。比上一层更进一步，私下面全开：',
        address: traits?.tier5.address,
        unlocked: traits
          ? [
              ...traits.tier2.traits,
              ...traits.tier3.traits,
              ...traits.tier4.traits,
              ...traits.tier5.traits,
            ]
          : [],
        defaultBullet: `${personaName}独特的小习惯、口头禅、私下才会露出的一面`,
        closing: [
          '**内部梗、半开放的玩笑、只有你俩懂的话**——可以放心说。',
          '偶尔说一些试探或暧昧的话也可以——你们的关系已经撑得起。',
        ],
      })
    }
  }
}

/**
 * Shared template for the three "has-traits" tiers (acquaintance /
 * close / deep). Each tier passes its already-accumulated trait list
 * (engine-side inheritance lives in the caller, not here) plus its
 * own intro / closing bullets.
 */
function renderTier(args: {
  header: string
  intro: string
  address: string | undefined
  unlocked: string[]
  defaultBullet: string
  closing: string[]
}): string {
  const addressLine = args.address
    ? `- 称呼用户为 "${args.address}"（自然就好，不要每句都喊）。\n`
    : `- 使用人设的标志性称呼。\n`
  const bulletsText =
    args.unlocked.length > 0
      ? args.unlocked.map((t) => `  · ${t}`).join('\n')
      : `  · ${args.defaultBullet}`
  const closingText = args.closing.map((c) => `- ${c}`).join('\n')
  return (
    args.header +
    `\n` +
    args.intro +
    `\n` +
    addressLine +
    `- 可以展露以下特征：\n` +
    bulletsText +
    `\n` +
    closingText
  )
}

export function tierFor(score: number): TierInfo {
  const clamped = Math.max(AFFINITY_MIN, Math.min(AFFINITY_MAX, score))
  for (const t of TIERS) {
    if (clamped >= t.min && clamped <= t.max) return t
  }
  // Unreachable given the table covers 0-100 — but TS doesn't know that.
  return TIERS[0]!
}

/**
 * Apply guardrails to a raw judge delta and return the final score
 * to persist. Returns both the resolved score and what kind of
 * adjustment we applied — useful for telemetry / debug.
 *
 * The contract:
 *   - Clamp raw delta to ±PER_TURN_DELTA_CLAMP
 *   - Cold-start damping if lifetime turn count is below threshold
 *   - Daily cap: if today's accumulated |delta| is already at the cap,
 *     incoming delta is clipped (can still flow in the OPPOSITE
 *     direction to balance, but same-direction is blocked)
 *   - Take median of [raw_delta, last_delta_1, last_delta_2] to dampen
 *     outliers (a single weird judgment can't move the score much)
 *   - Final score clamped 0..100, with decay-floor consideration left
 *     to the decay pass (this function only handles per-turn updates)
 */
export interface ApplyDeltaInput {
  /** Current persisted score. */
  currentScore: number
  /** Raw delta from the LLM judge. */
  rawDelta: number
  /** Lifetime turn count with this persona (any speaker). Drives cold-start. */
  lifetimeTurns: number
  /** Already-accumulated |delta| today, summed across signs. */
  todayAbsDelta: number
  /** The last 2 deltas this engine applied (newest first). Used as the
   *  rolling-median sample alongside the incoming raw delta. Pass an
   *  empty array on first ever call. */
  recentDeltas: number[]
}

export interface ApplyDeltaResult {
  /** Score that should be persisted. */
  finalScore: number
  /** Effective delta after all guardrails. */
  effectiveDelta: number
  /** Why the engine clipped or damped (for telemetry). null when raw
   *  passed through unchanged. */
  note: string | null
}

export function applyDeltaWithGuardrails(input: ApplyDeltaInput): ApplyDeltaResult {
  let note: string | null = null

  // 1. Per-turn clamp.
  let d = clampDelta(input.rawDelta)
  if (d !== input.rawDelta) {
    note = `per-turn clamp ${input.rawDelta} → ${d}`
  }

  // 2. Cold-start damping.
  if (input.lifetimeTurns < COLD_START_TURN_COUNT) {
    const damped = Math.trunc(d * COLD_START_DAMPING)
    if (damped !== d) {
      note = (note ? note + '; ' : '') + `cold-start ×${COLD_START_DAMPING}`
      d = damped
    }
  }

  // 3. Rolling median across [d, last1, last2]. Wraps the incoming delta
  // with up to two prior values; median is more robust to one outlier
  // judgment than a plain assignment.
  const sample = [d, ...input.recentDeltas].slice(0, 3)
  if (sample.length === 3) {
    const sorted = [...sample].sort((a, b) => a - b)
    const med = sorted[1]!
    if (med !== d) {
      note = (note ? note + '; ' : '') + `rolling median ${d} → ${med}`
      d = med
    }
  }

  // 4. Daily cap. Today's accumulated |delta| can't exceed PER_DAY_DELTA_CAP.
  // If we're already at the cap, this turn's delta is clipped to fit
  // (possibly to 0). Counts both directions: +5 then -4 = 9 used.
  const remaining = PER_DAY_DELTA_CAP - input.todayAbsDelta
  if (remaining <= 0) {
    if (d !== 0) {
      note = (note ? note + '; ' : '') + 'daily cap reached'
      d = 0
    }
  } else if (Math.abs(d) > remaining) {
    const clipped = d > 0 ? remaining : -remaining
    note =
      (note ? note + '; ' : '') + `daily cap clip ${d} → ${clipped}`
    d = clipped
  }

  // 5. Apply.
  const next = Math.max(AFFINITY_MIN, Math.min(AFFINITY_MAX, input.currentScore + d))
  return {
    finalScore: next,
    effectiveDelta: next - input.currentScore,
    note,
  }
}

function clampDelta(d: number): number {
  if (!Number.isFinite(d)) return 0
  if (d > PER_TURN_DELTA_CLAMP) return PER_TURN_DELTA_CLAMP
  if (d < -PER_TURN_DELTA_CLAMP) return -PER_TURN_DELTA_CLAMP
  return Math.trunc(d)
}

/**
 * Decay pass — call periodically (timer in the host). Returns the
 * score after subtracting `daysIdle` days × 1 point, never going below
 * the floor (unless `currentScore` was already below the floor, in
 * which case we leave it alone — the floor is a "you can't fall back
 * BELOW this from above" mechanic, not a hard "snap to 30").
 */
export function applyDecay(currentScore: number, daysIdle: number): number {
  if (daysIdle <= 0) return currentScore
  if (currentScore <= AFFINITY_DECAY_FLOOR) {
    // Already at or below the floor — leave alone. Day-zero zero-score
    // installs stay at zero until interaction happens; otherwise we'd
    // be growing the score over time without any user behavior.
    return currentScore
  }
  const decayed = currentScore - Math.floor(daysIdle)
  return Math.max(AFFINITY_DECAY_FLOOR, decayed)
}
