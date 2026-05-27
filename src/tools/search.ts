import { z } from 'zod'
import { embedQuery } from '../rag/embed.js'
import { queryByVector } from '../rag/store.js'
import { readDocument } from '../storage/reader.js'
import type { SearchResponse, SearchResult } from '../types.js'

export const searchInputSchema = {
  query: z.string().min(1, 'query is required'),
  topK: z.number().int().positive().max(50).optional()
}

const fullSchema = z.object(searchInputSchema)

const DEFAULT_TOPK = parseInt(process.env.RAG_TOPK ?? '6', 10) || 6

export async function searchHandler(
  rawInput: unknown
): Promise<SearchResponse> {
  const { query, topK } = fullSchema.parse(rawInput)

  let vector: number[]
  try {
    vector = await embedQuery(query)
  } catch (err) {
    return {
      results: [],
      status: 'index_unavailable',
      message: `Embedding failed: ${(err as Error).message}`
    }
  }

  const k = topK ?? DEFAULT_TOPK
  const outcome = await queryByVector(vector, k)

  if (!outcome.available) {
    return {
      results: [],
      status: 'index_unavailable',
      message: outcome.message ?? 'ChromaDB unreachable'
    }
  }

  const byDoc = new Map<string, number>()
  for (const r of outcome.results) {
    const prev = byDoc.get(r.docId) ?? -Infinity
    if (r.score > prev) byDoc.set(r.docId, r.score)
  }

  const results: SearchResult[] = []
  for (const [docId, score] of byDoc.entries()) {
    if (!docId) continue
    const doc = await readDocument(docId)
    if (!doc) continue
    results.push({
      id: doc.id,
      title: doc.title,
      preview: doc.content.slice(0, 200),
      score,
      type: doc.type,
      created: doc.created,
      tags: doc.tags,
      enrichment_status: doc.enrichment_status,
      enrichment_schema_version: doc.enrichment_schema_version
    })
  }

  results.sort((a, b) => b.score - a.score)

  return { results, status: 'ok' }
}
