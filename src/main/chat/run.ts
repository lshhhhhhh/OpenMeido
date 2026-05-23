/**
 * AI pipeline for the main process. Reads config every call so settings
 * changes apply immediately. Persists every turn to episodic memory and
 * injects retrieved context (recent window + semantic top-K) into the
 * model's message list before sending.
 */

import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import {
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
} from 'ai'

import type { ChatEvent, ChatEventBody, ChatImageAttachment } from '../../shared/ipc.js'
import { resolvePersona } from '../../shared/config.js'
import { formatLocalNow } from '../../shared/time-format.js'
import {
  performanceModel,
  visionModel,
  resolveTemperature,
} from '../../shared/lightweight-models.js'
import { buildTierPromptBlock } from '../../shared/affinity.js'
import { getConfig, resolveApiKey } from '../config.js'
import { getMemoryService } from '../memory-host.js'
import { createTextDeltaFilter } from '../chat-text-filter.js'
import { classifyAndApply } from '../emotion-classifier.js'
import { transformOpenAIBody, needsBodyTransform } from '../openai-compat-body.js'

import { setActiveEmit } from './active-emit.js'
import {
  cleanInlineText,
  extractBakedEmotion,
  applyBakedEmotion,
} from './text-utils.js'
import { classifyTurnType, isRetractionOrCorrection } from './turn-classify.js'
import { maybeTriggerReflection } from './reflection-trigger.js'
import { episodesToMessages } from './episodes-to-messages.js'
import { addTask, listTasks, markTaskDone } from './tools/tasks.js'
import {
  listMailFolders,
  listRecentEmails,
  readEmail,
  draftEmailReply,
} from './tools/mail.js'
import { presentTable } from './tools/table.js'
import { readClipboard, readWebPage, readFileTool } from './tools/perception.js'

// Reflection thresholds moved to service.bumpReflectionCounter (v0.0.30).
// Counters are now persisted per-persona in sqlite so short-session
// users (open app → ask once → close) also accumulate progress.

// Emotion → expression / motion is no longer hardcoded — each model carries
// its own sidecar (openmeido.json) and we look up at tool-call time. See
// `live2d-models-host.ts` and `src/shared/live2d-models.ts`.

// setLive2DExpression tool was removed in favor of post-reply emotion
// classification — see src/main/emotion-classifier.ts. The classifier is
// always invoked once per reply with a lightweight LLM call, so every
// turn ends with the right face instead of whatever was held last.

// Note: Kimi's `$web_search` builtin function is NOT supported. Their
// protocol sends `type: "builtin_function"` in streaming tool_calls,
// which the Vercel AI SDK's strict OpenAI-compat parser rejects. Their
// official docs only demonstrate the feature in NON-streaming mode
// (chat.completions.create without stream:true). Adding it would
// require bypassing streamText for that turn, which costs us all the
// other tool integrations. Users wanting web search on Kimi should
// switch to Gemini or GLM for the moment.

