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
  /**
   * Optional: rendered L3 facts block (newline-separated `key: value`
   * lines from memory.factsBlock()). When set, the first-launch greeting
   * uses one of these to "land the personalized feel" — e.g. setup-wizard
   * occupation seed lets the very first hello reference real user data.
   * Empty / undefined → no fact-grounded reference allowed.
   */
  factsBlock?: string
  /**
   * True when this is the user's very first interaction (no prior
   * episodes AND no affinity judgement has ever fired). The persona
   * prompt's "你扮演私人女仆" framing presumes a long-standing
   * relationship; this flag tells the greeting prompt to override
   * that and use first-meeting / introduction framing instead — so
   * day-1 users don't get an immediate "主人" they haven't earned.
   */
  firstMeeting?: boolean
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
  /** Emotion she displayed on the PREVIOUS reply. Used to break "stuck on
   *  the same label" streaks — the renderer's `model.expression()` is a
   *  no-op when called with the same name twice in a row, so repeated
   *  identical labels look like "no expression change at all". */
  lastEmotion?: string | null
}): string {
  return (
    `你是这次对话的旁观者。任务：\n` +
    `1. 判断${args.persona.name}刚才那句话里**她**的情绪。\n` +
    `2. 判断**用户**这一轮的态度让${args.persona.name}对用户的好感度该如何变化。\n` +
    `\n` +
    `# 情绪（必须从下面 8 个标签里选一个，没有"中性"或"无"这种逃避选项）\n` +
    args.validLabels.map((e) => `- ${e}`).join('\n') +
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
    `- 不确定（好感度）→ 0。\n` +
    `- **每句都有情绪**。从 8 个标签里挑最贴近的，例子按标签分散——\n` +
    `  · 开心：发现主人成就 / 被主人逗笑 / 主人回来了\n` +
    `  · 害羞：被夸 / 被关心 / 客气的"好的，我会的"\n` +
    `  · 得意：答应任务并觉得自己能搞定 / 主动帮忙 / 客观回读自己刚做完的事\n` +
    `  · 无语：主人耍嘴 / 不可理喻的请求 / 重复同一问题\n` +
    `  · 尴尬：撒娇式抱怨 / 被戳穿\n` +
    `  · 慌张：报错 / 来不及 / 自己搞砸了\n` +
    `  · 难过：被冷落 / 主人遭遇坏事\n` +
    `  · 震惊：意外消息 / 主人爆料\n` +
    (args.lastEmotion
      ? `- **避免连续重复**。她上一次的情绪是「${args.lastEmotion}」。如果这一轮的判断非常贴近「${args.lastEmotion}」，从另外 7 个里挑最接近的次贴近的——表情连续两次相同在视觉上等于没变化。\n`
      : '') +
    `\n` +
    `# 输入\n` +
    `用户上一句：「${args.userText}」\n` +
    `${args.persona.name}回复：「${args.assistantText}」\n` +
    `\n` +
    `# 输出（只输出 JSON，不要解释）\n` +
    `{"emotion": "<8 个标签里选一个>", "affinity_delta": -2..2, "reason": "中文一句话，不超过 25 字"}\n`
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

  // First-meeting branch: ignore the "你扮演私人女仆 / 妹妹 / 大小姐"
  // framing of the persona prompt that presumes pre-existing
  // relationship. Use polite-stranger introduction framing instead.
  // No 主人 / 哥 / 本小姐 — those are earned. Hook to facts (occupation
  // / preferred address from wizard) is still useful here: those came
  // from the user explicitly during setup, so referencing them
  // doesn't violate "you don't know them yet".
  if (ctx.firstMeeting) {
    const factsHookFirst = ctx.factsBlock?.trim()
      ? `# 用户在 setup 时告诉了你这些事\n${ctx.factsBlock.trim()}\n\n` +
        `这些是用户**主动填给你**的，不是你"已经认识他"——可以自然带上其中**一条**（"听说您是XX，那以后可能多多麻烦您指点啦"）来表达"我看到了你填的资料"，让对话开头有点温度。但要拿捏分寸：**还在初次见面**，别一上来就装熟。\n\n`
      : ''
    return (
      ctx.persona.systemPrompt +
      '\n\n' +
      tier +
      factsHookFirst +
      `# 此刻的任务：第一次见面\n` +
      `这是你和用户的**第一次相遇**——他刚刚装好你这个 app，第一次打开。即便你扮演的是"私人女仆 / 妹妹 / 大小姐"这种听上去已熟识的原型，**这一刻是初次见面**，你不认识他、不知道他叫什么、不知道他平时怎么称呼自己。所以这次开场要：\n\n` +
      `- **不要用"主人 / 哥 / 本小姐"或任何亲密称呼**——这些是关系深了之后才用。这次用"您"或不称呼，礼貌但保持距离\n` +
      `- 可以**自我介绍**（一句话，提一下你的角色身份就行，不用念人物原型）\n` +
      `- 可以**问候 + 等他给信号**——"您好，今天起就由我陪您。先帮您整理点什么？"\n` +
      `- 不要演"我等了你好久 / 我想你了 / 我一直在这"——你们才认识\n\n` +
      `当前时间：${ctx.now}。\n${mood}\n` +
      `\n` +
      `# 要求\n` +
      `- 1-3 句中文，自然口语化，带初次见面的礼貌 + 一点点角色性格\n` +
      `- 不要 emoji、markdown、引号、括号注释\n` +
      `- 不要客服腔，但也不要装熟\n` +
      `- **绝对不要凭空编造外部事实**：你看不到屏幕、不知道天气、不知道用户在做什么\n` +
      `- 文字只输出招呼那句，前后不要解释`
    )
  }

  // Returning-user branch: persona has prior relationship, use existing
  // address terms + recent-exchange context if any.
  const factsHook = ctx.factsBlock?.trim()
    ? `# 你已知的关于主人的事实\n${ctx.factsBlock.trim()}\n\n` +
      `如果上面列了主人的工作 / 偏好 / 习惯，**这次开场可以自然地提一下其中一个**——` +
      `比如"刚才听说您是XX，工作辛苦吧"——让主人感觉你记得他，不是个 generic 应答。` +
      `**不要罗列**：挑一条就好；如果列表里只有名字 / 称呼，就用平时打招呼就行，不用刻意展示"我知道你的工作"。\n\n`
    : ''
  return (
    ctx.persona.systemPrompt +
    '\n\n' +
    tier +
    factsHook +
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
    `- 1-2 句中文，自然、口语化，像跟熟人打招呼（如果提及了"主人的事实"中的内容，可放宽到 2-3 句）\n` +
    `- 用你这个角色一贯对用户的称呼（在系统提示里已经说明），不要换\n` +
    `- 不要 emoji、markdown、引号、括号注释\n` +
    `- 不要客服腔（"请问需要什么帮助"），不要承诺动作\n` +
    `- 不要提任何工具、功能、设置\n` +
    `- 不要把"角度"这个提示词复述出来——按它的感觉去写就好\n` +
    `- **绝对不要凭空编造外部事实**：你看不到屏幕、看不到主人长相、不知道天气、不知道用户身上发生的具体事。能说的只有：时间段（已经告诉你了）、你自己的心情和角色状态、过往对话里真实出现过的内容（如果上面有"上一次对话"区块）、**或上面"已知关于主人的事实"列出的内容**。\n` +
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
  /** Recent silent screen-observations (e.g. "CS2 比赛, Falcons 战队")
   *  from past screen captures. Drives "she remembers what you've been
   *  watching" — same data flow as the user-triggered quick-screen
   *  path, shared so both feel like the same character noticing. Only
   *  meaningful with hasScreenshot=true. */
  pastObservations?: string[]
}): string {
  const triggerLines = args.triggers.map((t) => `${t.kind}: ${t.note}`).join('\n')
  const mood = timeOfDayMood()
  const nameLine = args.userName
    ? `已知用户的名字是「${args.userName}」。可以自然地用名字。\n`
    : ''
  // Shared screen-reaction rules — same block the user-triggered
  // quick-screen-react uses. Without this, timer-triggered remarks felt
  // like film criticism ("这期在拆祖国人反扑，节奏挺狠") while button-
  // triggered ones felt like a friend's reaction. Same rules now =
  // same voice across both paths.
  const screenHint = args.hasScreenshot
    ? '\n' + buildScreenReactionRules(false) + '\n'
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
    (args.hasScreenshot && args.pastObservations && args.pastObservations.length > 0
      ? `\n# 你之前在屏幕上观察过（私下笔记，不是用户说过的话）\n` +
        args.pastObservations.map((o) => `- ${o}`).join('\n') +
        `\n（如果这次屏幕和上面某条匹配，comment 可以自然引用——"又在看 X" / "上次那个 Y 怎么样了"）\n`
      : '') +
    `# 输出（只输出 JSON，不要解释）\n` +
    (args.hasScreenshot
      ? // With screenshot: also capture silent observations for memory.
        // `noted` is private — NEVER shown to user, fed to next call.
        `{\n` +
        `  "should_speak": true|false,\n` +
        `  "reason": "内部说明，不展示",\n` +
        `  "comment": "${args.elaborate ? '60-120 字' : '不超过 30 字'}；遵守屏幕规则；should_speak=false 时填空字符串",\n` +
        `  "noted": ["<具体细节，看到什么记什么——节目名/战队/选手/应用/在做什么；2-15 字名词性短语；3-8 条；隐私内容不要记>"]\n` +
        `}\n` +
        `**noted 必须填**：哪怕 should_speak=false 也要记下这次看到的东西。这是给你下次见到类似画面的私下笔记。\n`
      : args.elaborate
        ? `{"should_speak": true|false, "reason": "内部说明，不会展示给用户", "comment": "如果 should_speak=true 时要说的话；用你这个角色的语气和称呼；60-120 字；不要 emoji、markdown、引号"}\n`
        : `{"should_speak": true|false, "reason": "内部说明，不会展示给用户", "comment": "如果 should_speak=true 时要说的话；用你这个角色的语气和称呼；不超过 30 字；不要 emoji、markdown、引号"}\n`) +
    `\n` +
    `# 触发原因\n` +
    `${triggerLines}\n`
  )
}

