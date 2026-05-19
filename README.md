# OpenMeido

> Desktop AI companion · 桌面 AI 陪伴

A transparent always-on-top Live2D character that sits on your desktop, chats with you, remembers what you tell her, reads your email, sets reminders, and quietly comments when you go too long without a break.

桌面上一个透明置顶的 Live2D 形象，会和你聊天、记住你说过的事、读你邮箱、定提醒、在你长时间不动的时候主动来一句。

![screenshot](demo/1.png)

---

## Features · 功能

- **多 backend 切换 · Multi-backend** — OpenAI · Gemini · 智谱 GLM · DeepSeek · 通义千问 · 豆包 · LM Studio. One-click signup links. .env fallback for dev. 一键切换、注册链接直达、dev 模式 .env 兜底
- **首次设置向导 · First-run wizard** — Pick a provider, register, paste key, done. 默认推荐免费的 GLM
- **分层记忆 · Layered memory** — Working window (L1) + episodic with vector recall (L2) + LLM-distilled facts with contradiction chains (L3). SQLite + sqlite-vec + local bge-small-zh embedding (95MB ONNX, no API key)
- **会话续连 · Session persistence** — Restarts resume your last conversation; explicit "新建会话" when you want a fresh one
- **Live2D 模型管理 · Model manager** — Drop in any Cubism 4 model zip. Settings GUI picks model, edits emotion-to-expression mapping, has an **AI auto-bind** button that uses the LLM to guess the mapping for you
- **多模态视觉 · Vision** — Screenshot any monitor, send to the model (works on every multimodal backend listed above)
- **语音合成 · TTS** — Microsoft Edge TTS (free, online) OR local GPT-SoVITS (voice cloning). Per-message ▶ button + auto-play option. RMS-driven mouth-sync
- **主动模式 · Proactive observer** — Timer + idle triggers. LLM gets a `should_speak` veto so it isn't noisy. Cooldown + min-silence-since-user prevents interruption
- **窗口透明 · Transparent window** — Click-through over empty pixels; opaque over the character and chat panel. Always-on-top, frameless, draggable. Hardware-accelerated WebGL
- **Demo 模式** — Press a per-demo hotkey to fire a canned line + expression + TTS. Lines + hotkeys live in `demos.json` — edit and save, next press picks it up
- **邮箱集成 · Mail** — IMAP read-only. Tools to list / read recent emails. Password encrypted via OS keychain (safeStorage)
- **定时提醒 · Reminders** — SQLite-persisted, survives restart, fires OS notification

---

## Quick start · 快速开始

### Install · 安装

```sh
npm install
npm run dev
```

Or grab the prebuilt installer from `dist/OpenMeido-Setup-<version>.exe` (Windows, ~230MB).
或者下载预编译的 Windows 安装包。

### First run · 首次启动

A modal asks you to pick a backend and paste an API key. The recommended option is **智谱 GLM** — it has a free multimodal tier (`glm-4.6v-flash`), is accessible from China, and the registration page is one click away.

弹出向导让你挑 backend + 粘 key。默认推荐 **智谱 GLM**——免费多模态档（`glm-4.6v-flash`）、国内可访问、注册页一键直达。

You can always change this later in Settings (⚙) → AI.

### Build a Windows installer · 构建安装包

```sh
npm run dist
```

Output: `dist/OpenMeido-Setup-<version>.exe`. Full distribution guide in [BUILD.md](./BUILD.md).

---

## Configuration · 配置

All settings live in `%APPDATA%/openmeido/` (Windows) / `~/.config/openmeido/` (Linux):

| File | What |
|---|---|
| `config.json` | Backends, persona, window size, mail, memory, voice, proactive |
| `live2d-models/<name>/openmeido.json` | Per-model sidecar — emotion → expression mapping, lip-sync param |
| `demos.json` | Demo mode hotkeys + canned lines |
| `memory.sqlite` | Episodic memory + facts |
| `hf-cache/` | Local embedding model ONNX files (downloaded on first chat) |

The Settings GUI covers everything; edit JSON only when you want to share / version-control your config.
图形界面里都能改，手编 JSON 主要是想做版本控制 / 跨机器同步时用。

---

## Demo mode · Demo 模式

Bypasses the LLM. Each demo entry binds a hotkey to a canned line + Live2D expression + TTS playback. Useful for screen-recording the app, quickly showing it to someone, or scripted skits.

绕过 LLM。每条 demo 绑一个热键，按下就播台词 + Live2D 表情 + TTS——录屏、演示、或者搞剧本式互动用。

```json
[
  {
    "hotkey": "1",
    "text": "主人你又在看 CS2 比赛啊，他们什么时候能拿 major 冠军啊。",
    "expression": "星星眼"
  },
  { "hotkey": "Ctrl+Shift+R", "text": "...", "expression": "生气" }
]
```

Open the file from Settings → 窗口 → 「📝 打开 demos.json」. Saves take effect on the next keypress — no restart.

---

## Memory architecture · 记忆架构

Mirrors imouto-oss (the Python original):

- **L1 working window** — last N messages, always in context (default 10)
- **L2 episodic** — every turn embedded with local bge-small-zh, top-K recalled by cosine similarity + recency + importance
- **L3 facts** — every 5 turns, LLM extracts stable facts (`{key, value, confidence}`) into a separate table. Contradictions form a `superseded_by` chain so history is never lost. Facts inject into the system prompt as `[关于用户的已知事实]`.

You can browse / clear sessions and inspect facts under Settings → 记忆.

---

## Live2D licensing · Live2D 模型许可

The bundled `haitu_vts` model in private builds is a **paid asset (personal-use license)**. It's gitignored and **not redistributable**.

For public builds:
1. Delete `src/renderer/public/live2d-models/haitu_vts/` before `npm run dist`
2. Replace with a freely-licensed model (e.g. [Live2D Cubism Free Material](https://www.live2d.com/en/learn/sample/) samples — Mark / Haru)
3. Auto-binding in Settings → Live2D → ✨ AI 绑定表情 handles the emotion-to-expression mapping for the new model

公开发布前**务必删掉 `haitu_vts/`**，换成有公开授权的模型。

---

## Stack

- Electron 33 + electron-vite + React 19 + TypeScript
- Vercel AI SDK v6 (provider-agnostic chat / streaming / tool calls)
- PIXI.js v7 + pixi-live2d-display-lipsyncpatch (Cubism 4)
- better-sqlite3 + sqlite-vec
- @huggingface/transformers (local embedding)
- msedge-tts + adm-zip + Web Audio API

---

## License

TBD (leaning Apache-2.0).

3rd party: Live2D Cubism Core is bundled under Live2D Inc.'s [Cubism SDK Release License](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html). Cubism Components (the JS runtime) is MIT.
