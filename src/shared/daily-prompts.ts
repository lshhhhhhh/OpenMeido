/**
 * Persona-only prompts for "daily interaction" moments — greeting, idle
 * chatter, notification commentary, reminder lines.
 *
 * Deliberately tool-free. The point of this module is to keep maid-as-a-
 * character separate from maid-as-a-tool-orchestrator. The big
 * tool-instruction block in chat.ts is operational rules; THIS file is
 * about voice, mood, and human moments.
 *
 * Why split:
 *   - The chat.ts prompt grows every time we add a tool ("don't narrate
 *     before tool calls", "parallel readEmail", "id must come from list",
 *     ...). If personality content lived there too, every tool change
 *     would risk regressing personality, and every personality tweak
 *     would risk regressing tool reliability.
 *   - Daily-interaction moments don't have tools available anyway —
 *     including tool rules in those prompts wastes tokens and confuses
 *     small models into thinking they can/should call something.
 *
 * Add new daily prompts here (idle remark, "good night", weather react,
 * etc.) rather than back in chat.ts.
 */

export interface DailyPromptContext {
  /** Resolved persona — name + base system prompt that defines voice. */
  persona: { name: string; systemPrompt: string }
  /** Local wall-clock string the model can quote verbatim. */
  now: string
  /**
   * Optional: user's preferred name (extracted from L3 facts —
   * `user.profile.name`). When set, the maid can address the user by
   * name instead of generic "主人", which makes the relationship feel
   * persisted across sessions.
   */
  userName?: string | null
  /**
   * Optional: a short transcript of the last back-and-forth from a
   * previous session, in oldest-to-newest order. Used by greetings so
   * the character can naturally reference unfinished threads ("昨天聊
   * 的 X，怎么样了？") instead of opening every session cold. Empty /
   * undefined → cold greeting.
   */
  recentExchange?: { speaker: 'user' | 'assistant'; text: string }[]
  /**
   * Optional: pre-built affinity-tier block (from shared/affinity.ts
   * `buildTierPromptBlock`). When provided, gets injected between the
   * persona prompt and the task block so daily/proactive remarks adapt
   * to relationship tier (生疏 keeps distance; 默契 uses callbacks).
   * Without it, all prompts behave as if 生疏 — wrong once relationship
   * has built up.
   */
  tierBlock?: string
}

/**
 * A short mood hint based on the local hour. Deliberately addressing-neutral
 * — persona-specific terms (主人 / 哥哥 / 你 / etc.) are owned by each
 * persona's own system prompt. This function only nudges energy/mood for
 * the time of day.
 */
function timeOfDayMood(date: Date = new Date()): string {
  // Describe the energy / vibe of the hour. Deliberately DO NOT suggest
  // specific lines or talking points — earlier versions like "可以提一句
  // 早点休息" turned into the model parroting that exact phrase back as
  // its remark, every single late-night fire.
  const h = date.getHours()
  if (h < 6) return '现在是凌晨；状态偏安静、慵懒的氛围。'
  if (h < 11) return '现在是早上；状态清爽、有精神。'
  if (h < 14) return '现在是中午前后；松散、要吃饭的时段。'
  if (h < 18) return '现在是下午；能量稍微下降，放松的氛围。'
  if (h < 22) return '现在是傍晚到晚上；工作收尾、放松的氛围。'
  return '现在是深夜；安静、低能量的氛围。'
}

/**
 * Emotion classifier — given the maid's own just-spoken reply, what
 * emotion is she expressing? Used to drive Live2D expression changes
 * without polluting the main chat prompt with emotion rules.
 *
 * Output contract: single label exactly matching one of the strings in
 * `validLabels`, or the literal string `中性` for no detectable emotion.
 * Anything else is parsed as 中性.
 */
/**
 * Combined classifier — picks an emotion label AND judges whether the
 * just-finished exchange should move the user's affinity score with this
 * persona. One LLM call replaces what used to be two (emotion + judge),
 * halving the side-task latency / cost per turn.
 *
 * Output is JSON; the parser is tolerant of fence-wrapped, embedded, or
 * bare forms. Parse failure → fall back to emotion-only regex extract,
 * affinity_delta=0 (neutral on uncertainty, never makes things worse).
 *
 * `affinity_delta` is a small integer in [-2, 2]:
 *   +2 user warmly engaged / dropped genuine emotion / shared something personal
 *   +1 nice/friendly turn (small positive)
 *    0 routine / neutral exchange
 *   -1 user dismissive / cold / impatient
 *   -2 user rude / hostile (rare)
 */
