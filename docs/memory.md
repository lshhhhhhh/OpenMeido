# OpenMeido 记忆系统设计

最后更新：v0.0.30 (2026-05-22)

OpenMeido 的"记忆"不是一件东西，而是 **独立但配合的子系统**。这份文档梳理它们各自的职责、数据形态、触发时机，以及关键的"工作 / 关系"二分。

## 1. 为什么有这么多层

| 子系统 | 中文叫法 | 主要回答的问题 | 时间尺度 |
|---|---|---|---|
| **Episodes** | 短期记忆 | "刚才聊了什么？" | 秒到天 |
| **Facts (personal)** | 日常记忆 | "她记得我是谁吗？" | 月到年 |
| **Facts (work)** | 工作上下文 | *已废弃 (v0.0.30+ Option B)，由并行 Raw Episodic 与 Tool 机制承载* | - |
| **Affinity** | 好感度 | "我们的关系到什么程度了？" | 持续累积 |

这些层走的物理表不同、抽取通道不同、触发条件不同，**都通过 `MemoryService` 统一暴露给 chat 层**。自 v0.0.30 (Option B) 起，为了防止 token 膨胀和过期工作信息对日常感情产生慢速污染，**L3 临时工作事实 (category='work') 已经被全面废弃并剥离**，临时工作上下文完全基于 raw episodes 对话轨道与动态 tool 渲染并行重构。

## 2. 整体数据流

```
                           ┌──────────────┐
    user types message ───▶│  chat.ts     │  runs the agent loop
                           └──────┬───────┘
                                  │
                                  ▼
                        MemoryService.retrieve()
                                  │
                           ┌──────┴──────┐
                           ▼             ▼
                     recent episodes  recalled episodes
                     (SQL by ts)      (vec0 KNN)
                                  │
                                  ▼
                        factsBlock()
                        └─ personal facts → [关于用户的已知事实] *(Only)*
                                  │
                                  ▼
                          system prompt
                                  │
                          streamText() ──▶ LLM
                                  │
                           ┌──────┴──────┐
                           ▼             ▼
                       assistant     tool_calls
                       message       (classifyTurnType)
                                  │
                                  ▼
                        persist episodes (user / assistant / tool)
                                  │
                           ┌──────┴──────┐
                           ▼             ▼
               maybeTriggerReflection(turnType)
                           │
                   personal track
                   (every 5 personal turns)
                           │
                           ▼
                   facts.upsert
                   category=personal
```

## 3. Episodes（短期记忆）

每一次对话都被切成 episode 持久化。

**Schema** (`episodes` 表)：
- `id`, `ts`, `persona_id`
- `speaker`: `'user' | 'assistant' | 'tool'`
- `text`: 显示给用户/模型的文本（filter 后版本）
- `tool_data`: JSON，存 `ToolCallPart[]`（assistant 行）或 `ToolResultPart[]`（tool 行）
- `images_data`: JSON，用户附的截屏/图片
- `session_id`: 跨重启续聊用
- 并行 `episodes_vec`（vec0 虚表）：每条 episode 的 bge-small-zh-v1.5 embedding (512 维)

**关键设计**：
- 三种 speaker 全部入库 —— 不是只存 user/assistant 文本。早期版本不存 `tool` 行，导致一轮拿到的 email id 在下一轮 `readEmail` 时找不到。现在完整 agent loop 都能跨轮重放。
- Vec0 不支持 metadata 列，所以 persona 隔离是靠 JOIN 时过滤 `episodes.persona_id`。

**用于什么**：
- `recent(n)` —— 最近 N 条，直接拼进 system prompt（取自配置 `cfg.memory.recentN`，默认 12）
- `searchByEmbedding(query, k)` —— 用用户当前消息的 embedding 找语义最近的旧 episode（默认 topK=5）
- 是 reflection 的输入源

**Naive mode**：嵌入模型还没下载时，embedding 全部存空 `Float32Array`，KNN部分跳过，只用 SQL `recent()`。L1 + L3 仍工作，L2 退化。

