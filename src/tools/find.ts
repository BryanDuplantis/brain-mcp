import { z } from 'zod'
import { embedQuery } from '../rag/embed.js'
import { queryByVector, type WhereFilter } from '../rag/store.js'
import { readDocument } from '../storage/reader.js'
import { CAPTURE_TYPES } from '../types.js'
import type {
  SearchResponse,
  SearchResult,
  CaptureType,
  CaptureSource
} from '../types.js'

const SOURCES = [
  'ios',
  'macos',
  'claude.ai',
  'claude-code',
  'bulk',
  'unknown'
] as const

export const findInputSchema = {
  query: z.string().min(1, 'query is required'),
  topK: z.number().int().positive().max(50).optional(),
  type: z
    .array(z.enum(CAPTURE_TYPES as unknown as [string, ...string[]]))
    .optional(),
  source: z
    .array(z.enum(SOURCES as unknown as [string, ...string[]]))
    .optional()
}

const fullSchema = z.object(findInputSchema)

const DEFAULT_TOPK = parseInt(process.env.RAG_FIND_TOPK ?? '12', 10) || 12

export function buildWhere(
  types?: CaptureType[],
  sources?: CaptureSource[]
): WhereFilter | undefined {
  const clauses: Record<string, unknown>[] = []
  if (types && types.length > 0) clauses.push({ type: { $in: types } })
  if (sources && sources.length > 0) clauses.push({ source: { $in: sources } })
  if (clauses.length === 0) return undefined
  if (clauses.length === 1) return clauses[0]
  return { $and: clauses }
}

export async function findHandler(
  rawInput: unknown
): Promise<SearchResponse> {
  const { query, topK, type, source } = fullSchema.parse(rawInput)

  let vector: number[]
  try {
    vector = await embedQuery(query)
  } catch {
    return {
      results: [],
      status: 'index_unavailable',
      message: 'Embedding failed'
    }
  }

  const where = buildWhere(
    type as CaptureType[] | undefined,
    source as CaptureSource[] | undefined
  )

  const k = topK ?? DEFAULT_TOPK
  const outcome = await queryByVector(vector, k, where)

  if (!outcome.available) {
    return {
      results: [],
      status: 'index_unavailable',
      message: 'Vector store unavailable'
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
      tags: doc.tags
    })
  }

  results.sort((a, b) => b.score - a.score)
  return { results, status: 'ok' }
}