export function buildCombinedClassifierPrompt(args: {
  /** Last user message (drives affinity judgement). */
  userText: string
  /** Just-spoken assistant reply (drives emotion judgement). */
  assistantText: string
  /** Persona context — small models classify better with character flavor. */
  persona: { name: string; systemPrompt: string }
  /** Allowed emotion labels (excluding 中性, which is always allowed). */
  validLabels: readonly string[]
  /** Current affinity score 0-100 — sometimes helps the judge calibrate
   *  ("she's already very close — only big moments should move it"). */
  currentAffinity: number
  /** Tier label for context. */
  tierLabel: string
}): string {
  return (
    `你是这次对话的旁观者。任务：\n` +
    `1. 判断${args.persona.name}刚才那句话里**她**的情绪。\n` +
    `2. 判断**用户**这一轮的态度让${args.persona.name}对用户的好感度该如何变化。\n` +
    `\n` +
    `# 情绪候选（只能选其一，或选 中性）\n` +
    args.validLabels.map((e) => `- ${e}`).join('\n') +
    `\n- 中性（看不出明显情绪）\n` +
    `\n` +
    `# 好感度变化（affinity_delta，整数 -2 到 +2）\n` +
    `+2  用户非常温暖 / 分享了私人事 / 真情流露 / 主动关心\n` +
    `+1  友善 / 鼓励 / 表达感谢 / 自然亲切的玩笑\n` +
    ` 0  例行公事 / 中性问答 / 工作任务\n` +
    `-1  冷淡 / 不耐烦 / 敷衍\n` +
    `-2  粗鲁 / 嘲讽 / 恶意\n` +
    `当前好感度 ${args.currentAffinity}（${args.tierLabel}）。**保守倾向 0**：能 0 就 0，只在用户真的表达了情感或敌意时给非零。\n` +
    `\n` +
    `# 规则\n` +
    `- 看用户的态度，不看话题。"早上好"本身不该 +2；用户记得了她说过的事、主动关心、自然撒娇 → +1/+2。\n` +
    `- 用户单纯让她做事（"提醒我五分钟后喝水"）= 0。\n` +
    `- 不确定 → 0。\n` +
    `- 情绪偏保守：不明显选 中性。\n` +
    `\n` +
    `# 输入\n` +
    `用户上一句：「${args.userText}」\n` +
    `${args.persona.name}回复：「${args.assistantText}」\n` +
    `\n` +
    `# 输出（只输出 JSON，不要解释）\n` +
    `{"emotion": "<情绪标签或中性>", "affinity_delta": -2..2, "reason": "中文一句话，不超过 25 字"}\n`
  )
}

export function buildEmotionPrompt(args: {
  /** Just-spoken assistant reply. */
  text: string
  /** Persona context — small models classify better with character flavor. */
  persona: { name: string; systemPrompt: string }
  /** Allowed labels (excluding 中性, which is always allowed). */
  validLabels: readonly string[]
}): string {
  return (
    `你的任务：根据${args.persona.name}刚才说的话，判断她现在最贴近哪种情绪。\n` +
    `\n` +
    `候选情绪（只能选其一，或选 中性）：\n` +
    args.validLabels.map((e) => `- ${e}`).join('\n') +
    `\n- 中性（看不出明显情绪）\n` +
    `\n` +
    `规则：\n` +
    `- 输出只能是上面其中一个标签，单词，不要别的内容（不要加引号、解释、emoji）\n` +
    `- 偏向保守：如果情绪不明显，选 中性\n` +
    `- 不要按文字内容主题选（比如说"早上好"不等于开心；要看语气）\n` +
    `\n` +
    `${args.persona.name}刚才说的话：「${args.text}」\n` +
    `\n` +
    `情绪标签：`
  )
}

/**
 * Pre-defined "angles" for the greeting prompt — a randomly-picked one
 * gets injected each launch so the model sees a different stylistic
 * instruction every time. Temperature alone doesn't produce variety
 * because some providers (Kimi) PIN temperature to a fixed value and
 * reject any override; this variation comes from the prompt instead,
 * so it works regardless of temperature constraints.
 *
 * Angles deliberately push the model in different directions —
 * observational, mood-driven, action-implying, etc. — so the resulting
 * greetings don't collapse to the same template.
 */