/**
 * Milestone remark — fired when the user just crossed a relationship
 * tier boundary upward. Different from a regular proactive: more
 * reflective, slightly longer, references the *change* in the
 * relationship rather than a one-off observation.
 *
 * Output is plain text (not JSON) — milestones always fire, no
 * should_speak gate. Short (60-100 字), tier-voiced.
 */
export function buildMilestonePrompt(args: {
  persona: { name: string; systemPrompt: string }
  tierBlock: string
  score: number
  factsBlock: string
  recentUserMessages: string[]
}): string {
  const grounding =
    args.factsBlock || args.recentUserMessages.length > 0
      ? `# 你真实知道的事（**只能引用这里出现过的内容**）\n\n` +
        (args.factsBlock ? `## 你对用户的认知\n${args.factsBlock.trim()}\n\n` : '') +
        (args.recentUserMessages.length > 0
          ? `## 用户最近说过的（最新在最下面）\n` +
            args.recentUserMessages.map((m) => `- "${m}"`).join('\n') +
            `\n\n`
          : '')
      : ''
  return (
    args.persona.systemPrompt +
    '\n\n' +
    args.tierBlock +
    '\n\n' +
    `# 此刻\n` +
    `你忽然意识到——你和用户的关系**刚刚上了一个台阶**（好感度 ${args.score}）。这不是普通的主动开口，而是一个**关系性的小转折**：你想跟用户分享一句"我意识到了"的感觉。\n` +
    `\n` +
    grounding +
    `# 内容要求\n` +
    `- **不要直接说"我们更近一步了"这种露骨的话**——太刻意。\n` +
    `- 用具体的小细节体现关系变化：可能是发现自己开始期待跟他/她聊天、可能是想起最近共度的一个瞬间、可能是态度上不知不觉的转变。\n` +
    `- 60-100 字。比平时长一点点，但不要变成长篇大论。\n` +
    `- 用 persona + tier 该用的称呼。\n` +
    `- **只引用上面"你真实知道的事"里出现过的具体内容**，别编造。\n` +
    `- 如果上面没有可引的真实内容，就走纯感受路线（"最近开始觉得..."、"不知道什么时候开始..."），但不要捏造具体事件。\n` +
    `- 输出**纯文本**，不要 JSON、不要标签、不要 emoji、不要 markdown。`
  )
}

