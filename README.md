# OpenMeido

> 桌面 AI 陪伴 · Desktop AI companion

![screenshot](screenshot/1.png)

她不是另一个 ChatGPT 套皮——她有**关系演进**、**自己的内心世界**、还能**帮你处理日常事务**。三个核心特色：

### 🎮 好感度系统 — 关系真的会演进

跟她聊得越久，她的说话方式真的变。不是改个称呼那么简单：

- **Lv.1 生疏期** — 礼貌的 1-2 句应答，不主动找话题，不分享自己看法
- **Lv.3 熟络期** — 会反问你近况、关心你状态、敢有自己观点
- **Lv.5 默契期** — 敢顶嘴、敢撒娇、敢翻旧账、敢有不同意见

聊天面板右上角 chip 显示当前好感度 + 进度条到下一档。每次 LLM 判定后浮 `+1` / `-1` 数字（像 MMO 伤害数）。跨人设独立计数——女仆好感度跟妹妹的不互通。

### 🎭 不同人设 + 内心世界

四种人设——**女仆 / 妹妹 / 管家 / 大小姐**——每个有自己的称呼 + 性格 + tier 演进曲线。但真正有意思的是：**她有自己的过去**。

每个 persona 自带一份关系背景（lore pack）注入她的内心：

- **女仆**：才到岗的新人。"主人是我接的第一份工"、"私下对着镜子练'主人，您回来了'"、"移动过主人房间任何东西后会偷偷记下原位再放回去"
- **妹妹**：从小一起长大的兄妹。"我书桌抽屉有本本子记了哥哥说过的话"、"妈妈做红烧肉我会先挑肥的塞给哥哥"、"我对哥哥说过最难听的话其实不是真心的"

聊到相关话题这些细节会**通过 RAG 自动浮上来**。她说出来的内容是有根的，不是模型现编的——这是和"ChatGPT 装女仆装"最大的区别。也可以**自定义 persona**：在 Settings 里写你自己的人设 prompt。

### 🛠 生产力工具 — 不止聊天

| 工具 | 做什么 |
|---|---|
| **📧 邮箱** | IMAP 接入 Gmail / 网易 / Outlook 等。她会自动把促销/订阅/通知**折叠成一行计数**，只逐封展开真人邮件 |
| **📄 总结文档** | 拖任意 PDF / Word / 文本，要点 + 追问问题一键产出 |
| **📋 任务清单** | 自然语言加待办 + 提醒，她会按时机主动提醒你 |
| **🌐 联网搜索** | Gemini / GLM / Kimi 都支持。问"今天比特币多少钱"她会先搜再答 |
| **👀 看屏幕** | 一键截图给她，可以解释 / 翻译 / 锐评 |
| **📊 表格窗口** | "总结最近 10 封邮件" → 自动开独立表格窗口，多 tab 对比 |
| **🔔 一键闭嘴** | 工作中按一下她安静，再按回来打招呼。专注模式不破坏陪伴感 |

---

### 下载安装

