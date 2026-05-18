/**
 * Embedding client — talks to any OpenAI-compatible /embeddings endpoint.
 *
 * Takes explicit endpoint params (NOT the full Config) so this file has no
 * Electron-only imports and can be exercised from plain Node smoke tests.
 * Callers build the EmbedOptions from config in their own module.
 */

export interface EmbedOptions {
  /** e.g. https://api.openai.com/v1 — trailing slash optional. */
  baseUrl: string
  apiKey: string
  /** e.g. text-embedding-3-small */
  model: string
  /**
   * Optional Matryoshka truncation. Both OpenAI text-embedding-3-* and
   * Gemini embedding-001 honor this; older models silently ignore it.
   */
  dim?: number
}

interface EmbeddingResponse {
  data: { embedding: number[] }[]
}

export async function embed(text: string, opts: EmbedOptions): Promise<Float32Array> {
  if (!opts.apiKey) throw new Error('embed: no API key provided')

  const url = opts.baseUrl.replace(/\/$/, '') + '/embeddings'
  const body: Record<string, unknown> = { input: text, model: opts.model }
  if (opts.dim) body.dimensions = opts.dim

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`embed: ${res.status} ${res.statusText} — ${detail.slice(0, 200)}`)
  }

  const json = (await res.json()) as EmbeddingResponse
  const vec = json.data[0]?.embedding
  if (!vec) throw new Error('embed: empty response')
  return new Float32Array(vec)
}