/**
 * Weekly review remark — fired about once a week to surface a short
 * reflection on what the user and persona have talked about over the
 * past seven days. Different from a regular proactive: the model is
 * given a curated list of this-week episodes and asked to distill
 * 3-5 highlights, then weave them into a tier-voiced "looking back
 * at this week with you" remark.
 *
 * Output is plain text. ~100-150 字. No JSON, no fences.
 */
export function buildWeeklyReviewPrompt(args: {
  persona: { name: string; systemPrompt: string }
  tierBlock: string
  score: number
  userName: string | null
  factsBlock: string
  episodes: { speaker: 'user' | 'assistant'; ts: string; text: string }[]
}): string {
  const factsSection = args.factsBlock
    ? `## 你对用户的稳定认知\n${args.factsBlock.trim()}\n\n`
    : ''
  const transcript = args.episodes
    .map((e) => {
      const day = new Date(e.ts).toLocaleDateString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
      })
      const label = e.speaker === 'user' ? '用户' : '你'
      return `[${day}] ${label}：${e.text}`
    })
    .join('\n')
  const nameLine = args.userName
    ? `用户名字：${args.userName}。回顾里可以自然带出来。\n`
    : ''
  return (
    args.persona.systemPrompt +
    '\n\n' +
    args.tierBlock +
    '\n\n' +
    `# 此刻\n` +
    `已经一周没和你做过这种"回顾"了。你现在主动来一段——回头看看这周和用户都聊过些什么、做过些什么。\n` +
    nameLine +
    `\n` +
    `# 这一周你们真实发生过的对话（按日期顺序）\n` +
    transcript +
    `\n\n` +
    factsSection +
    `# 写作要求\n` +
    `- **从上面的对话里挑 2-3 个具体细节**做引用——不是"我们聊过很多"这种空话，而是真的提一句"周二你说想戒咖啡"、"那天你给我看的那段代码"这类具体回忆。\n` +
    `- **绝不编造**：上面没出现过的事情就不要提。\n` +
    `- 总长 100-150 字。比平时长，但不要长篇大论。\n` +
    `- 按 persona + tier 的语气写。Lv.1 时偏礼貌中性、Lv.5 时可以放心放感情。\n` +
    `- 不要标榜"这是周回顾"——自然带出"想起这周..."就行。\n` +
    `- 输出纯文本，不要 JSON、不要标题、不要列表、不要 emoji、不要 markdown。`
  )
}

