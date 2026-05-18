/**
 * Verify that gemini-embedding-001 works against Gemini's openai-compat
 * /embeddings endpoint with the user's .env key. Confirms the memory-tab
 * silent-write-failure fix.
 *
 * Run: npx electron tools/smoke-gemini-embed.mjs
 */

import { app } from 'electron'

async function main() {
  try {
    process.loadEnvFile('.env')
  } catch {}

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    console.error('❌ GEMINI_API_KEY missing in .env')
    app.exit(1)
    return
  }

  const url = 'https://generativelanguage.googleapis.com/v1beta/openai/embeddings'
  const body = {
    input: '你好，今天天气真好',
    model: 'gemini-embedding-001',
    dimensions: 1536,
  }

  console.log('POST', url, '\n  model:', body.model, '· dim:', body.dimensions)
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const detail = await res.text()
    console.error(`❌ ${res.status} ${res.statusText} — ${detail.slice(0, 300)}`)
    app.exit(1)
    return
  }

  const json = await res.json()
  const vec = json.data?.[0]?.embedding
  if (!Array.isArray(vec)) {
    console.error('❌ unexpected response shape:', JSON.stringify(json).slice(0, 300))
    app.exit(1)
    return
  }
  console.log(
    `\n✅ Got ${vec.length}-dim vector. First 6 values: ${vec
      .slice(0, 6)
      .map((v) => v.toFixed(4))
      .join(', ')}`,
  )
  app.exit(0)
}

app.whenReady().then(main).catch((err) => {
  console.error('crashed:', err)
  app.exit(1)
})
