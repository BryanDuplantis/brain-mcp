import { ChromaClient, type Collection } from 'chromadb'
import type { Chunk } from './chunk.js'
import type { CaptureSource, CaptureType } from '../types.js'

const COLLECTION = 'brain'

export interface RawResult {
  docId: string
  chunkIndex: number
  text: string
  score: number
}

export interface QueryOutcome {
  results: RawResult[]
  available: boolean
  message?: string
}

export interface ChunkMetadata {
  type?: CaptureType
  source?: CaptureSource
}

export type WhereFilter = Record<string, unknown>

let _client: ChromaClient | null = null
let _collection: Collection | null = null

function client(): ChromaClient {
  if (_client) return _client
  const path = process.env.CHROMA_URL ?? 'http://localhost:8000'
  _client = new ChromaClient({ path })
  return _client
}

async function collection(): Promise<Collection> {
  if (_collection) return _collection
  _collection = await client().getOrCreateCollection({
    name: COLLECTION,
    metadata: { 'hnsw:space': 'cosine' }
  })
  return _collection
}

export async function upsertChunks(
  chunks: Chunk[],
  vectors: number[][],
  meta?: ChunkMetadata
): Promise<boolean> {
  if (chunks.length === 0) return true
  if (chunks.length !== vectors.length) {
    throw new Error('upsertChunks: chunk/vector length mismatch')
  }
  try {
    const col = await collection()
    await col.upsert({
      ids: chunks.map((c) => `${c.docId}::${c.chunkIndex}`),
      embeddings: vectors,
      documents: chunks.map((c) => c.text),
      metadatas: chunks.map((c) => ({
        docId: c.docId,
        chunkIndex: c.chunkIndex,
        ...(meta?.type ? { type: meta.type } : {}),
        ...(meta?.source ? { source: meta.source } : {})
      }))
    })
    return true
  } catch (err) {
    console.error(
      '[brain-mcp] ChromaDB upsert failed:',
      (err as Error).message
    )
    return false
  }
}

/**
 * Delete all chunks for a document by its docId metadata (via `where`, so it
 * catches orphan `docId::N` chunks at ANY index, not just the ones a caller is
 * about to rewrite). Used by `reindexDocument` strictly BEFORE upsert: if a
 * doc's chunk count shrinks between indexings, stale chunks would otherwise
 * linger and pollute search. A first-time capture's delete is a harmless no-op.
 *
 * Returns false on failure so the caller can refuse to proceed to upsert
 * (never leave a mixed old+new chunk set).
 */
export async function deleteByDocId(docId: string): Promise<boolean> {
  if (!docId) return false
  try {
    const col = await collection()
    await col.delete({ where: { docId } })
    return true
  } catch (err) {
    console.error(
      '[brain-mcp] ChromaDB delete failed:',
      (err as Error).message
    )
    return false
  }
}

export async function queryByVector(
  vector: number[],
  topK: number,
  where?: WhereFilter
): Promise<QueryOutcome> {
  try {
    const col = await collection()
    const res = await col.query({
      queryEmbeddings: [vector],
      nResults: topK,
      ...(where ? { where } : {})
    })

    const ids = res.ids?.[0] ?? []
    const docs = res.documents?.[0] ?? []
    const dists = res.distances?.[0] ?? []
    const metas = res.metadatas?.[0] ?? []

    const results: RawResult[] = ids.map((_id, i) => {
      const meta = (metas[i] ?? {}) as Record<string, unknown>
      const distance = typeof dists[i] === 'number' ? (dists[i] as number) : 1
      return {
        docId: typeof meta.docId === 'string' ? meta.docId : '',
        chunkIndex:
          typeof meta.chunkIndex === 'number' ? (meta.chunkIndex as number) : 0,
        text: typeof docs[i] === 'string' ? (docs[i] as string) : '',
        score: 1 - distance
      }
    })

    return { results, available: true }
  } catch (err) {
    const message = (err as Error).message
    console.error('[brain-mcp] ChromaDB query failed:', message)
    return { results: [], available: false, message }
  }
}
