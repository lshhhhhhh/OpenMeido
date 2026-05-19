# Building and distributing OpenMeido

## Dev mode

```powershell
npm install
npm run dev
```

Launches `electron-vite dev` with HMR for renderer + auto-reload for main / preload.

## Build a Windows installer

```powershell
npm run dist
```

Output: `dist/OpenMeido-Setup-<version>.exe` — a one-click NSIS installer.

For iterating on packaging without making an installer:

```powershell
npm run dist:dir
```

Output: `dist/win-unpacked/OpenMeido.exe` — runnable directly, no install step. Use this to validate config changes; full `dist` rebuild then takes ~30s longer for compression.

## What ships

The installer is roughly **180MB compressed / ~750MB unpacked**, dominated by:

| | Size |
|---|---|
| Electron 33 runtime | ~250MB |
| `node_modules` (transformers, pixi, ai-sdk, etc.) | ~300MB |
| Bundled renderer JS | ~2MB |
| Cubism Core + your Live2D model | varies (haitu_vts is ~30MB) |

Notable things **not bundled**, fetched lazily on first run:
- `bge-small-zh-v1.5` ONNX model (~95MB) — cached in `%APPDATA%/openmeido/hf-cache/` after first chat that touches memory
- Microsoft Edge TTS voices — streamed over WebSocket per call, no local cache

## Live2D model licensing

`src/renderer/public/live2d-models/haitu_vts/` is **gitignored** because that model is a paid asset with a personal-use license — never commit or redistribute it.

If you're building for personal use or for a friend you can legally share the model with: the build will pick it up from your local checkout automatically (electron-builder bundles `src/renderer/public/` via `extraResources`).

If you're distributing publicly:
1. Delete or replace `src/renderer/public/live2d-models/haitu_vts/` with a freely-licensed model (e.g. the Live2D Cubism Free Material samples)
2. Update the default in `src/shared/config.ts` → `live2d.modelPath`
3. Update the emotion → expression name mapping in `src/main/chat.ts` → `EMOTION_TO_EXPRESSION` to match the new model's expression names from its `model3.json`

## Code signing

Unsigned builds trigger SmartScreen warnings on first launch ("Windows protected your PC"). Users have to click "More info → Run anyway" once, then Windows remembers.

For a real release, get a code signing certificate (DigiCert, Sectigo, ~$200-400/yr), then set:

```powershell
$env:CSC_LINK = "C:\path\to\cert.pfx"
$env:CSC_KEY_PASSWORD = "your-password"
npm run dist
```

electron-builder picks those up automatically.

## Distributing the installer

The simplest path:

1. `npm run dist` produces `dist/OpenMeido-Setup-<version>.exe`
2. Upload to a file host (Google Drive, OneDrive, GitHub Releases)
3. Recipients double-click the .exe, dismiss the SmartScreen warning (unsigned), install

For GitHub Releases specifically:

```powershell
gh release create v0.0.1 dist/OpenMeido-Setup-*.exe --title "OpenMeido v0.0.1" --notes "First release"
```

`electron-builder` also has a built-in auto-update path via `electron-updater` (writes a `latest.yml` next to the installer), but it requires a public host and a code-signed build to be useful — skip for v0.

## First-run setup users need to do

After installing, the user has to open Settings (⚙) and:

1. **AI tab** — paste an OpenAI or Google Gemini API key, pick a chat model
2. **Memory tab** (optional) — first user message triggers the ~95MB bge-small-zh download in the background
3. **Voice tab** (optional) — toggle TTS on, pick a voice (Microsoft Edge TTS is free, online-only)
4. **Mail tab** (optional) — IMAP credentials for the "check my email" tool
5. **Proactive tab** (optional) — enable spontaneous remarks

`.env` is **not** honored in installed builds (only in dev mode) — keys go through the Settings UI and are stored in `%APPDATA%/openmeido/config.json`. Mail password is encrypted with `safeStorage` (OS keychain).

## Native module rebuilds

`better-sqlite3` and `sqlite-vec` are Node native modules — they ship `.node` binaries built against a specific Node ABI. Electron uses its own ABI, different from system Node.

`electron-builder` handles this automatically via the `postinstall` script which runs `electron-builder install-app-deps` — but if you bump Electron's major version, run:

```powershell
npm run postinstall
```

to rebuild the natives for the new ABI.