到 [Releases](https://github.com/lshhhhhhh/OpenMeido/releases) 拿最新的 `OpenMeido-Setup-X.X.X.exe`，双击安装。无签名，Windows SmartScreen 弹一次「更多信息 → 仍要运行」过掉。

**国内用户**：装好后第一次升级慢的话，去 Settings → 关于 → 下载源切到 **ghproxy** 镜像，速度从几十 KB/s 提到 1-5 MB/s。

### 首次启动

会弹引导窗，挑一个 AI 接口注册 + 粘 key。**默认推荐智谱 GLM**——免费多模态、国内可访问、一键注册。

| Backend | 特点 |
|---|---|
| **智谱 GLM** | 免费多模态 · 国内 · 内置搜索 ★ 推荐 |
| **Kimi** | Moonshot · 内置搜索 · 国内 / 国际两个端点 |
| Gemini | Google · 有免费额度 · grounding 搜索 |
| DeepSeek | V4 价格屠夫（不支持图） |
| 通义千问 Qwen | 阿里 · 新用户送 token |
| 豆包 Doubao | 字节 · 国内手机号 |
| OpenAI | 付费 |
| LM Studio | 本地跑 · 无需 key |

### 自带 Live2D 模型 + 导入新模型

默认带 **Hiyori**（蓝头发萝莉，女性 persona 用）和 **Natori**（成熟男性，管家 persona 用）。这两个是 Live2D 官方免费样本。

想要更多？去 [Live2D 官方 sample 库](https://www.live2d.com/zh-CHS/learn/sample/) 下载任意 zip → **Settings → Live2D → 导入 zip**。导入完点 **✨ AI 绑定** 让大模型自动猜表情/情绪映射，也可以手编。

### 其他特色

- **4 种 TTS**：Edge TTS（默认免费）/ GPT-SoVITS（本地零样本声音克隆）/ MiniMax 海螺 / 火山引擎豆包
- **3 种内置字体**：小赖（日系手书）/ LXGW 文楷 / 得意黑
- **跨会话记忆**：她记得你的名字、工作、兴趣，自然带进后续对话
- **透明窗口 + 点穿**：形象边缘点击穿透到桌面，形象本体 + 聊天框正常响应
- **自动更新**：electron-updater + GitHub Releases，国内可用 ghproxy 镜像
- **本地数据 / 离线优先**：长期记忆 embed 在本地跑（bge-small-zh-v1.5），不上云

---

### 数据存哪儿

所有用户数据在 `%APPDATA%/openmeido/`。Settings GUI 覆盖了 99% 的配置项，手编 JSON 主要用于跨机器同步或版本控制：

| 文件 | 内容 |
|---|---|
| `config.json` | Backend / 人设 / 邮箱 / 语音 / 主动模式等 |
| `memory.sqlite` | 对话记忆 + 好感度 + 提炼的事实 + lore 碎片 |
| `live2d-models/<name>/openmeido.json` | 每个 Live2D 模型的情绪/表情绑定 |
| `lines.json` | 闭嘴按钮反馈台词（不暴露在 UI，高级用户可手编）|
| `hf-cache/` | 长期记忆 embed 模型（首次启用时下载 ~95MB）|

### 自带内容版权说明

- **Hiyori Pro / Natori Pro** — Live2D Inc. 出品，[Live2D Free Material License Agreement](https://www.live2d.com/eula/live2d-free-material-license-agreement_zh-CN.html)。商业使用前请阅读条款
- **Live2D Cubism Core** — [Cubism SDK Release License](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_zh.html)
- **Cubism Components**（JS runtime）— MIT
- **小赖字体 / LXGW 文楷 / 得意黑** — SIL OFL 1.1（开源商用免费）

### 致谢

- **INVC. 老潘** — 早期产品想法 + 功能需求反馈

---

## English

She isn't another ChatGPT wrapper — she has **relationship progression**, **her own inner life**, and **handles your day-to-day stuff**. Three pillars:

### 🎮 Affinity system — the relationship actually evolves

Chat with her enough and her speaking style actually changes. Not a title swap:

- **Lv.1 stranger** — polite 1-2 sentence answers, no proactive topics, no opinions
- **Lv.3 friendly** — asks back, checks on you, shares her view
- **Lv.5 close** — pushes back, teases, brings up old stuff, holds disagreement

A chip top-right shows the score + progress bar to the next tier. Every LLM judgement floats a `+1` / `-1` over the chip MMO-damage-number style. Each persona has its own affinity track — your maid score isn't your imouto score.

### 🎭 Distinct personas with inner lives

Four personas — **maid / sister / butler / tsundere lady** — each with their own address, tier-driven progression, and personality. The interesting part: **she has her own past**.

Each persona ships with a relationship-background lore pack injected into her inner state:

- **Maid**: a newcomer who just started. "Master is my first employer." "I privately practice greetings in front of the mirror." "If I move anything in master's room I secretly note the original spot and double-check when I put it back."
- **Imouto**: a sister you grew up with. "I have a notebook of things my brother said." "When mom made braised pork I'd pick the fatty pieces for him." "The mean things I've said to my brother weren't really my truth."

When the conversation touches related topics, these details **surface via RAG** — what she says has roots, not on-the-fly model fabrication. That's the biggest difference vs "ChatGPT in a maid outfit". Custom personas supported too (write your own prompt in Settings).

### 🛠 Productivity — not just chatting

| Tool | What |
|---|---|
| **📧 Mail** | IMAP into Gmail / Outlook / etc. She **auto-folds promos / subscriptions / notifications** into a count summary, only enumerates real-person emails |
| **📄 Document summary** | Drop any PDF / Word / text file — bullet points + follow-up questions in one click |
| **📋 Tasks** | Add todos / reminders in natural language, she nudges you at the right time |
| **🌐 Web search** | Gemini / GLM / Kimi all wired. Ask "what's bitcoin at today" she searches first then answers |
| **👀 Screen capture** | One-click send your current screen to the LLM for commentary / translation |
| **📊 Table windows** | "Summarize last 10 emails" → standalone table window, multi-tab for comparison |
| **🔔 One-click mute** | Silences her during focus, click again she greets you back |

---

### Install

Grab the latest `OpenMeido-Setup-X.X.X.exe` from [Releases](https://github.com/lshhhhhhh/OpenMeido/releases) and double-click. Build is unsigned — Windows SmartScreen will warn once; click "More info → Run anyway".

### First run

A setup window asks you to pick an AI backend, register, and paste an API key. **Default recommendation is Zhipu GLM** — free multimodal, China-accessible, one-click registration.

| Backend | Notes |
|---|---|
| **Zhipu GLM** | Free multimodal · China-accessible · built-in search ★ recommended |
| **Kimi** | Moonshot · built-in search · CN / intl endpoints |
| Gemini | Google · free quota · grounding search |
| DeepSeek | V4 cheapest (text-only) |
| Qwen | Alibaba · new-user token bonus |
| Doubao | ByteDance · mainland-China phone required |
| OpenAI | Paid |
| LM Studio | Local · no key needed |

### Bundled Live2D models + importing your own

Ships with **Hiyori** (blue-hair, female personas) and **Natori** (male, butler persona) — both Live2D official free samples.

Want more? Grab any zip from the [Live2D sample library](https://www.live2d.com/en/learn/sample/) → **Settings → Live2D → Import zip**. Hit **✨ AI auto-bind** to let the LLM guess the emotion/expression mapping, or edit manually.

### Other features

- **4 TTS engines**: Edge TTS (default, free) / GPT-SoVITS (local zero-shot voice cloning) / MiniMax Hailuo / Volcengine Doubao
- **3 bundled fonts**: Xiaolai (Japanese-style handwriting) / LXGW WenKai / Smiley Sans
- **Cross-session memory**: She remembers your name, work, interests — brings them up naturally
- **Transparent window + click-through**: empty pixels pass clicks to your desktop; body + chat panel intercept normally
- **Auto-update**: electron-updater + GitHub Releases (CN users can switch to ghproxy mirror in Settings)
- **Offline-first memory**: bge-small-zh-v1.5 embedding model runs locally, no cloud needed

---

### Where things live

All user data under `%APPDATA%/openmeido/`. Settings GUI covers ~all config; hand-edit JSON only for cross-machine sync or version control:

| File | What |
|---|---|
| `config.json` | Backend / persona / mail / voice / proactive |
| `memory.sqlite` | Chat memory + affinity + distilled facts + lore fragments |
| `live2d-models/<name>/openmeido.json` | Per-model emotion/expression mapping |
| `lines.json` | Mute-button feedback lines (not in UI; advanced-user override) |
| `hf-cache/` | Long-term memory embed model (~95MB, downloaded on first enable) |

### Bundled-content licensing

- **Hiyori Pro / Natori Pro** — © Live2D Inc., [Live2D Free Material License Agreement](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html). Read terms before commercial use
- **Live2D Cubism Core** — [Cubism SDK Release License](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html)
- **Cubism Components** (JS runtime) — MIT
- **Xiaolai / LXGW WenKai / Smiley Sans fonts** — SIL OFL 1.1 (open source, commercial use OK)

### Acknowledgements

- **INVC. 老潘 (Lao Pan)** — early product direction + feature requirements feedback

### Build from source

```sh
npm install
npm run dev       # dev mode with HMR
npm run dist      # Windows installer to dist/
```

Full build guide in [BUILD.md](./BUILD.md).

### License

App code: [GPL-3.0](./LICENSE). 3rd-party licensing covered above.
