# OpenMeido — Design Document

**Status:** Draft (2026-05-17)
**Purpose:** Capture the architecture, tech stack, and rationale committed so far. North-star reference during implementation. Subsystem-level designs (memory schema, agent loop internals, voice latency budget) are deferred to per-subsystem docs once we hit those.

---

## Vision

OpenMeido is a desktop AI companion for **non-programmers**: a transparent always-on-top Live2D avatar she can chat with, ask to handle small productivity tasks (read email, set reminders, look at a screenshot and answer questions), and that speaks back with a cloned voice. The default persona is the anime "maid" aesthetic — the audience is 二次元-aware users who want a friendly cute helper, not a Cursor-style power tool.

**Non-goals:**
1. Competing with IDE-grade coding agents — pros already have those.
2. Requiring users to install developer tooling — no Python, no CLI, no `npm install` for the end user. One installer, double-click, paste API key, done.

---

## Architecture sketch

```
┌─────────────────────────────────────────────────────────────────┐
│  Electron Main Process (Node, TypeScript)                       │
│  ────────────────────────────────────────                       │
│  - App lifecycle, windows, OS integration                       │
│  - Agent loop (Vercel AI SDK)                                   │
│  - Tool implementations (reminder, email, calendar, ...)        │
│  - Persistence (better-sqlite3 + sqlite-vec)                    │
│  - All outbound HTTP (LLM, TTS, MCP servers)                    │
│         │                                                       │
│         │  IPC (typed messages via contextBridge)               │
│         ▼                                                       │
│  ┌────────────────────────────────────────────────────┐         │
│  │  Renderer Process (Chromium, TS + React)           │         │
│  │  - Frameless transparent always-on-top window      │         │
│  │  - Live2D Cubism JS on <canvas>                    │         │
│  │  - Chat UI (Vercel AI SDK's useChat hook)          │         │
│  │  - Settings dialog                                 │         │
│  │  - Web Audio API + AudioWorklet (streaming PCM)    │         │
│  └────────────────────────────────────────────────────┘         │
└─────────────────────────────────────────────────────────────────┘
        │                                  │
        │ HTTP (OpenAI-compatible)         │ HTTP (api_v2.py /tts)
        ▼                                  ▼
  ┌──────────────┐                  ┌──────────────────┐
  │  LLM backend │                  │  GPT-SoVITS svr  │
  │  Zhipu /     │                  │  (separate       │
  │  OpenAI /    │                  │   Python proc;   │
  │  Gemini /    │                  │   user installs  │
  │  local       │                  │   themselves)    │
  └──────────────┘                  └──────────────────┘
```

**Boundaries (non-negotiable):**
- **Renderer never talks to external HTTP directly.** All network calls go through main process. Renderer just streams strings / audio chunks back via IPC. This keeps API keys out of the renderer and gives us one place to add rate limiting / observability.
- **No Python in OpenMeido itself.** GPT-SoVITS is the only Python dependency, and it's a user-installed external process the app speaks HTTP to.
- **Renderer is stateless.** All persistence in main; reload the renderer without losing anything.
- **`src/core/` is platform-agnostic.** It imports no `electron`, no `node:*`, no native modules — only fetch + web-standard primitives. Anything platform-specific (sqlite, electron-store, app paths, Notification API) lives behind an interface in `src/core/` and is implemented in `src/main/storage/` (or future `src/web/`, `src/capacitor/`). Business code depends on the interface, not the implementation.

---

## Platform compatibility

Desktop is the v1 product (electron-builder → Windows / macOS / Linux). But mobile (PWA on Android/iOS, or Capacitor) is on the long-term roadmap, so we **design with cross-platform in mind from day one**, even though we don't ship mobile now.

### Layering