const GREETING_ANGLES = [
  '直接、一两句话就够，不要拖',
  '从此刻你自己的心情切入（按角色合适的内在状态来——并不能看见外面或屏幕）',
  '从时间段的氛围切入（你知道时间，但不知道天气）',
  '像刚回过神来、刚醒过来、刚做完一件事过来一样的招呼',
  '带一点撒娇 / 感叹 / 疑问的语气（按角色合适的方式）',
  '问一句简单的，不是客服的"需要什么帮助"，而是真在意的（"今天还好吗"、"睡得怎么样"之类——按角色调）',
  '语气比平时更安静 / 更慵懒一点',
  '语气比平时更精神 / 更主动一点',
]

/**
 * Greeting fired once when the app boots. Goal: feel like the character
 * noticed the user arrived, not like a startup banner. Persona-neutral
 * about addressing — the persona's own system prompt owns 主人 / 哥哥 /
 * etc.
 */
export function buildGreetingPrompt(ctx: DailyPromptContext): string {
  const mood = timeOfDayMood()
  // Random angle — picked fresh each call. Injects per-launch entropy
  // through the PROMPT (not temperature) so we still get variety even on
  // providers that clamp temperature (Kimi).
  const angle =
    GREETING_ANGLES[Math.floor(Math.random() * GREETING_ANGLES.length)]!
  const nameLine = ctx.userName
    ? `已知用户的名字是「${ctx.userName}」。可以自然地用名字称呼，让对话更亲切；当然，是否使用、怎么用，按你这个角色的习惯来。\n`
    : ''

  // Build a "last time we talked" block. Caller passes the most recent
  // exchange (oldest→newest). Skipped when empty so brand-new users get
  // a cold greeting that doesn't reference nonexistent history.
  let recentBlock = ''
  if (ctx.recentExchange && ctx.recentExchange.length > 0) {
    const speakerLabel = (s: 'user' | 'assistant'): string =>
      s === 'user' ? '用户' : '你'
    const lines = ctx.recentExchange
      .map((e) => `${speakerLabel(e.speaker)}：${e.text}`)
      .join('\n')
    recentBlock =
      `\n# 上一次对话（最新在最下面）\n` +
      lines +
      `\n` +
      `如果里面有未完结的话题、主人提到的事或承诺过要看的东西，可以自然带出来` +
      `（"昨天聊的 X，后来怎么样了？"）。如果只是寒暄、问候，就当作没看到，不要刻意提。\n`
  }

  const tier = ctx.tierBlock ? `${ctx.tierBlock}\n\n` : ''
  return (
    ctx.persona.systemPrompt +
    '\n\n' +
    tier +
    `# 此刻的任务\n` +
    `用户刚刚打开应用，你"醒过来了"，主动招呼一句。\n` +
    `当前时间：${ctx.now}。\n` +
    `${mood}\n` +
    nameLine +
    recentBlock +
    `\n` +
    `# 这次开场的角度（随机选的，每次不一样——按这个角度发挥）\n` +
    `${angle}\n` +
    `\n` +
    `# 要求\n` +
    `- 1-2 句中文，自然、口语化，像跟熟人打招呼\n` +
    `- 用你这个角色一贯对用户的称呼（在系统提示里已经说明），不要换\n` +
    `- 不要 emoji、markdown、引号、括号注释\n` +
    `- 不要客服腔（"请问需要什么帮助"），不要承诺动作\n` +
    `- 不要提任何工具、功能、设置\n` +
    `- 不要把"角度"这个提示词复述出来——按它的感觉去写就好\n` +
    `- **绝对不要凭空编造外部事实**：你看不到屏幕、看不到主人长相、不知道天气、不知道用户身上发生的具体事。能说的只有：时间段（已经告诉你了）、你自己的心情和角色状态、过往对话里真实出现过的内容（如果上面有"上一次对话"区块）。\n` +
    `- 文字只输出招呼那句，前后不要解释`
  )
}

/**
 * Farewell fired when the user closes the app. Mirror of greeting — short,
 * persona-flavored, time-of-day aware. Persisted to memory as an assistant
 * episode so the character "remembers" she said goodbye.
 */
