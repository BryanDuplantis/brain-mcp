import { VoyageAIClient } from 'voyageai'

const MODEL = 'voyage-4'

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

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  const result = await client().embed({
    input: texts,
    model: MODEL,
    inputType: 'document'
  })
  return (result.data ?? []).map((d) => d.embedding as number[])
}

export async function embedQuery(query: string): Promise<number[]> {
  const result = await client().embed({
    input: [query],
    model: MODEL,
    inputType: 'query'
  })
  const first = (result.data ?? [])[0]
  if (!first?.embedding) {
    throw new Error('Voyage AI returned no embedding for query')
  }
  return first.embedding as number[]
}
