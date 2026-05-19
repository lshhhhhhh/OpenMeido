# OpenMeido

> 桌面 AI 陪伴 · Desktop AI companion

![screenshot](demo/1.png)

---

## 中文

桌面上一个透明置顶的 Live2D 形象，会和你聊天、记住你说过的事、读你的邮箱、定提醒、看你截的屏、在你长时间不动的时候主动来一句。

### 下载

到 [Releases](https://github.com/lshhhhhhh/OpenMeido/releases) 拿最新的 `OpenMeido-Setup-X.X.X.exe`，双击安装。Windows SmartScreen 会因为没签名提示一次，点「更多信息 → 仍要运行」过掉。

### 首次启动

会弹出一个引导窗口，让你挑一个 AI 接口、注册、把 key 粘进来。**默认推荐智谱 GLM**——免费多模态档（`glm-4.6v-flash`）、国内可访问、注册一键直达。当然你也可以挑别的：

| Backend | 特点 |
|---|---|
| **智谱 GLM** | 免费多模态、国内可访问 ★ 推荐 |
| Gemini | Google · 有免费额度 |
| DeepSeek | V4 价格屠夫（不支持图片） |
| 通义千问 Qwen | 阿里 · 新用户送 token |
| 豆包 Doubao | 字节 · 需国内手机号 |
| OpenAI | 付费 · gpt-5.4 / 5.5 |
| LM Studio | 本地跑、无需 key |

### 功能

- **多模态聊天** — 普通文字 + 截屏图片输入。除 DeepSeek 外所有 backend 都支持图
- **分层记忆** — 工作窗口 (L1) + 向量召回的情景记忆 (L2) + LLM 蒸馏的稳定事实 (L3)，跨会话续连
- **Live2D 形象** — 自带两个免费模型（Hiyori / Haru），可导入更多 zip。情绪绑表情可手动调，也可点 **✨ AI 绑定表情** 让大模型自动猜
- **语音合成** — 默认 Microsoft Edge TTS（免费、联网、声线 Xiaoyi），可切到本地 GPT-SoVITS 做零样本声音克隆。每条回复带 🔊 按钮 + 嘴型同步
- **主动模式** — 你长时间没动 / 距上次回复太久时，LLM 会评估"现在该不该说一句"，决定主动来一句关心
- **邮箱集成** — IMAP 只读，能问"有新邮件吗"、"读一下第三封"等
- **提醒** — 「提醒我五分钟后喝水」一句话设定，SQLite 持久化，重启不丢，到点系统通知
- **透明窗口 + 点穿** — 形象边缘的透明像素可以点到桌面，形象本体 + 聊天框正常响应
- **Demo 模式** — 录屏 / 演示时按一个热键播一条预设台词 + 表情 + TTS。台词存在 `demos.json`，记事本改了立刻生效

### 配置在哪

所有用户数据放在 `%APPDATA%/openmeido/`：

| 文件 | 内容 |
|---|---|
| `config.json` | Backend / 人设 / 窗口尺寸 / 邮箱 / 记忆 / 语音 / 主动模式 |
| `live2d-models/<name>/openmeido.json` | 每个 Live2D 模型的情绪绑定 + 嘴型参数 |
| `demos.json` | Demo 模式的热键 + 台词 |
| `memory.sqlite` | 对话历史 + 事实库 |
| `hf-cache/` | 本地 embedding 模型（首次聊天时下载 95MB） |

设置界面里全都能改，手编 JSON 主要是想跨机器同步或版本控制时用。

### 自己导入 Live2D 模型

去 [Live2D 官方 sample 页](https://www.live2d.com/zh-CHS/learn/sample/) 挑一个下载 zip，**设置 → Live2D → 导入 zip**，选中。模型解压到用户目录后会自动出现在下拉菜单里。情绪绑定可以手动编辑或点 ✨ AI 自动绑定。

### 自带模型版权说明

- **Hiyori Pro / Haru Greeter Pro** —— Live2D Inc. 出品，授权基于 [Live2D Free Material License Agreement](https://www.live2d.com/eula/live2d-free-material-license-agreement_zh-CN.html)。商业使用前请阅读条款
- **Live2D Cubism Core** —— [Cubism SDK Release License](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_zh.html)
- **Cubism Components**（JS runtime）—— MIT

---

## English

A transparent always-on-top Live2D character that sits on your desktop. She chats with you, remembers what you tell her, reads your email, sets reminders, looks at your screenshots, and quietly speaks up when you've gone too long without a break.

### Install

Grab the latest `OpenMeido-Setup-X.X.X.exe` from [Releases](https://github.com/lshhhhhhh/OpenMeido/releases) and double-click. Build is unsigned — Windows SmartScreen will warn once; click "More info → Run anyway".

### First run

A setup window asks you to pick an AI backend, register, and paste an API key. **Default recommendation is Zhipu GLM** — it has a free multimodal tier (`glm-4.6v-flash`), is accessible from mainland China, and registration is a one-click hop. Other options:

| Backend | Notes |
|---|---|
| **Zhipu GLM** | Free multimodal · China-accessible ★ recommended |
| Gemini | Google · free quota |
| DeepSeek | V4 cheapest of the bunch (text-only) |
| Qwen | Alibaba · new-user token bonus |
| Doubao | ByteDance · mainland-China phone required |
| OpenAI | Paid · gpt-5.4 / 5.5 |
| LM Studio | Local · no key needed |

### Features

- **Multimodal chat** — text + screenshot input. Every backend listed except DeepSeek accepts images
- **Layered memory** — working window (L1) + vector-recalled episodic store (L2) + LLM-distilled stable facts (L3); sessions resume on restart
- **Live2D character** — two free-license models bundled (Hiyori / Haru); import more via zip. Emotion-to-expression mapping is editable, or hit **✨ AI auto-bind** to let the model guess for you
- **Text-to-speech** — Microsoft Edge TTS by default (free, online, Xiaoyi voice), or switch to local GPT-SoVITS for zero-shot voice cloning. Per-message 🔊 button + RMS-driven mouth-sync
- **Proactive mode** — when you've been idle or quiet for a while, the LLM decides whether it's a good moment to speak up and, if so, says one thing
- **Email** — IMAP read-only; ask "any new email?", "read the third one"
- **Reminders** — "remind me to drink water in 5 minutes" sets an OS notification; persists across restarts
- **Transparent window + click-through** — empty pixels around the character pass clicks to your desktop; the character body + chat panel intercept normally
- **Demo mode** — for recordings / live demos: press a hotkey to fire a canned line + expression + TTS. Lines live in `demos.json`, edits take effect on the next press

### Where things live

All user data lives under `%APPDATA%/openmeido/`:

| File | What |
|---|---|
| `config.json` | Backends, persona, window size, mail, memory, voice, proactive |
| `live2d-models/<name>/openmeido.json` | Per-model emotion mapping + lip-sync param |
| `demos.json` | Demo hotkeys + lines |
| `memory.sqlite` | Episodic memory + facts |
| `hf-cache/` | Local embedding model (downloaded on first chat, ~95 MB) |

The Settings GUI covers everything; hand-edit JSON only when you want to share / version-control your config.

### Adding your own Live2D model

Download a sample zip from the [Live2D sample page](https://www.live2d.com/en/learn/sample/), then **Settings → Live2D → Import zip**, pick the file. The model unpacks into your user directory and shows up in the dropdown. Edit the emotion mapping manually or hit ✨ AI auto-bind.

### Bundled-model licensing

- **Hiyori Pro / Haru Greeter Pro** — © Live2D Inc., distributed under the [Live2D Free Material License Agreement](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html). Read the terms before commercial use
- **Live2D Cubism Core** — [Cubism SDK Release License](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html)
- **Cubism Components** (the JS runtime) — MIT

### Build from source

```sh
npm install
npm run dev       # dev mode with HMR
npm run dist      # Windows installer to dist/
```

Full build guide in [BUILD.md](./BUILD.md).

### License

App code: TBD (leaning Apache-2.0). 3rd-party licensing covered above.