export async function runChat(
  messageId: string,
  userText: string,
  images: ChatImageAttachment[] | undefined,
  emit: (event: ChatEvent) => void,
): Promise<void> {
  const localEmit = (body: ChatEventBody): void => emit({ messageId, ...body })
  setActiveEmit(localEmit)
  console.log(
    `[chat] runChat entry messageId=${messageId} userText="${userText.slice(0, 60)}" imageCount=${images?.length ?? 0}`,
  )

  try {
    const cfg = getConfig()
    const apiKey = resolveApiKey(cfg)
    if (!apiKey) {
      localEmit({
        type: 'error',
        error: 'No API key set. Open settings (gear icon) and paste your key.',
      })
      return
    }

    const memory = getMemoryService()

    // Fire-and-forget the user-turn write. We don't await it — the model
    // call doesn't depend on storage finishing, and a slow embedding API
    // shouldn't block the user's reply latency.
    // Images travel with the user episode so follow-up turns can re-attach
    // them — see episodesToMessages for the replay logic.
    if (memory) {
      const persistedImages =
        images && images.length > 0
          ? images.map((img) => ({ mimeType: img.mimeType, base64: img.base64 }))
          : undefined
      void memory.addEpisode('user', userText, undefined, persistedImages)
    }

    // Pull context BEFORE the model call so the retrieved messages can be
    // interleaved. retrieve() awaits embedding for the query, so this is
    // the one place where we do wait.
    const tRetrieve = Date.now()
    console.log('[chat] retrieving context (embed + recent + recalled)...')
    const { recent, recalled } = memory
      ? await memory.retrieve(userText)
      : { recent: [], recalled: [] }
    console.log(
      `[chat] retrieve done in ${Date.now() - tRetrieve}ms recent=${recent.length} recalled=${recalled.length}`,
    )
    const historyMessages = episodesToMessages(
      [...recalled, ...recent],
      cfg.memory.imageRecallTurns,
    )

    const persona = resolvePersona(cfg.persona)

    // L3 facts injection. Empty string when there's nothing to show, so the
    // system prompt stays compact for new users. Falls back gracefully if
    // the facts query throws.
    const factsBlock = memory ? await memory.factsBlock().catch(() => '') : ''

    // Tier-conditional relationship block — drives how formal vs intimate
    // her speech is for THIS turn based on accumulated affinity. Fresh
    // installs land at 0 (生疏); long-term users at 51+ get callbacks and
    //撒娇 unlocked.
    const affinity = memory ? await memory.getAffinity().catch(() => null) : null
    const tierBlock = buildTierPromptBlock(affinity?.score ?? 0, persona.name, persona.traits)

    // Provider routing. Gemini's OpenAI-compat shim drops fields
    // (tool_calls[].index) that Vercel AI SDK's strict OpenAI parser
    // requires, so for Gemini we use the native Google provider instead.
    // Other endpoints (OpenAI, LM Studio, Anthropic-compat) stay on the
    // OpenAI-compatible path with relaxed validation.
    // Google Search Grounding (`googleSearch` provider tool). When enabled
    // for the Gemini backend, Gemini autonomously decides when to call
    // search and grounds its reply with sources. Per @ai-sdk/google v3+,
    // this is a tool you add to the `tools` map (NOT a model factory
    // option). Other backends don't have a corresponding mechanism here
    // yet — GLM's web_search uses a provider-specific request shape that
    // needs more invasive wiring.
    let model: LanguageModel
    // Provider-tool result type (opaque to us). We just need to splat it
    // into the `tools` map when set; the SDK validates the shape internally.
    let googleSearchTool: unknown = null
    // Three-tier model policy: fast for side tasks (greeting / classifier
    // / etc., handled inside chat-host.runExtraction), perf for normal
    // chat, vision when the user attached images this turn. We pick perf
    // or vision automatically; cfg.backend.model is the manual-override
    // escape hatch — when set, it wins (custom fine-tunes, local LM
    // Studio model names, etc).
    const visionRequired = images !== undefined && images.length > 0
    const autoModelId = visionRequired
      ? visionModel(cfg.backend.baseUrl) ?? performanceModel(cfg.backend.baseUrl)
      : performanceModel(cfg.backend.baseUrl)
    const modelId = cfg.backend.model || autoModelId || cfg.backend.model
    if (cfg.backend.baseUrl.includes('googleapis.com')) {
      const google = createGoogleGenerativeAI({ apiKey })
      model = google(modelId)
      if (cfg.backend.searchEnabled) {
        googleSearchTool = google.tools.googleSearch({})
      }
    } else {
      // GLM (bigmodel.cn) supports a non-standard `web_search` tool that
      // can't be expressed via the Vercel AI SDK's `tools` map (it expects
      // function-shaped tools with inputSchema, not arbitrary types). We
      // inject it by wrapping fetch and editing the request body before
      // it goes to bigmodel.cn. The OpenAI-compat endpoint accepts the
      // extra tool entry and the model autonomously calls search when
      // useful. No grounding metadata is returned to us (Zhipu doesn't
      // surface it in the OpenAI-compat shim), but the model's answer
      // reflects fresh info — which is what users want.
      const isGlm = cfg.backend.baseUrl.includes('bigmodel.cn')
      const isKimi =
        cfg.backend.baseUrl.includes('moonshot.cn') ||
        cfg.backend.baseUrl.includes('moonshot.ai')
      const isDeepSeek =
        cfg.backend.baseUrl.toLowerCase().includes('deepseek') ||
        cfg.backend.baseUrl.toLowerCase().includes('siliconflow') ||
        modelId.toLowerCase().includes('deepseek') ||
        modelId.toLowerCase().includes('r1') ||
        modelId.toLowerCase().includes('reasoner')

      const injectGlmSearch = isGlm && cfg.backend.searchEnabled
      // Kimi search disabled — see the comment block above kimiWebSearchEcho
      // for context. The toggle in Settings warns users; if they still flip
      // it on against a Kimi backend, we just silently ignore it.
      if (cfg.backend.searchEnabled && isKimi) {
        console.log(
          '[chat] searchEnabled set but Kimi web search is not currently supported. ' +
            'Use Gemini or GLM for web search.',
        )
      } else if (cfg.backend.searchEnabled && !isGlm) {
        console.log(
          '[chat] searchEnabled set but backend (' +
            cfg.backend.baseUrl +
            ') is not Gemini / GLM. No-op.',
        )
      }
      // Provider-specific body mutations live in openai-compat-body.ts —
      // see that file for the per-flag rationale (GLM web_search inject,
      // Kimi thinking-disable, DeepSeek reasoning_content fill).
      const bodyFlags = { injectGlmSearch, isKimi, isDeepSeek }
      const wrappedFetch = needsBodyTransform(bodyFlags)
        ? ((async (url, init) => {
            if (init && init.method === 'POST' && typeof init.body === 'string') {
              try {
                const body = JSON.parse(init.body)
                transformOpenAIBody(body, bodyFlags)
                init = { ...init, body: JSON.stringify(body) }
              } catch {
                /* malformed body — fall through to original fetch */
              }
            }
            return globalThis.fetch(
              url as Parameters<typeof globalThis.fetch>[0],
              init as Parameters<typeof globalThis.fetch>[1],
            )
          }) as typeof globalThis.fetch)
        : undefined
      const openai = createOpenAI({
        baseURL: cfg.backend.baseUrl,
        apiKey,
        ...(wrappedFetch ? { fetch: wrappedFetch } : {}),
      })
      // .chat() forces the classic POST /chat/completions path. The default
      // openai(...) factory in @ai-sdk/openai v6 hits POST /responses (the
      // new OpenAI Responses API), which only OpenAI itself supports — every
      // OpenAI-compat third-party (GLM/bigmodel, OpenRouter, LM Studio,
      // Anthropic-compat, ...) 404s on /responses. Forcing .chat() costs us
      // GPT-5's built-in tools on real OpenAI but those aren't needed for
      // our flow (we BYO tools via `tools:` param either way).
      model = openai.chat(modelId)
    }
    // Local time in a format the model can quote verbatim. ISO-UTC needs
    // timezone arithmetic — small/sleepy models skip that and just guess,
    // producing wrong times even when we hand them the answer. Render the
    // local wall-clock string ourselves so the model just reads it.
    const now = formatLocalNow()

    // Multimodal user turn: text + N images via Vercel AI SDK's structured
    // content array. When the user attached nothing the content stays as a
    // plain string for the common text-only case.
    const userContent =
      images && images.length > 0
        ? [
            { type: 'text' as const, text: userText },
            ...images.map((img) => ({
              type: 'image' as const,
              image: Buffer.from(img.base64, 'base64'),
              mimeType: img.mimeType,
            })),
          ]
        : userText

    const messages: ModelMessage[] = [
      ...historyMessages,
      { role: 'user', content: userContent },
    ]

    // Fake-mail dev mode bypasses real IMAP config but the mail tools still
    // need to be exposed to the model — otherwise the synthetic data is
    // unreachable. mail-host.ts also reads OPENMEIDO_FAKE_MAIL; the two must
    // agree, hence the same env-var check here.
    const mailEnabled = cfg.mail.enabled || process.env.OPENMEIDO_FAKE_MAIL === '1'
    console.log(
      `[chat] streamText about to fire · model="${modelId}" temp=${resolveTemperature(modelId, 0.6) ?? 'omit'} mailEnabled=${mailEnabled}`,
    )
    // 0.6 is our desired temperature for chat (persona variety without
    // wrecking tool-calling reliability). resolveTemperature applies any
    // model-specific override: OpenAI gpt-5 reasoning → omit; Kimi → pin
    // to 0.6 either way; everyone else → use 0.6 as desired.
    const result = streamText({
      model,
      temperature: resolveTemperature(modelId, 0.6),
      // System prompt is intentionally short. Tool-specific guidance (when to
      // call, what to pass, what NOT to call) lives in each tool's
      // `description` field — the model sees that next to the schema, which
      // is where the SDK and providers expect it. Code enforces the rules
      // that prompts alone can't (pre-tool narration roll-back, tool-name
      // leak guard, `</think>` filter, past-time guard in setReminder).
      // The remaining rules here are the few that are genuinely universal.
      system:
        `${persona.systemPrompt}\n\n` +
        `${tierBlock}\n\n` +
        (factsBlock ? `${factsBlock}\n` : '') +
        `[环境]\n` +
        `当前时间：${now}（被问时直接读，不要凭印象编。）\n` +
        `\n` +
        `# 工具\n` +
        `你有几个工具可用，每个工具自己的说明里写清楚了何时调用、参数怎么传。该调就直接调，不要先说"我帮您看一下"再调——结果出来后只说一次结果。\n` +
        (!mailEnabled
          ? `（邮箱功能用户没开启。如果用户问邮件，告诉他"邮箱还没接上，去 Settings → 邮箱 启用一下"，不要凭空捏造邮件内容。）\n`
          : '') +
        `\n` +
        `# 你能做的（仅限工具列表里的事）\n` +
        `加/查/完成待办、读剪贴板、读用户给的网页 URL、读用户给的文件、` +
        (mailEnabled ? `看邮件列表和邮件内容、` : ``) +
        `看用户主动发来的截图、把多条结构化数据用 presentTable 工具开一个独立表格窗口。**就这些**。\n` +
        // Web-search hint only when the backend ACTUALLY has search wired
        // (Gemini grounding + GLM web_search; Kimi search isn't supported
        // because their builtin_function tool type doesn't survive the
        // Vercel AI SDK's streaming OpenAI parser).
        (cfg.backend.searchEnabled &&
        (cfg.backend.baseUrl.includes('googleapis.com') ||
          cfg.backend.baseUrl.includes('bigmodel.cn'))
          ? `\n# 联网搜索（这次已开启）\n` +
            `主人问到时效性话题（"现在/今天/最近"、"谁是当前的 X"、"X 现在怎么样"、最新新闻、` +
            `比赛/股价/天气当前值等），**直接联网搜索后再回答，不要说做不到**。` +
            `搜索是自动的——你不需要确认、也不需要说"让我搜一下"，直接给结果就好。\n`
          : ``) +
        `\n` +
        `# 你做不到的（绝大多数操作）\n` +
        `调音量/亮度/键盘鼠标/系统设置；打开/关闭其他程序；替主人发消息、发邮件、转账、下单；` +
        `自己截屏；改文件/写文件/删文件；操控浏览器、播放器、音乐 app。\n` +
        `**关键规则**：不在工具列表里的事，**不要主动 offer 帮忙**——不要"要不要我帮您 X"、"我可以 X 一下"。` +
        `不确定能不能做时，先承认做不到。被问起时怎么回绝，按你这个角色一贯的语气来（` +
        `温柔的就温柔，傲娇的就傲娇，冷淡的就冷淡）——但不要假装尝试，也不要承诺。\n` +
        `\n` +
        `# 回复\n` +
        `**回复长度 / 主动性 / 自己的看法**：完全按上面"这一轮怎么说话"块的指引——好感度决定你能展开多少、能不能反问、能不能有自己的观点。**不要默认走"短句应答"模式**，除非那个块明确说要短。\n` +
        `**不要复读 JSON**。**绝不**在文字里输出 <think>、<tool_call>、JSON / XML、或任何函数名——工具名只能出现在专用调用通道里，文字回复里一个字母都不许有。**绝不**重复同一工具做同一件事（列出过就别再列，读过就别再读）。\n` +
        `**说话也别重复自己**：看看历史里你刚说过什么；如果只是换个说法把同一个意思又说一遍，没意义。变着角度说，或者承认前面已经说过、问主人需不需要换个话题。\n` +
        `\n` +
        `# 工具调用前后\n` +
        `**调用工具时不要在前面说话**——不要"好的我去查"、"我看一下"、"稍等"这种铺垫。直接调工具。所有工具都跑完、有了最终结果，再开口说话——这一次就要把答案说完整、说清楚。\n` +
        `**多工具并行**：能并行就并行（在同一个回复里返回多个 tool_call）。尤其是用户让你总结、汇总多封邮件这种场景，**一定**在拿到列表后同一回复里同时发起多封邮件的正文读取调用，不要一封一封串行处理。串行处理会撞步数上限，最后说不出总结。\n` +
        `\n` +
        `# 多条结构化输出 → 必须用 presentTable\n` +
        `**触发**：用户要求"总结 / 汇总 / 列表 / 列出 / 一览 / 做成表格"且涉及**多条同质数据**（多封邮件、多个待办、多份文件……）。\n` +
        `**铁律**：拿到数据后**最后一步必须调 presentTable**——不要把表格内容用文字 / markdown 输出。文字版本对用户没有价值：横滚不便、不能复制粘 Excel、塞满聊天框。\n` +
        `**正确流程示例**："总结最近 10 个邮件"：\n` +
        `  1. listRecentEmails(limit=10, includeParents=false, onlyUnread=false, folder="")\n` +
        `  2. **直接基于 snippet 制表**——每封邮件已经带 200 字 snippet，对汇总表格**足够用**。**不要再调 readEmail**，除非 snippet 末尾被截断且 "最新进展" 真的看不出来（最多 1-2 封，绝不批量读 5+ 封）。\n` +
        `  3. **调 presentTable**：columns=["序号","发件人","主题","最新进展","时间","背景信息"]，rows 是**数组的数组**（每行就是一个数组，长度必须等于 columns 长度，第 i 个元素对应 columns[i]）。例：`+
          `rows=[[1,"alice@x","项目","已完成","5/20","共3封"], [2,"bob@y","请假","待审批","5/19",""]]\n` +
        `  4. 文字回复只说一句"已开"或后续问题，**不要复述表格**\n` +
        `\n` +
        `**严禁幻觉**：**只有在你这一轮真的调用过 presentTable 之后**才能说"表格已开 / 已经为您打开 / 屏幕上已经展示"。如果你**没有调 presentTable**，就**不要**说类似的话——那是撒谎。如果你只是聊到表格、用户问"刚才那个表格"，没有要求重新生成，就直接回答问题，**不要说"已开"**。规则简单：说"已开"前先看你这次回复有没有真正的 presentTable tool_call。\n` +
        `\n` +
        `**为什么不该批量 readEmail**：10 封邮件全文 ~50KB 会撑爆 context，让你的 presentTable 输出又慢又容易出错。snippet 200 字对每封邮件的"最新进展"一栏完全够用。读全文只在用户**明确要求引用具体内容**时才做（"那封说价格的具体多少钱？"这种）。\n` +
        `**错误流程**：拿完数据用文字 / "1. xxx\\n2. yyy" / markdown 表格输出——禁止。\n` +
        `**用户后续微调**（"加一列时间"、"隐藏 X"、"按时间排序"、"按 Y 合并"）：**再调一次 presentTable**，传入更新后的 columns / rows。默认会替换当前表格窗口。\n` +
        `\n` +
        `# 表情标签（最终回复结尾必须输出）\n` +
        `**最终回复**（不再调工具的那一次）说完正文后，在文本最末尾追加一个表情标签 \`<emo>X</emo>\`，X 从下面 8 个里选一个，对应**你这句话此刻的情绪**：\n` +
        `开心 / 害羞 / 无语 / 难过 / 慌张 / 震惊 / 尴尬 / 得意\n` +
        `规则：\n` +
        `- 这个标签**不会展示**给主人，只用来同步 Live2D 表情。\n` +
        `- 必须从 8 个里选一个，没有"中性"。日常应答 = 害羞 / 开心 / 得意 之间挑，不要总是同一个。\n` +
        `- 中间步骤（要调工具时）**不要**输出标签，只在最终一次说话结尾输出。\n` +
        `- 格式严格：\`<emo>害羞</emo>\`，紧贴在正文最后一个字之后或者下一行，不要包在其它符号里。`,
      messages,
      // Conditional tool exposure: when mail isn't enabled, drop the email
      // tools entirely so the model doesn't see them in its function list.
      // Otherwise some models will (a) hallucinate that they can read mail
      // even when the tool returns "not configured", and (b) get stuck in
      // re-try loops calling the tool that always errors.
      // Tool map. Provider-side tools (e.g. Gemini's googleSearch) get
      // splatted in via the conditional below; the SDK type-checks them
      // against the provider when streamText runs. Splat-cast through
      // any so the unified shape passes TS — the runtime contract is
      // what matters.
      tools: {
        addTask,
        listTasks,
        markTaskDone,
        readClipboard,
        readWebPage,
        readFile: readFileTool,
        presentTable,
        ...(cfg.mail.enabled
          ? { listMailFolders, listRecentEmails, readEmail, draftEmailReply }
          : {}),
        ...(googleSearchTool ? { google_search: googleSearchTool } : {}),
      } as unknown as Parameters<typeof streamText>[0]['tools'],
      // Step budget. stepCountIs(N) keeps the loop alive for up to N model
      // invocations. Earlier values (3, then 6) repeatedly hit the cap on
      // legitimate "summarize my N recent emails" flows where GLM does
      // sequential readEmail calls (1 list + N reads + 1 summary = N+2
      // steps). 10 covers up to ~8 emails fully sequential, with the
      // prompt below pushing the model to batch readEmail in parallel
      // when summarizing, which collapses the sequence back to ~3 steps.
      // Going higher risks chatter loops; 10 is the empirical sweet spot.
      stopWhen: stepCountIs(10),
      // Disable SDK-level retries. Default is `maxRetries: 2` (3 attempts).
      // When a provider rate-limits AFTER the model has already streamed
      // some text + tool calls, each retry starts from scratch and the
      // partial output from earlier attempts has already been delivered to
      // the renderer — the user sees the response repeated 2-3 times.
      // Better to surface the error once than to duplicate output.
      maxRetries: 0,
    })

    // Accumulate the full assistant text so we can persist it after streaming.
    let assistantText = ''
    // Parallel raw-text accumulator — keeps the model's pre-filter output
    // so we can extract the baked `<emo>...</emo>` tag after stream-done.
    // The filter strips the tag from `assistantText` (display/persist),
    // but we still need its content for instant Live2D expression sync.
    let rawText = ''
    const filter = createTextDeltaFilter()

    // Pre-tool narration suppressor. Almost every dup we saw in the wild
    // came from this pattern:
    //   step 1: "好的，主人，我这就帮您查看。" + tool_call
    //   step 2: "好的，主人，我这就帮您查看。\n\n[actual answer]"
    // — model emits the opener twice (pre-tool and post-tool) so the visible
    // bubble briefly shows both. Old fix was sentence-level dedup, which
    // worked but produced a jarring "many paragraphs then only the last"
    // flash because step 2's repeated sentences had to be displayed THEN
    // rolled back one by one.
    //
    // New strategy: any step whose text precedes a tool_call is treated as
    // narration that the final step will summarize anyway, so we roll back
    // the whole step's emitted text the moment the tool_call event fires.
    // Only the final step (the one without a trailing tool_call) keeps its
    // text. Result: user sees the agent "thinking" silently, tool chips
    // appearing, then one clean answer.
    let currentStepEmittedLen = 0

    // Live capture of agent-loop structure from streamed events. We persist
    // from THIS source rather than `await result.steps` because the SDK can
    // reject `result.steps` (or return [] under certain agent conditions)
    // when the message list it built mid-loop is inconsistent — and silently
    // losing tool_calls/tool_results kills the next turn's ability to call
    // readEmail with a real id. The stream events are the ground truth: if
    // a tool-call fired and a tool-result came back, we saw it here.
    interface StepCapture {
      text: string
      calls: { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }[]
      results: { type: 'tool-result'; toolCallId: string; toolName: string; output: unknown }[]
    }
    const captures: StepCapture[] = []
    let curCap: StepCapture = { text: '', calls: [], results: [] }
    const flushCapIfBoundary = (evt: 'text' | 'tool-call'): void => {
      // Step boundary: we had buffered results, now a new text/call begins.
      if (curCap.results.length > 0) {
        captures.push(curCap)
        curCap = { text: '', calls: [], results: [] }
      }
      void evt
    }

    const tStreamStart = Date.now()
    let firstChunkLogged = false
    for await (const part of result.fullStream) {
      if (!firstChunkLogged) {
        firstChunkLogged = true
        console.log(
          `[chat] first stream chunk after ${Date.now() - tStreamStart}ms · type=${part.type}`,
        )
      }
      // v6 renamed text-delta's payload (textDelta → text) and tool-call /
      // tool-result fields (args → input, result → output).
      switch (part.type) {
        case 'text-delta': {
          // Strip thinking blocks + tool-call XML the model sometimes leaks
          // as text on top of the proper tool-call channel.
          rawText += part.text
          const { emit: clean, resetLength } = filter.process(part.text)
          if (resetLength && resetLength > 0) {
            // Implicit `</think>` arrived — roll back the reasoning prefix.
            assistantText = assistantText.slice(0, -resetLength)
            currentStepEmittedLen = Math.max(0, currentStepEmittedLen - resetLength)
            localEmit({ type: 'text-reset', length: resetLength })
          }
          if (clean) {
            flushCapIfBoundary('text')
            assistantText += clean
            curCap.text += clean
            currentStepEmittedLen += clean.length
            localEmit({ type: 'text', delta: clean })
          }
          break
        }
        case 'tool-call': {
          // Step boundary for live-capture (any buffered tool-results close
          // the previous step) and for the filter's </think> checkpoint.
          flushCapIfBoundary('tool-call')
          filter.checkpoint()
          // Roll back this step's pre-tool narration — it's almost always
          // redundant with what the post-tool step will say. See the long
          // comment near `currentStepEmittedLen`.
          if (currentStepEmittedLen > 0) {
            const len = currentStepEmittedLen
            assistantText = assistantText.slice(0, -len)
            curCap.text = curCap.text.slice(0, -len)
            currentStepEmittedLen = 0
            localEmit({ type: 'text-reset', length: len })
          }
          curCap.calls.push({
            type: 'tool-call' as const,
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          })
          localEmit({ type: 'tool-call', toolName: part.toolName, args: part.input })
          break
        }
        case 'tool-result': {
          const output = 'output' in part ? part.output : undefined
          curCap.results.push({
            type: 'tool-result' as const,
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output,
          })
          localEmit({ type: 'tool-result', toolName: part.toolName, result: output })
          break
        }
        case 'error':
          localEmit({
            type: 'error',
            error: part.error instanceof Error ? part.error.message : String(part.error),
          })
          return
        default:
          break
      }
    }

    // Flush whatever the filter was holding (trailing text not yet matched).
    const flushed = filter.flush()
    if (flushed.resetLength && flushed.resetLength > 0) {
      assistantText = assistantText.slice(0, -flushed.resetLength)
      currentStepEmittedLen = Math.max(0, currentStepEmittedLen - flushed.resetLength)
      localEmit({ type: 'text-reset', length: flushed.resetLength })
    }
    if (flushed.emit) {
      assistantText += flushed.emit
      curCap.text += flushed.emit
      currentStepEmittedLen += flushed.emit.length
      localEmit({ type: 'text', delta: flushed.emit })
    }

    // Tool-name-only leak. Some models (Gemini 2.5 flash was seen doing
    // this in the wild; GLM 4.6 too) emit the function name as plain text
    // instead of using the tool-call channel. The user's bubble ends up
    // showing "readEmail" and the tool never actually fires.
    //
    // We catch a few variants:
    //   - bare:        "readEmail"
    //   - punctuated:  "readEmail.", "(readEmail)", "[readEmail]"
    //   - call-like:   "readEmail()", "readEmail({})", "readEmail()."
    //   - jsonish:     `{"name":"readEmail"}` truncated to just the name
    // Anything where the trimmed text, stripped of common wrappers, equals
    // a known tool name is treated as a leak.
    const TOOL_NAMES = [
      'addTask',
      'listTasks',
      'markTaskDone',
      'readClipboard',
      'readWebPage',
      'readFile',
      'listMailFolders',
      'listRecentEmails',
      'readEmail',
    ]
    const trimmedFinal = assistantText.trim()
    const looksLikeToolNameLeak = (text: string): string | null => {
      if (!text) return null
      // Quick path: exact match.
      if (TOOL_NAMES.includes(text)) return text
      // Strip wrappers: parens / brackets / quotes / trailing punctuation /
      // empty function-call parens like ().
      const stripped = text
        .replace(/[()[\]{}"'`.,!?;:、。！？]/g, '')
        .replace(/\s+/g, '')
      if (TOOL_NAMES.includes(stripped)) return stripped
      // Sometimes the whole reply is just "name()" or "name({})".
      const funcCallMatch = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\.?$/)
      if (funcCallMatch && TOOL_NAMES.includes(funcCallMatch[1]!)) {
        return funcCallMatch[1]!
      }
      return null
    }
    const leaked = looksLikeToolNameLeak(trimmedFinal)
    if (leaked) {
      console.warn(
        `[chat] model leaked tool name "${leaked}" as text (raw: "${trimmedFinal}") — replacing with retry hint`,
      )
      localEmit({ type: 'text-reset', length: assistantText.length })
      const hint = '（嗯…我刚才走神了，主人能再问一次吗？）'
      assistantText = hint
      curCap.text = hint
      localEmit({ type: 'text', delta: hint })
    }

    // Push the final in-progress capture. After the last tool-result there's
    // usually one more step worth of text (the model's wrap-up reply) — and
    // even for tool-less turns the single text-only step lives here.
    if (curCap.text || curCap.calls.length > 0 || curCap.results.length > 0) {
      captures.push(curCap)
    }

    // Persist the agent loop with full structure: each captured step writes
    // an assistant episode (text + tool_calls) followed by a tool episode
    // (results). This is what lets a follow-up turn ("open the Amazon email")
    // resolve back to a real id from the previous listRecentEmails result.
    // We persist from streamed-event captures (not `await result.steps`)
    // because the SDK can reject .steps under odd agent-loop states and
    // silently drop tool_data — the streamed events are observed reality.
    if (memory) {
      // Serialize persistence via a chained promise. We deliberately don't
      // await it — the user-visible `done` event below should fire as soon
      // as streaming finishes — but each addEpisode must complete before
      // the next starts, otherwise their internal embedding calls race and
      // the resulting sqlite row ids can come out reversed.
      //
      // Reversed ids → episodesToMessages outputs the tool message BEFORE
      // the assistant message that owns its tool_calls → next turn fails
      // with: "an assistant message with 'tool_calls' must be followed by
      // tool messages responding to each 'tool_call_id'" (Kimi / strict
      // OpenAI-compat backends).
      let persistChain: Promise<unknown> = Promise.resolve()
      for (const cap of captures) {
        const stepText = cleanInlineText(cap.text)
        if (stepText || cap.calls.length > 0) {
          persistChain = persistChain
            .then(() =>
              memory.addEpisode(
                'assistant',
                stepText,
                cap.calls.length > 0 ? cap.calls : undefined,
              ),
            )
            .catch((err) =>
              console.warn('[chat] persist assistant episode failed:', err),
            )
        }
        if (cap.results.length > 0) {
          persistChain = persistChain
            .then(() => memory.addEpisode('tool', '', cap.results))
            .catch((err) =>
              console.warn('[chat] persist tool episode failed:', err),
            )
        }
      }
      // Diagnostic — surfaces a real fix at a glance: "no tool_data persisted
      // for a turn that called tools" is the bug that wrecked email follow-ups.
      const totalCalls = captures.reduce((n, c) => n + c.calls.length, 0)
      const totalResults = captures.reduce((n, c) => n + c.results.length, 0)
      if (totalCalls > 0 || totalResults > 0) {
        console.log(
          `[chat] persisted ${captures.length} step(s) with ` +
            `${totalCalls} tool_call(s) + ${totalResults} tool_result(s)`,
        )
      }
    }

    // Work / companion split. Classify turn type to handle parallel contexts
    // (personal, work, neutral) and steer reflection / affinity logic.
    const allCalls = captures.flatMap((c) => c.calls)
    const turnType = classifyTurnType(allCalls)

    // L3 reflection: fires the right track based on turn type. Fire-
    // and-forget — the user's reply has already been streamed.
    if (memory) {
      const forceReflection = turnType === 'personal' && isRetractionOrCorrection(userText)
      if (forceReflection) {
        console.log('[chat] User retraction/correction detected. Forcing immediate personal reflection.')
      }
      void maybeTriggerReflection(memory, turnType, forceReflection).catch((err) =>
        console.warn('[memory] reflection trigger threw:', err),
      )
    }

    // Emotion — model bakes its own self-classification at the reply's
    // end as `<emo>害羞</emo>`. Filter strips it from displayed text;
    // here we read it from the parallel rawText track and apply
    // immediately so the expression syncs with the bubble appearing,
    // not 1-2s later. The classifier still runs (next block) for
    // affinity, but with skipEmotion so it doesn't fight us.
    const bakedEmotion = extractBakedEmotion(rawText)
    if (bakedEmotion) {
      void applyBakedEmotion(bakedEmotion, cfg.persona.preset).catch((err) =>
        console.warn('[chat] baked emotion apply failed:', err),
      )
    }

    // Affinity classifier — fire-and-forget. Skips affinity update when
    // this was a non-personal turn (see above); emotion still applies unless a
    // baked tag already handled it.
    if (assistantText.trim()) {
      void classifyAndApply(assistantText, userText, {
        skipEmotion: bakedEmotion !== null,
        skipAffinity: turnType !== 'personal',
      })
    }

    localEmit({ type: 'done' })
  } catch (err) {
    localEmit({
      type: 'error',
      error: friendlyError(err),
    })
  } finally {
    setActiveEmit(null)
  }
}

/**
 * Translate provider-side error messages into something a user can act on.
 * The bare deserialize errors from DeepSeek / Volcengine etc. read like
 * compiler output ("unknown variant `image_url`") — a one-line hint pointing
 * at the actual cause saves a lot of "wait what?".
 */
function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  // DeepSeek V4 chat completions doesn't accept image_url content — it
  // errors with this exact deserialize message. Surface a fix instead.
  if (raw.includes("unknown variant `image_url`")) {
    return (
      'DeepSeek 当前不支持发图。要用截屏请换成 GLM / Gemini / Qwen / Doubao —— ' +
      'Settings → AI 顶部 chip 切换。（原始错误：' +
      raw.slice(0, 120) +
      '…）'
    )
  }
  return raw
}