```
src/
  core/              ← pure TS, no platform imports. Reusable everywhere.
    memory/          ← types, embed, MemoryAdapter interface, MemoryService
    (chat pipeline, persona, reflection move here over time)
  shared/            ← cross-process types (Config, ChatEvent wire shapes)
  main/              ← Electron host: BrowserWindow, IPC, native-module impls
    storage/         ← sqlite-memory-adapter.ts (better-sqlite3 + sqlite-vec)
  preload/           ← contextBridge
  renderer/          ← React + Live2D (works in any modern Chromium-based shell)
```

### Design rules (apply to every new feature)

1. **Business logic in `src/core/`.** Never imports `electron`, never imports native modules.
2. **Resource handles injected, not derived.** Functions take `dataDir`, `apiKey`, etc. as args instead of calling `app.getPath('userData')` or `process.env.X` themselves. Hosts wire those in at startup.
3. **Platform capabilities behind interfaces.** Storage, notifications, screen capture, window controls → all defined as interfaces in `src/core/`. Each host (Electron / PWA / Capacitor) provides its own impl. Where a platform can't do something, the impl returns a graceful no-op and the UI hides the feature.
4. **Async-first interfaces** even when the desktop impl is synchronous (better-sqlite3). The mobile impl will be async (IndexedDB / sql.js / Capacitor SQLite), and rewriting all the callers from sync to async later is painful.
5. **Web-standard types at boundaries.** `Uint8Array` / `Blob` / `ReadableStream` / `ArrayBuffer` — not Node `Buffer` — on any cross-platform API. Adapter impls may use Buffer internally but should not surface it.

### Desktop-only features (intentional)

These define what makes the **desktop** product distinct; mobile gets a different metaphor:

- Frameless transparent always-on-top window
- Drag-to-reposition character on the desktop
- Screen perception (`desktopCapturer`)
- System-tray integration, global hotkeys
- File-system access (importing custom Live2D models, voice clips)

On mobile, the equivalent product is a regular full-screen app with the same character, persona, memory, and chat backend. We ship that when the desktop version has enough users to justify it — not before.

---

## Tech stack

| Layer | Choice | Why |
|-------|--------|-----|
| App shell | **Electron** + TypeScript | Live2D Cubism is JS-native; electron-builder is the gold standard for shipping to non-technical users |
| Agent SDK | **Vercel AI SDK** (`ai` + `@ai-sdk/openai` + `@ai-sdk/react`) | Most polished agent SDK in any language (2026); provider-agnostic via `baseURL` override; native multimodal; MCP via `experimental_createMCPClient`; Zod-typed tools |
| Default LLM | **Zhipu GLM-4V-Flash** via OpenAI-compatible endpoint | Free, multimodal, mainland-China-accessible. Switchable to OpenAI / Gemini / local in settings. |
| Live2D | **Cubism 4 JS runtime** | Official, web-native, runs on `<canvas>` |
| Persistence (desktop) | **better-sqlite3** + **sqlite-vec** behind `MemoryAdapter` | Same C library as desktop-kanojo's Python sqlite-vec — schema 1:1 portable; sync API simpler than async; sqlite-vec gives us vector search without a separate vector DB. Wrapped behind `core/memory/adapter.ts` so a future PWA/Capacitor host can swap in an IndexedDB- or WASM-sqlite-vec-backed adapter without touching business code. |
| Voice playback | **Web Audio API + AudioWorklet** | Streaming PCM from TTS without buffering whole clip |
| Voice synthesis | **edge-tts** (Node port) default; **GPT-SoVITS** via HTTP optional | edge-tts is free + multilingual; SoVITS for cloned voices |
| UI framework | **React** | Vercel AI SDK ships first-class React bindings (`useChat`, `useCompletion`) that handle streaming UI subscription for free. Solid/Vue would mean reinventing that. |
| Build / dev | **electron-vite** | Vite-based Electron template, modern HMR, TS-first, much cleaner than Electron Forge's legacy config |
| Distribution | **electron-builder** | Code-signing, auto-update, NSIS/dmg/AppImage |
| Lint / format | **ESLint** + **Prettier** | Standard. Strict TS config (`strict: true`, `noUncheckedIndexedAccess: true`). |