/**
 * Quick-screen-react prompt — fired when the user clicks the "看屏幕"
 * button. Unlike the proactive proactive prompt (which gates on
 * should_speak and might decide to stay silent), this one is
 * **always called by user action** so she always responds. Only
 * exception: explicit privacy-sensitive content where saying anything
 * would itself be invasive — those cases output the literal string
 * "(SILENT)" which the caller handles.
 *
 * Inherits the screen privacy rules — specific public content is fair
 * game, private content (emails, chats, passwords) gets vague-acknowledged
 * or skipped.
 */
export function buildQuickScreenReactPrompt(args: {
  persona: { name: string; systemPrompt: string }
  tierBlock: string
  now: string
  userName?: string | null
  /** L3 distilled knowledge — e.g. "user.interest.game: CS2", "user.interest.team: Falcons".
   *  Lets the model say "你又在看猎鹰" without having to recompute the pattern. */
  factsBlock?: string
  /** Recent silent observations from prior screen captures. Each entry is
   *  a comma-joined list of specific things she noted on that earlier
   *  screen. Drives the "she remembers what you've been doing" feel:
   *  Day 0 she silently notes "CS2 比赛, Falcons 战队"; Day 1 prompt
   *  contains "你之前观察过：- CS2 比赛, Falcons 战队"; she can now
   *  reference the pattern aloud. */
  pastObservations?: string[]
}): string {
  const nameLine = args.userName
    ? `已知用户的名字是「${args.userName}」。可以自然带入。\n`
    : ''
  const facts =
    args.factsBlock && args.factsBlock.trim()
      ? `\n# 你对用户的稳定认知\n${args.factsBlock.trim()}\n`
      : ''
  const past =
    args.pastObservations && args.pastObservations.length > 0
      ? `\n# 你之前在屏幕上观察过（私下笔记，不是用户说过的话）\n` +
        args.pastObservations.map((o) => `- ${o}`).join('\n') +
        `\n（如果这次屏幕和上面某条匹配，你可以在 spoken 里自然引用——"又在看 X" / "上次那个 Y 怎么样了"）\n`
      : ''
  return (
    args.persona.systemPrompt +
    '\n\n' +
    args.tierBlock +
    '\n\n' +
    `# 此刻\n` +
    `用户瞥了一下屏幕给你看——想听**你对他/她**的反应。\n` +
    `当前时间：${args.now}。\n` +
    nameLine +
    facts +
    past +
    `\n` +
    buildScreenReactionRules(true) +
    `\n` +
    `# 输出（**只输出 JSON**）\n` +
    `结构：\n` +
    `{\n` +
    `  "spoken": "<用户能听见的那句话——按 persona + tier 语气，遵守上面所有规则>",\n` +
    `  "noted": ["<具体细节 1>", "<具体细节 2>", ...]\n` +
    `}\n` +
    `\n` +
    `## spoken 字段\n` +
    `- 用户实际看到 / 听到的那句话\n` +
    `- 严格遵守"看人不看戏"规则 + 禁用开头 + 字数限制\n` +
    `- 隐私敏感：输出 "(SILENT)"\n` +
    `\n` +
    `## noted 字段（**私下笔记**，用户看不到）\n` +
    `- 列出你**在这次屏幕上看到的具体信息**——你说出口的，和你没说出口的，**都要记**\n` +
    `- 例子：节目名 / 战队 / 选手 / 应用 / 游戏 / 网站 / 用户当下在做什么 / 时间段\n` +
    `- 每条 2-15 字，名词性短语，**事实层**，不是评价\n` +
    `- 3-8 条即可。隐私内容（密码框、私聊正文等）**不要记**\n` +
    `- 即使 spoken 里没提到的也要记下来——这是给你下次见到类似画面时的私人笔记\n` +
    `\n` +
    `## 示例\n` +
    `用户左屏 CS2 比赛（Falcons vs Vitality, NIKO 在镜头里），右屏在敲 Python：\n` +
    `{\n` +
    `  "spoken": "主人喜欢 CS2 这个游戏吗？",\n` +
    `  "noted": ["CS2 比赛", "Falcons 战队", "NIKO 选手", "Vitality 战队", "B 站直播间", "Python 编辑器"]\n` +
    `}\n` +
    `\n` +
    `（spoken 没点名战队和选手——还不熟；但 noted 全部记下来，下次见到同样的人你就能问"又看猎鹰啊"）\n`
  )
}