## 4. Facts（日常事实）

`facts` 表，单表 schema，靠 `category` 列分轨（但当前仅持久化 `'personal'` 稳定日常记忆，`'work'` 临时工作事实已被全面废弃）：

| 列 | 含义 |
|---|---|
| `id` | PK |
| `persona_id` | 写入时 active 的人物（审计用）|
| `category` | `'personal'` (日常记忆) |
| `scope` | `'shared'`（跨 persona 可见，v0.0.30 起新事实默认）或 `'persona'`（人物专属）|
| `key` | 点分层级英文，如 `user.profile.name` |
| `value` | 简短中文短语 (≤30 字) |
| `confidence` | 0-1，新写入时 0.7-1.0 |
| `expires_at` | NULL。日常个人事实永久有效，永不自动过期 |
| `superseded_by` | 同 key + category 出现新值时指向新行，旧行自动失效 |
| `source_episode_ids` | JSON，可审计这条事实是从哪几个 episode 抽出来的 |

**Personal facts（日常记忆）**：
- 命名空间常用：`user.profile.*` / `user.pets.*` / `user.hobbies.*` / `user.work.role`
- 抽取源：**纯对话**的 episode（过滤掉 `speaker === 'tool'` 和带 `toolParts` 的 assistant 行）
- 触发：每 5 个**非工具/纯个人**回合一次
- 展示：Settings → 人物 → 记忆 (有 🗑 单条删除)
- 注入：`[关于用户的已知事实]` 段进 system prompt

**Work facts（工作上下文 — 已于 v0.0.30 废弃与移除）**：
> [!WARNING]
> 为了防止过时且频繁变动的临时性工作/工单上下文污染模型的长期记忆，并避免过期的 L3 工作事实造成提示词膨胀，系统已在 **v0.0.30** 全面废弃并移除了工作事实轨道（Option B）。
- **废弃原因**：临时性工作信息（如任务清单、邮件主题、工单状态）具有极高的波动性。用慢速的 LLM Reflection 提取并写入 SQLite 极易导致记忆陈旧滞后，且长期堆积会严重稀释模型的感情人格和注意力。
- **替代方案**：改为通过 L1/L2 Raw Episodic 对话历史（自然携带了前面的邮件与文件读写记录）和动态 Tool Calling 机制在当前回合的工作上下文中进行即时、并行的拼装与回显，不再生成 L3 临时工作事实。
- **废弃组件**：`reflectProductivityOnce()` 已经退化为安全占位返回 `0`；`factsBlock()` 中完全不再注入 `[最近工作上下文]` 提示词块。

## 5. Affinity（好感度）

物理上和 facts 同库不同表（`persona_affinity`），但**概念上独立** —— 这里只列接口：

- `getAffinity(personaId)` → `{ score, lastUpdated, lastReason, lastMilestone, lastReviewAt }`
- `setAffinity(score, reason)` —— 后处理过 guardrail 的最终分
- `getPresenceState` / `setPresenceState` —— 持久化"今日通过陪伴累积了多少分"
- 工作与中性回合**不**进 affinity 判官，避免被刷分（farming）

引擎在 `src/shared/affinity.ts`（边际递减曲线、rolling median、daily cap）+ `src/main/affinity-host.ts`（wiring）。

## 6. 工作 / 关系的边界与分类机制

整个设计的最关键的一条线。为了保证好感度不会因为工作或任务管理回合被 "刷分 (farming)"，同时防止感情线 reflection 被工具行为干扰，OpenMeido 在 **v0.0.30** 中引入了细粒度的 **Turn Classification** 机制。

### 分类器 (classifyTurnType)
系统将每一轮的 Tool 调用划分为三种类型：
- `'personal'`：未调用任何工具，属于纯日常感情互动。
- `'work'`：调用了实际工作性质的工具（如：邮件检索 `readEmail`、文件读取 `readFile`、网页抓取与搜索 `google_search`）。
- `'neutral'`：调用了日常助手/待办类的中性管理工具（如：`addTask`、`listTasks`、`markTaskDone`、`readClipboard`、`presentTable`）。