---

## Data flow (user input → response → playback)

1. User types a message in renderer; optionally attaches a screenshot (Electron `desktopCapturer`) or image file.
2. Renderer's `useChat` hook posts `{messages, attachments}` over IPC to main.
3. Main appends to L1 working window, runs L2 vector recall against episodic store, assembles system prompt with persona + retrieved snippets.
4. Main calls Vercel AI SDK `streamText({...})` with assembled messages + registered tools (reminder, email, calendar, ...).
5. SDK streams response chunks. For each:
   - `text-delta`: forward to renderer, appended to message bubble.
   - `tool-call`: SDK invokes the tool's `execute()`; main runs the side effect (e.g., write reminder to SQLite); result fed back into the loop automatically.
6. When final text complete: main posts to TTS backend (edge-tts or SoVITS HTTP), streams PCM chunks back to renderer.
7. Renderer's AudioWorklet plays PCM as it arrives; meanwhile derives Live2D mouth-open param from instantaneous PCM amplitude.
8. Main persists user message + final response to L2; queues L3 reflection for next idle moment.

---

## MVP scope

**In (v1):**
- One-shot chat: text + image input → streamed text response.
- L1 + L2 memory (working window + vector recall). Schema ported from desktop-kanojo.
- **One real tool** to prove the loop end-to-end: **local reminder** (writes to SQLite, OS notification when due). Offline, visible, immediately useful.
- edge-tts voice playback with streaming PCM.
- Live2D static load + idle anim (mouth param driven by PCM amplitude; no expression-emotion mapping yet).
- Settings dialog: API key, model selection, voice on/off, Live2D model path.

**Deferred (v2+):**
- Proactive mode (periodic screen-aware "should I speak?" — desktop-kanojo's pattern).
- L3 facts layer + contradiction tracking.
- GPT-SoVITS voice cloning setup wizard.
- Live2D emotion-to-expression mapping with decay.
- Real Gmail / Calendar integrations (via MCP servers).
- Per-output-device audio routing.

**Not doing (now):**
- Coding-agent features (file editing, shell access, code execution).
- Self-hosted server backend — strictly client-side persistence.
- Mobile clients **in v1** — but the codebase is structured so a future PWA / Capacitor port reuses `src/core/` unchanged. See the "Platform compatibility" section.

---

## Three pending scaffolding questions (my recommendations inline)

### 1. Scaffold tool
- **`electron-vite`** ⭐ — Vite + Electron + TS, modern HMR, smallest config surface. Recommend.
- `Electron Forge` — official, more legacy plugin config. Skip unless we hit a corner Vite can't handle.

### 2. UI framework
- **React** ⭐ — Vercel AI SDK has first-class `@ai-sdk/react` bindings (`useChat` etc.) that handle streaming subscriptions for us. **Picking anything else means reinventing that work.** Recommend.
- Solid / Vue / Svelte — elegant but no first-class SDK support (Solid has none).

### 3. Spike 1 mock tool
- **"Set a local reminder"** ⭐ — writes to local SQLite, fires OS notification at due time. Offline, visible, demonstrates the full tool loop, immediately useful as a feature. Recommend.
- "Check fake email" — returns hardcoded JSON. Simpler to write but proves less.

If you don't object to any of these, I'll proceed with the ⭐ row across all three.

---

## What this doc is NOT

- Not a subsystem spec. Memory schema, agent loop internals, voice latency budget all live in per-subsystem docs (`docs/memory.md`, `docs/agent.md`, etc.) written when we implement them.
- Not a roadmap. Roadmap lives in GitHub issues / TaskList once spikes are done.
- Not frozen. Edit whenever a decision changes; commit history is the design log.

---

## License & licensing notes (TBD, leaning Apache-2.0)

To match desktop-kanojo and align with the broader OSS AI ecosystem (Vercel AI SDK is Apache-2.0, Cubism JS components have their own Live2D Free Material License). Final call before public release.
