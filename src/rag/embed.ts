import { VoyageAIClient } from 'voyageai'

const MODEL = 'voyage-4'
const TIMEOUT_SECONDS = 60
const MAX_ATTEMPTS = 3
const BACKOFF_MS = [2000, 4000, 8000]

let _client: VoyageAIClient | null = null
function client(): VoyageAIClient {
  if (_client) return _client
  const apiKey = process.env.VOYAGE_API_KEY
  if (!apiKey) {
    throw new Error('VOYAGE_API_KEY is not set')
  }
  _client = new VoyageAIClient({ apiKey })
  return _client
}

function isTimeoutLike(err: unknown): boolean {
  if (!err) return false
  const e = err as { name?: string; message?: string }
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return true
  const msg = (e.message ?? '').toLowerCase()
  return msg.includes('timeout') || msg.includes('aborted')
}

async function embedWithRetry(
  texts: string[],
  inputType: 'document' | 'query'
): Promise<number[][]> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const t0 = Date.now()
    try {
      const result = await client().embed(
        { input: texts, model: MODEL, inputType },
        { timeoutInSeconds: TIMEOUT_SECONDS }
      )
      if (attempt > 1) {
        const elapsed = Date.now() - t0
        console.error(
          `[brain-mcp] embed: succeeded on attempt ${attempt}/${MAX_ATTEMPTS} (${elapsed}ms, ${texts.length} chunks, ${inputType})`
        )
      }
      return (result.data ?? []).map((d) => d.embedding as number[])
    } catch (err) {
      lastErr = err
      const elapsed = Date.now() - t0
      const timeoutLike = isTimeoutLike(err)
      const reason = (err as Error)?.message ?? String(err)
      console.error(
        `[brain-mcp] embed: attempt ${attempt}/${MAX_ATTEMPTS} failed after ${elapsed}ms ` +
          `(${texts.length} chunks, ${inputType}, timeoutLike=${timeoutLike}): ${reason}`
      )
      if (!timeoutLike) throw err
      if (attempt === MAX_ATTEMPTS) break
      await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]))
    }
  }
  throw lastErr
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  return embedWithRetry(texts, 'document')
}

export async function embedQuery(query: string): Promise<number[]> {
  const embeddings = await embedWithRetry([query], 'query')
  const first = embeddings[0]
  if (!first) {
    throw new Error('Voyage AI returned no embedding for query')
  }
  return first
}