### 各类型回合行为对比

| 模块行为 | `'personal'` (纯感情) | `'work'` (工作任务) | `'neutral'` (待办助手) |
|---|---|---|---|
| **Affinity 计算** | **正常应用** | **跳过** (避免刷分) | **跳过** (避免刷分) |
| **Personal Counter** | **正常累加**并按需触发 | **跳过** (不累加) | **跳过** (不累加) |
| **UI 💼 标记** | **无标记** | **显示 💼 图标** | **无标记** (隐藏) |
| **Episode 持久化** | 照常存 | 照常存 | 照常存 |
| **Embedding 向量** | 照常做 | 照常做 | 照常做 |
| **表情展现** | 正常变化 | 正常变化 | 正常变化 |

## 7. Retrieval（chat 上下文组装）

chat.ts 在每轮 streamText 之前做：

```typescript
// 1. 拉历史 episodes
const { recent, recalled } = await memory.retrieve(userText)
const historyMessages = episodesToMessages([...recalled, ...recent], imageRecallTurns)

// 2. 拉日常 facts，拼成一个 prompt 段
const factsBlock = await memory.factsBlock()
// → "[关于用户的已知事实]\n- user.profile.name: 小李\n- user.pets.cat.name: 阿黄"

// 3. 拉 affinity → 决定 tier prompt block (生疏/熟络/亲近/默契)
const affinity = await memory.getAffinity()
const tierBlock = buildTierPromptBlock(affinity.score, persona.name, persona.traits)

// 4. 拼成 system prompt 喂模型
system: `${persona.systemPrompt}\n\n${tierBlock}\n\n${factsBlock}\n[环境]\n${...}`
```

`episodesToMessages` 还过滤掉 `[obs]` 前缀（silent 屏幕观察）和重放图片（窗口由 `imageRecallTurns` 限制）。

## 8. Reflection 调度

**计数器持久化到 sqlite**（`persona_affinity` 表加了 `personal_turns_since_reflection` / `work_turns_since_reflection` 两列，以保持兼容性）。

chat.ts 不再持有计数器，调 `service.bumpReflectionCounter(turnType)`：
- 仅当 `turnType === 'personal'` 时，才会累加 `personal_turns_since_reflection` 计数。
- 当 `personal` 计数器累加到阈值 `5` 时，**自动归零**并返回 `'personal'`，由 chat 主循环异步触发 `reflectOnce()`。
- 对于 `'work'` 与 `'neutral'` 等非日常回合，`bumpReflectionCounter` 不进行计数，直接返回 `null`，从而保证了日常个人事实抽取的纯粹与稳定。

```typescript
async function maybeTriggerReflection(memory, turnType) {
  const triggered = await memory.bumpReflectionCounter(turnType)
  if (triggered === 'personal') {
    void memory.reflectOnce()
  }
}
```

**为什么持久化**：模块级变量在进程重启时归零。短会话用户（开 app → 问一句 → 关掉）每次都从 0 数 → 永远碰不到 5 次门槛 → reflection 从不触发 → `listFacts` 永远空。这是用户在 v0.0.29 之前实际遇到的 bug。

**Reflection prompt 看已知事实**（v0.0.30 起）：`reflectOnce` 在调用 LLM 前先 `listActiveFacts('personal')`，把现有事实拼成 `[已知事实 — 不要重复抽取这些，只输出新增或矛盾的]` 块塞进 prompt。没有这一步时，模型每次都从零思考"用户是谁"，结果产生 `user.name` / `user.profile.name` / `user.real_name` 一堆近义重复，supersession 救不了（必须完全同 key 才触发）。

## 9. Persona 隔离（v0.0.30 起 scope 化）

不同人物（女仆 / 妹妹 / 大小姐 / 自定义）共享一个 sqlite 文件。
**Episodes 永远 persona-scoped**——女仆听的话不会出现在大小姐面前。
**Facts 默认 shared**——人是同一个人，养的猫的名字不该因为换 persona 就忘掉。

