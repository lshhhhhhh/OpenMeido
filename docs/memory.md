# OpenMeido 记忆系统设计

最后更新：v0.0.30 (2026-05-21)

OpenMeido 的"记忆"不是一件东西，而是 **四个独立但配合的子系统**。这份文档梳理它们各自的职责、数据形态、触发时机，以及关键的"工作 / 关系"二分。

## 1. 为什么有这么多层

| 子系统 | 中文叫法 | 主要回答的问题 | 时间尺度 |
|---|---|---|---|
| **Episodes** | 短期记忆 | "刚才聊了什么？" | 秒到天 |
| **Facts (personal)** | 日常记忆 | "她记得我是谁吗？" | 月到年 |
| **Facts (work)** | 工作上下文 | "她还记得我在跟进哪个项目吗？" | 天到周 |
| **Affinity** | 好感度 | "我们的关系到什么程度了？" | 持续累积 |

这四层走的物理表不同、抽取通道不同、触发条件不同，**但都通过 `MemoryService` 统一暴露给 chat 层**。

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
                       ├─ personal facts → [关于用户的已知事实]
                       └─ work facts     → [最近工作上下文]
                                 │
                                 ▼
                         system prompt
                                 │
                         streamText() ──▶ LLM
                                 │
                          ┌──────┴──────┐
                          ▼             ▼
                      assistant     tool_calls
                      message       (work turn?)
                                 │
                                 ▼
                       persist episodes (user / assistant / tool)
                                 │
                          ┌──────┴──────┐
                          ▼             ▼
              maybeTriggerReflection(wasToolTurn)
                          │             │
                  personal track    work track
                  (every 5 turns)   (every 3 work turns)
                          │             │
                          ▼             ▼
                  facts.upsert      facts.upsert
                  category=personal category=work
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

**Naive mode**：嵌入模型还没下载时，embedding 全部存空 `Float32Array`，KNN 部分跳过，只用 SQL `recent()`。L1 + L3 仍工作，L2 退化。

## 4. Facts（事实，分两条线）

`facts` 表，单表 schema，靠 `category` 列分轨：

| 列 | 含义 |
|---|---|
| `id` | PK |
| `persona_id` | 写入时 active 的人物（审计用）|
| `category` | `'personal'` 或 `'work'` |
| `scope` | `'shared'`（跨 persona 可见，v0.0.30 起新事实默认）或 `'persona'`（人物专属）|
| `key` | 点分层级英文，如 `user.profile.name`、`project.A1.status` |
| `value` | 简短中文短语 (≤30 字) |
| `confidence` | 0-1，新写入时 0.7-1.0 |
| `expires_at` | ISO timestamp 或 NULL。work facts 写入时 +14 天；同 key+value 命中时顺延；personal facts 永远 NULL |
| `superseded_by` | 同 key + category 出现新值时指向新行，旧行自动失效 |
| `source_episode_ids` | JSON，可审计这条事实是从哪几个 episode 抽出来的 |

**Personal facts（日常记忆）**：
- 命名空间常用：`user.profile.*` / `user.pets.*` / `user.hobbies.*` / `user.work.role`
- 抽取源：**纯对话**的 episode（过滤掉 `speaker === 'tool'` 和带 `toolParts` 的 assistant 行）
- 触发：每 5 个**非工具**回合一次
- 展示：Settings → 人物 → 记忆 (有 🗑 单条删除)
- 注入：`[关于用户的已知事实]` 段进 system prompt

**Work facts（工作上下文）**：
- 命名空间：`project.<id>.*` / `email.from.<sender>.*` / `task.<id>.*`
- 抽取源：**有工具调用的** episode（tool 行 + 带 toolParts 的 assistant 行 + 触发它们的 user 行）
- 触发：每 3 个**工具**回合一次
- 展示：**不**在 UI 上展示（因为容易过时，怕用户误以为是稳定事实）
- 注入：`[最近工作上下文]` 段进 system prompt

**为什么分两轨**：
- 抽取 prompt 完全不同（个人事实重稳定性，工作上下文重时效性）
- 工作回合的 reflection 不污染日常事实（否则 `project.SH-R202` 会变成"用户特征"）
- UI 隔离避免用户面对一堆过时 ticket 编号

**双轨实现细节**（`service.reflectOnce` + `reflectProductivityOnce`）：
- 拉 3× window 量的原始 episode
- 各自的 filter（personal: 剔除工具行；work: 保留工具行 + 用户行）
- 各自的 prompt 头（`PERSONAL_PROMPT_HEADER` vs `WORK_PROMPT_HEADER`）
- 共享 `parseReflectionResponse` 解析器（容忍 fenced / prose 包装）
- Upsert 时传不同 `category`，supersession 也按 category 隔离

## 5. Affinity（好感度）

物理上和 facts 同库不同表（`persona_affinity`），但**概念上独立** —— 这里只列接口：

- `getAffinity(personaId)` → `{ score, lastUpdated, lastReason, lastMilestone, lastReviewAt }`
- `setAffinity(score, reason)` —— 后处理过 guardrail 的最终分
- `getPresenceState` / `setPresenceState` —— 持久化"今日通过陪伴累积了多少分"
- 工作回合**不**进 affinity 判官（`skipAffinity: wasToolTurn`）

引擎在 `src/shared/affinity.ts`（边际递减曲线、rolling median、daily cap）+ `src/main/affinity-host.ts`（wiring）。