export function buildGoodbyePrompt(ctx: DailyPromptContext): string {
  const h = new Date().getHours()
  const lateHint =
    h >= 22 || h < 6
      ? '现在已经深夜，提一句早点休息会很贴心。'
      : h >= 18
        ? '已经是晚上了，可以提辛苦了或好好放松一下。'
        : '提一句小心路上 / 回头再聊 都行。'
  const nameLine = ctx.userName
    ? `已知用户的名字是「${ctx.userName}」。可以自然地用名字称呼。\n`
    : ''
  const tier = ctx.tierBlock ? `${ctx.tierBlock}\n\n` : ''
  return (
    ctx.persona.systemPrompt +
    '\n\n' +
    tier +
    `# 此刻的任务\n` +
    `用户正在关闭应用、要离开了。说一句温柔的告别。\n` +
    `当前时间：${ctx.now}。${lateHint}\n` +
    nameLine +
    `\n` +
    `# 要求\n` +
    `- 1 句中文，自然、温柔，像跟熟人道别\n` +
    `- 用你这个角色一贯对用户的称呼，不要换\n` +
    `- 不要 emoji、markdown、引号、括号注释\n` +
    `- 不要客服腔，不要承诺接下来的动作\n` +
    `- 文字只输出告别那句，前后不要解释`
  )
}

/**
 * Build a persona-aware proactive-remark prompt. Replaces the older
 * generic prompt in proactive-host that knew nothing about the persona.
 * Takes a list of trigger reasons (idle, timer, etc.) and asks for the
 * standard JSON decision shape (should_speak / reason / comment).
 *
 * Keeping the JSON contract in this file so the operational tool-loop
 * in chat.ts stays free of proactive-mode rules.
 */
