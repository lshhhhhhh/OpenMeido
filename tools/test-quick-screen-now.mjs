/**
 * One-shot probe: capture the user's current screens RIGHT NOW and run
 * them through the new buildQuickScreenReactPrompt against Gemini Pro
 * (DeepSeek is text-only). Prints what the maid would say.
 *
 * Run: npm run test:quick-screen-now
 *
 * No assertions — purely "show me what she'd say on my actual screen".
 */
import { app, desktopCapturer } from 'electron'

// Electron doesn't auto-load .env. Pull it in manually.
try {
  process.loadEnvFile('.env')
} catch {
  /* missing .env is fine if vars are already set in shell */
}

async function main() {
  const { register } = await import('tsx/esm/api')
  register()
  const { resolvePersona } = await import('../src/shared/config.ts')
  const { buildTierPromptBlock } = await import('../src/shared/affinity.ts')
  const { buildQuickScreenReactPrompt } = await import('../src/shared/daily-prompts.ts')

  if (!process.env.GEMINI_API_KEY) {
    console.error('no GEMINI_API_KEY in .env — need Gemini for vision')
    app.exit(1)
    return
  }

  // Capture every screen at a reasonable size.
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1600, height: 900 },
  })
  console.log(`captured ${sources.length} screen(s):`)
  for (const s of sources) {
    const sz = s.thumbnail.getSize()
    console.log(`  · "${s.name}" → ${sz.width}×${sz.height}${s.thumbnail.isEmpty() ? ' EMPTY' : ''}`)
  }
  const valid = sources.filter((s) => !s.thumbnail.isEmpty())
  if (valid.length === 0) {
    console.error('all thumbnails empty')
    app.exit(1)
    return
  }
  const pngs = valid.map((s) => s.thumbnail.toPNG())

  // Default OpenMeido state: maid persona, score 47 (mid-熟络, similar
  // to a normal user with light interaction history).
  const persona = resolvePersona({ preset: 'maid', customs: [] })
  const tierBlock = buildTierPromptBlock(47, persona.name, persona.traits)
  const prompt = buildQuickScreenReactPrompt({
    persona,
    tierBlock,
    now: new Date().toLocaleString('zh-CN', { hour12: false }),
    userName: null,
  })

  console.log('\n████ Running Gemini Pro 3.1 with screenshot(s) ████\n')

  // Call Gemini directly via the OpenAI-compat endpoint.
  const { generateText } = await import('ai')
  const { createGoogleGenerativeAI } = await import('@ai-sdk/google')
  const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY })
  const model = google('gemini-3.1-pro-preview')

  try {
    const result = await generateText({
      model,
      temperature: 0.8,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            ...pngs.map((bytes) => ({
              type: 'image',
              image: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
              mediaType: 'image/png',
            })),
          ],
        },
      ],
    })
    // Parse the JSON output — same logic as the main handler.
    const raw = result.text.trim()
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
    let parsed = null
    for (const s of [fenced?.[1], raw, raw.slice(raw.indexOf('{'))].filter(Boolean)) {
      try {
        const obj = JSON.parse(s)
        if (typeof obj.spoken === 'string') {
          parsed = obj
          break
        }
      } catch {}
    }
    if (parsed) {
      console.log('💬 她会说（spoken）：')
      console.log('---')
      console.log(parsed.spoken)
      console.log('---')
      console.log(`(${parsed.spoken.length} 字)\n`)
      console.log('📝 她私下记下（noted，不展示给用户）：')
      for (const n of parsed.noted ?? []) console.log(`  · ${n}`)
    } else {
      console.log('⚠️ JSON 解析失败，原始输出：')
      console.log(raw)
    }
  } catch (err) {
    console.error('Gemini call failed:', err.message ?? err)
    app.exit(1)
    return
  }
  app.exit(0)
}

app.whenReady().then(main).catch((err) => {
  console.error('crashed:', err)
  app.exit(1)
})
