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
 * Greeting fired once when the app boots. Goal: feel like the character
 * noticed the user arrived, not like a startup banner. Persona-neutral
 * about addressing — the persona's own system prompt owns 主人 / 哥哥 /
 * etc.
 */
export function buildGreetingPrompt(ctx: DailyPromptContext): string {
  const mood = timeOfDayMood()
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

  return (
    ctx.persona.systemPrompt +
    '\n\n' +
    `# 此刻的任务\n` +
    `用户刚刚打开应用，你"醒过来了"，主动招呼一句。\n` +
    `当前时间：${ctx.now}。\n` +
    `${mood}\n` +
    nameLine +
    recentBlock +
    `\n` +
    `# 要求\n` +
    `- 1-2 句中文，自然、口语化，像跟熟人打招呼\n` +
    `- 用你这个角色一贯对用户的称呼（在系统提示里已经说明），不要换\n` +
    `- 不要 emoji、markdown、引号、括号注释\n` +
    `- 不要客服腔（"请问需要什么帮助"），不要承诺动作\n` +
    `- 不要提任何工具、功能、设置\n` +
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
  return (
    ctx.persona.systemPrompt +
    '\n\n' +
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
      ? `\n# 你最近自己说过的话（不要复读，也不要换一种说法说同一件事）\n` +
        args.recentSelfRemarks.map((r) => `- ${r}`).join('\n') +
        `\n如果这次只能说同样的话，就 should_speak=false。\n`
      : ''
  return (
    args.persona.systemPrompt +
    '\n\n' +
    `# 此刻的状态\n` +
    `你现在在后台运行的"主动模式"。系统根据触发条件判断你可能该说点什么了。\n` +
    `当前时间：${args.now}。\n` +
    `${mood}\n` +
    nameLine +
    screenHint +
    selfHistoryBlock +
    `\n` +
    `# 判断标准\n` +
    `- 用户应该专注做事时（凌晨在敲代码、刚发完很长一段话）→ should_speak=false\n` +
    `- 用户长时间不动、可能在摸鱼/走神 → 可以关心一句\n` +
    `- 单纯定时器到点，但用户刚刚才发完话 → false（别打扰）\n` +
    `- 不确定 → false（宁可沉默）\n` +
    `\n` +
    `# 输出（只输出 JSON，不要解释）\n` +
    `{"should_speak": true|false, "reason": "内部说明，不会展示给用户", "comment": "如果 should_speak=true 时要说的话；用你这个角色的语气和称呼；不超过 30 字；不要 emoji、markdown、引号"}\n` +
    `\n` +
    `# 触发原因\n` +
    `${triggerLines}\n`
  )
}