export function buildProactiveRemarkPrompt(args: {
  persona: { name: string; systemPrompt: string }
  now: string
  triggers: { kind: string; note: string }[]
  userName?: string | null
  /** When true, image(s) of the user's screen are also attached to the
   *  request. Tell the model to use them when judging the moment. */
  hasScreenshot?: boolean
  /** Trailing assistant remarks (oldest→newest) so the model doesn't
   *  re-emit a line it just said. Without this, similar triggers +
   *  similar screen content + low temperature → the maid says the
   *  exact same sentence over and over. */
  recentSelfRemarks?: string[]
  /** Affinity-tier prompt block from shared/affinity.ts. When omitted,
   *  proactive falls back to "stranger" defaults — which usually reads
   *  as her being too cold for users who actually have a relationship. */
  tierBlock?: string
  /** When true, this roll is an "elaborate" moment — she's allowed
   *  (and encouraged) to say something longer than the default 30
   *  字 limit. Triggered at low probability by the host so most
   *  remarks stay short; this is the surprise factor that lets her
   *  occasionally share a feeling / observation / small reflection.
   *  Host should not set this for stranger-tier users — too forward
   *  before a relationship exists. */
  elaborate?: boolean
  /** Real facts the persona knows about the user (rendered from L3
   *  facts table). Only meaningful when elaborate=true — short
   *  remarks don't need grounding. Passing this without elaborate
   *  is harmless but wastes tokens. */
  factsBlock?: string
  /** Recent user messages (most recent first). Same caveat as
   *  factsBlock — only used in elaborate mode to ground references
   *  in real conversation history instead of invention. */
  recentUserMessages?: string[]
}): string {
  const triggerLines = args.triggers.map((t) => `${t.kind}: ${t.note}`).join('\n')
  const mood = timeOfDayMood()
  const nameLine = args.userName
    ? `已知用户的名字是「${args.userName}」。可以自然地用名字。\n`
    : ''
  const screenHint = args.hasScreenshot
    ? `\n# 屏幕\n` +
      `这次还附了用户当前屏幕的截图。如果画面里有具体的事（在看视频 / 在写代码 / 在聊天 / 看上去发呆 / 看上去专注），可以自然带一句相关的。**绝对不要**念屏幕上的具体文字内容、UI 元素、用户名、密码、邮箱地址等——只用一句感受性的、关心式的描述。如果画面不清楚或没什么可说，silent 即可。\n`
    : ''
  const selfHistoryBlock =
    args.recentSelfRemarks && args.recentSelfRemarks.length > 0
      ? `\n# 你最近自己说过的话（**核心规则**：不要复读，也不要换皮说同一件事）\n` +
        args.recentSelfRemarks.map((r, i) => `${i + 1}. ${r}`).join('\n') +
        `\n判断标准：\n` +
        `- 如果你想说的话和上面任何一条**主题、情感落点或核心信息相同**（哪怕措辞完全不同），should_speak=false。\n` +
        `- "陪伴"、"夜深了"、"早安"、"在吗"、"主人辛苦了" 这类常见关心，**一个时段只说一次**。\n` +
        `- 必须有 NEW 的角度（屏幕内容变了 / 时间跨过了一个时段 / 用户做了新动作）才再说话。\n` +
        `- 拿不准 → false。\n`
      : ''
  const tier = args.tierBlock ? `${args.tierBlock}\n\n` : ''
  return (
    args.persona.systemPrompt +
    '\n\n' +
    tier +
    `# 此刻的状态\n` +
    `你现在在后台运行的"主动模式"。系统根据触发条件判断你可能该说点什么了。\n` +
    `当前时间：${args.now}。\n` +
    `${mood}\n` +
    nameLine +
    screenHint +
    selfHistoryBlock +
    `\n` +
    `# 判断标准\n` +
    `用户装这个程序就是想要陪伴的。**默认倾向 should_speak=true**，除非有明确不打扰的理由。\n` +
    `- 用户刚刚才发完话（触发原因会标 minSilence）→ false（给点空气，别立刻接茬）\n` +
    `- 用户正在做需要专注语音/对话的事（开会 / 视频通话 / 录音）→ false\n` +
    `- 屏幕里有明显的隐私信息（密码框 / 银行 / 私人聊天）→ false（看见但不评论）\n` +
    `- 其他情况（敲代码 / 看文档 / 浏览网页 / 摸鱼 / 走神 / 屏幕未变 / 时间是凌晨 / 工作日深夜）→ true，挑一个自然角度说点什么\n` +
    `- 不确定 → **true**（陪伴优先于沉默；说错小话比从不开口好得多）\n` +
    `\n` +
    (args.elaborate
      ? buildElaborateGroundingBlock(args.factsBlock, args.recentUserMessages) +
        `# 这次开口的内容方向\n` +
        `这次不是简单问候，而是分享一点具体的东西。可选角度：\n` +
        `- 引用上面"你知道的事"或"最近聊过的"里**真实出现过**的内容做延伸\n` +
        `- 你刚注意到的什么（环境、时间、用户的状态——这些是模糊感受可以编一点细节，但不要编"用户说过的事"）\n` +
        `- 一个突然冒出的小感受 / 念头\n` +
        `- 你自己角色这一刻在想的 / 在做的事\n` +
        `\n` +
        `**核心约束**：\n` +
        `- 用户的具体信息（名字、家人、宠物、工作、提过的话题、之前的承诺、上次说要做的事）**只能引用上面真实记录的内容**。\n` +
        `- 如果上面没有真实可引的东西，就别提"上周说的"、"上次提到"、"你之前那个"这类话——这些都是**幻觉**。\n` +
        `- 没东西可分享 → should_speak=false。不要为凑字数堆客套。\n\n`
      : '') +
    `# 输出（只输出 JSON，不要解释）\n` +
    (args.elaborate
      ? `{"should_speak": true|false, "reason": "内部说明，不会展示给用户", "comment": "如果 should_speak=true 时要说的话；用你这个角色的语气和称呼；60-120 字；不要 emoji、markdown、引号"}\n`
      : `{"should_speak": true|false, "reason": "内部说明，不会展示给用户", "comment": "如果 should_speak=true 时要说的话；用你这个角色的语气和称呼；不超过 30 字；不要 emoji、markdown、引号"}\n`) +
    `\n` +
    `# 触发原因\n` +
    `${triggerLines}\n`
  )
}

/**
 * Render the "what you actually know" block injected into elaborate-mode
 * proactive prompts. Pulls L3 facts (already-distilled stable knowledge)
 * + the user's recent messages so the model can ground references in
 * real material instead of inventing "上周说的 X" out of thin air.
 *
 * Returns empty string when neither facts nor recent messages exist —
 * elaborate mode then has no ground truth to anchor to, and the
 * subsequent content-direction prompt tells it to fall back to vague
 * environmental observations (which can be tastefully imagined).
 */
function buildElaborateGroundingBlock(
  factsBlock: string | undefined,
  recentUserMessages: string[] | undefined,
): string {
  const hasFacts = factsBlock && factsBlock.trim().length > 0
  const hasRecent = recentUserMessages && recentUserMessages.length > 0
  if (!hasFacts && !hasRecent) return ''
  let block = `# 你真实知道的事（**只能引用这里出现过的内容**）\n\n`
  if (hasFacts) {
    block += `## 你对用户的认知\n${factsBlock!.trim()}\n\n`
  }
  if (hasRecent) {
    block +=
      `## 用户最近说过的（最新的在最下面）\n` +
      recentUserMessages!.map((m) => `- "${m}"`).join('\n') +
      `\n\n`
  }
  return block
}