实施细节：
- `facts.scope` 列：`'shared'` 表示跨 persona 可见、`'persona'` 表示只该 persona 看得到
- 新写入默认 `shared`，除非 key 匹配 `user.nicknames.*` / `user.preferred_address` 之类的人物特异前缀
- 老数据迁移时默认 `persona`，避免老用户突然看到其它 persona 的"私人话"
- `listActiveFacts(personaId)`: `WHERE (persona_id = ? OR scope = 'shared')`
- `deletePersona(id)`: 只删 `scope = 'persona'` 的 facts，**保留** shared（用户的猫还是用户的猫，删 persona 不该让她忘记）
- `deleteFact(id)`: 支持当前 persona 删 shared facts（用户在任何 persona 下点 🗑 都能删）

- Service 层每次操作前从 `getConfig().persona.preset` 现取，**不缓存** —— 用户中途切人物，下一次 memory 调用立刻生效
- Adapter 层每个查询带 `persona_id` 参数，但 facts 查询会 OR `scope = 'shared'`
- vec0 表没有 persona 列，靠 JOIN episodes 时过滤

## 10. Naive mode

嵌入模型 (bge-small-zh-v1.5 ONNX) 在新装机上不存在时：
- `naiveMode = true`，service 看 `isNaiveMode()` 决定是否调 embed
- `addEpisode` 写零向量（不进 vec0）
- `retrieve` 跳过 KNN，只 SQL recent
- L3 facts 完全不受影响
- 后台尝试远端 HuggingFace 拉模型，成功就翻出 naive 模式

## 11. 表层 / 接口分布

```
src/core/memory/
  types.ts          — Episode / Fact / FactCategory / NewFact / SessionSummary
  adapter.ts        — MemoryAdapter interface
  service.ts        — MemoryService: business logic over adapter
  reflection.ts     — buildReflectionPrompt / parseReflectionResponse / reflect

src/main/
  memory-host.ts                     — Electron wiring + naive-mode state
  storage/sqlite-memory-adapter.ts   — better-sqlite3 + sqlite-vec impl
  chat.ts                            — retrieval + reflection trigger + work/personal split
  emotion-classifier.ts              — skipAffinity gate on work turns
```

## 12. 已知限制 / 边角

- **混合 turn（既聊天又调工具）**被当工作或待办回合处理，情感信号丢失。可接受。
- **Reflection 是 fire-and-forget**，失败只 console.warn，下次再试。无 retry 队列。
- **Affinity classifier 在 chat 路径之外的触发**（greeting / proactive）也跑，但 `userText=''` → 不会 apply affinity。
- **wasToolTurn 判定过粗 (已解决)**：在 v0.0.30 (Option B) 中已通过 `classifyTurnType` 精细分类工具集解决，将待办、剪贴板等工具标为 `neutral` 并隐藏了 💼 书包图标，只有真正的 `work` 工具才被标记。
- **factsBlock 永远全量注入**：未来如果 facts 增多到 50+ 条，可改成 query-time embedding 筛选 top-K 相关。
- **嵌入模型锁死 bge-small-zh-512**：换模型要 drop 并重建 vec0 表。

## 13. 如果要扩展

加一条新的"记忆轨道"（比如"健康记忆"track）的步骤：
1. `FactCategory` 加新值
2. `reflection.ts` 加一个 `XXX_PROMPT_HEADER` 和 `buildReflectionPrompt` 的 kind 分支
3. `service.ts` 加 `reflectXxxOnce()`
4. `chat.ts` 加触发条件（检测到特定工具或特定词触发）
5. `factsBlock` 拼新的段（如 `[健康相关]`）
6. UI：决定是否展示（personal 在 UI 里，其他可以不展示）

每一步都是表面变化，不会改 schema 也不会动 retrieval 的核心。这是为什么 reflection 在设计上是 prompt-driven 而非 hardcoded 抽取规则。