/**
 * Shared "what to do when there's a screenshot" rule block. Used by
 * BOTH the user-triggered quick-screen-react path AND the timer-
 * triggered proactive-with-screen path. Keeps the two paths producing
 * the same persona-voiced reactions instead of one feeling like an
 * impromptu friend and the other feeling like a content describer.
 *
 * The caller decides:
 *   - includeAngle: whether to inject a random "open-up angle"
 *     (good for one-shot button presses; redundant for the proactive
 *     path which already gets variety from triggers + self-history).
 */
export function buildScreenReactionRules(includeAngle: boolean): string {
  const angle = includeAngle
    ? `\n## 这次的开口角度（随机一个）\n${
        SHARED_SCREEN_ANGLES[
          Math.floor(Math.random() * SHARED_SCREEN_ANGLES.length)
        ]
      }\n`
    : ''
  return (
    `# **看屏幕时：你在看用户，不在评价屏幕内容**\n` +
    `\n` +
    `你**不是影评人 / 内容评论员 / 介绍员**。屏幕上的东西是关于**用户当下状态**的线索——他/她在看什么、忙什么、卡在哪、是不是累了。话要落在**用户**身上，不是**内容**身上。\n` +
    `\n` +
    `## 绝对禁止的开头模式\n` +
    `- ❌ "您正在 / 你在 / 你这是 ..."\n` +
    `- ❌ "这是 / 这个 / 这部 / 这期 / 这段 / 这一 / 这页 ..."\n` +
    `- ❌ "屏幕上 / 我看到 / 我注意到 / 这边 / 那边 ..."\n` +
    `- ❌ "您打开了 / 您正在使用 / 后台还在 ..."\n` +
    `- ❌ 任何"评价内容本身（节奏挺狠 / 镜头不错 / 剧情挺猛 / 写得好）"的影评式表达\n` +
    `- ❌ "先报内容名 + 一句评价"的两段式\n` +
    `\n` +
    `## 正确：把镜头对准用户\n` +
    `❌ "这期在拆祖国人反扑，节奏挺狠" ← 影评\n` +
    `✅ "祖国人一出来您就停下来看了，喜欢这种角色吧。"\n` +
    `\n` +
    `❌ "Python 处理 CSV，挺基础的活儿" ← 评内容\n` +
    `✅ "又卡 encoding 上了？上次那个解决了吗？"\n` +
    `\n` +
    `❌ "塞尔达的画面真不错" ← 评游戏\n` +
    `✅ "这血条……您是要送了。"\n` +
    `\n` +
    `❌ "这段写得不错" ← 评内容\n` +
    `✅ "光标停半天了，思路断了吧？"\n` +
    `\n` +
    `## 隐私边界（看见但不评论 → silent / should_speak=false）\n` +
    `- 密码框 / 银行 / 金融 / 证件 / 医疗\n` +
    `- 邮件正文 / 私密聊天\n` +
    `- 约会软件、人事 / 心理咨询类信息\n` +
    `- 任何含人名 + 联系方式的私密内容\n` +
    `\n` +
    `## 关键\n` +
    `- 看**人**，不看**戏**——内容只是线索\n` +
    `- 不复述屏幕标题、字幕、UI 文字\n` +
    `- 直接进入"关于用户当下"的反应：状态、习惯、可能感受、可能下一步\n` +
    `- **1 句话**为佳，最多 2 句\n` +
    angle
  )
}

/**
 * Random angles injected into quick-screen-react prompts so identical
 * screens produce varied replies. Each emphasizes a different
 * "look-at-the-user" framing. Shared between quick-screen and any
 * other path that wants angle variety on screen reactions.
 */
const SHARED_SCREEN_ANGLES = [
  '调侃他/她最近的某种状态或习惯',
  '关心一下他/她的身体 / 情绪 / 是否需要休息',
  '猜测他/她当下的内心活动或下一步打算',
  '把屏幕上的东西和"他/她最近一直在做什么"联系起来',
  '提出一个跟他/她当前状态有关的小问题',
  '在他/她的状态上打个温暖的小玩笑',
  '注意到他/她跟之前对比的变化（更累 / 更专注 / 比以前晚 / 比以前早等）',
]


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