## 6. 工作 / 关系的边界

整个设计的最关键的一条线。判定信号：**这一轮调用了任何工具吗？**

```typescript
const wasToolTurn = captures.some((c) => c.calls.length > 0)
```

由此分支的事：

| 系统 | 工作回合行为 |
|---|---|
| Affinity classifier | **跳过**（`skipAffinity: true`）|
| Personal reflection | **不计入**（episode 被过滤）|
| Work reflection | 累加这一轮的 episode |
| Episode persistence | 照常存（聊天历史可回看）|
| Embedding 向量 | 照常做（语义检索仍能找到）|
| 表情 classifier | 照常跑（脸还是要表达）|
| UI 标记 | 气泡上加 💼 |

边角：「今天好累，帮我看下邮件」这种**混合 turn** 会被判为工作，情感信号丢失。当前的接受度判断是 OK 的——纯感情时刻用户一般不夹任务。

## 7. Retrieval（chat 上下文组装）

chat.ts 在每轮 streamText 之前做：

```typescript
// 1. 拉历史 episodes
const { recent, recalled } = await memory.retrieve(userText)
const historyMessages = episodesToMessages([...recalled, ...recent], imageRecallTurns)

// 2. 拉双轨 facts，拼成一个 prompt 段
const factsBlock = await memory.factsBlock()
// → "[关于用户的已知事实]\n- user.profile.name: 小李\n- user.pets.cat.name: 阿黄\n\n
//    [最近工作上下文]\n- project.A1.status: 等待验收"

// 3. 拉 affinity → 决定 tier prompt block (生疏/熟络/亲近/默契)
const affinity = await memory.getAffinity()
const tierBlock = buildTierPromptBlock(affinity.score, persona.name, persona.traits)

// 4. 拼成 system prompt 喂模型
system: `${persona.systemPrompt}\n\n${tierBlock}\n\n${factsBlock}\n[环境]\n${...}`
```

`episodesToMessages` 还过滤掉 `[obs]` 前缀（silent 屏幕观察）和重放图片（窗口由 `imageRecallTurns` 限制）。

## 8. Reflection 调度

**计数器持久化到 sqlite**（v0.0.30 起，`persona_affinity` 表加了
`personal_turns_since_reflection` / `work_turns_since_reflection` 两列）。

chat.ts 不再持有计数器，调 `service.bumpReflectionCounter(wasToolTurn)`：
- 返回 `'personal'` / `'work'` / `null`
- 触发到阈值就**自动归零** + 返回相应字符串
- 调用方根据返回值 fire-and-forget 对应的 `reflectXxxOnce()`

```typescript
async function maybeTriggerReflection(memory, wasToolTurn) {
  const triggered = await memory.bumpReflectionCounter(wasToolTurn)
  if (triggered === 'personal') void memory.reflectOnce()
  else if (triggered === 'work') void memory.reflectProductivityOnce()
}
```

**为什么持久化**：模块级变量在进程重启时归零。短会话用户（开 app → 问一句 → 关掉）
每次都从 0 数 → 永远碰不到 5 次门槛 → reflection 从不触发 →
`listFacts` 永远空。这是用户在 v0.0.29 之前实际遇到的 bug。

两个计数器（personal / work）互不串扰。一个真正的工作回合**只**喂 work counter，不影响 personal cadence。

**Reflection prompt 看已知事实**（v0.0.30 起）：`reflectOnce` / `reflectProductivityOnce`
在调用 LLM 前先 `listActiveFacts(category)`，把现有事实拼成
`[已知事实 — 不要重复抽取这些，只输出新增或矛盾的]` 块塞进 prompt。
没有这一步时，模型每次都从零思考"用户是谁"，结果产生
`user.name` / `user.profile.name` / `user.real_name` 一堆近义重复，
supersession 救不了（必须完全同 key 才触发）。

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

- **混合 turn（既聊天又调工具）**被当工作回合处理，情感信号丢失。可接受。
- **Reflection 是 fire-and-forget**，失败只 console.warn，下次再试。无 retry 队列。
- **Affinity classifier 在 chat 路径之外的触发**（greeting / proactive）也跑，但 `userText=''` → 不会 apply affinity。
- **wasToolTurn 判定过粗**：任何工具调用都算工作。`addTask("提醒喝水")` 是生活管理但被标 work 跳过 affinity。未来可按 tool name 分 `{email, file, web} = work` vs `{addTask, listTasks} = neutral`。
- **factsBlock 永远全量注入**：未来如果 facts 增多到 50+ 条，可改成 query-time embedding 筛选 top-K 相关。
- **嵌入模型锁死 bge-small-zh-512**：换模型要 drop 并重建 vec0 表。

## 13. 如果要扩展

加一条新的"记忆轨道"（比如"健康记忆"track）的步骤：
1. `FactCategory` 加新值
2. `reflection.ts` 加一个 `XXX_PROMPT_HEADER` 和 `buildReflectionPrompt` 的 kind 分支
3. `service.ts` 加 `reflectXxxOnce()`
4. `chat.ts` 加触发条件（不一定是 wasToolTurn —— 可能是关键词、可能是显式标记）
5. `factsBlock` 拼新的段（如 `[健康相关]`）
6. UI：决定是否展示（personal 在 UI 里，work 不在）

每一步都是表面变化，不会改 schema 也不会动 retrieval 的核心。这是为什么 reflection 在设计上是 prompt-driven 而非 hardcoded 抽取规则。
