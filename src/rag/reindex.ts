import { chunkDocument } from './chunk.js'
import { embedTexts } from './embed.js'
import { upsertChunks, deleteByDocId } from './store.js'
import type { BrainDocument } from '../types.js'

/**
 * Re-index a document into Chroma: chunk → delete stale chunks → embed →
 * upsert. The SINGLE source of truth for indexing, shared by `capture` (first
 * index) and the brain-enricher worker (re-index after enrichment) so chunk
 * size, embedding model, and upsert metadata stay byte-identical across both
 * writers — FM-11 drift prevention. DRY is the consequence (D1-B ruling); the
 * load-bearing reason is that captured-then-enriched docs and bulk-ingested
 * docs must embed identically or semantic search diverges between them.
 *
 * Contract: returns `true` ONLY on confirmed success. Returns `false` on ANY
 * failure (delete failure, embedding error, upsert failure). It NEVER returns
 * `true` on failure — that property is load-bearing: the worker gates the
 * `pending → v1` status flip on this boolean, and a false-positive would mark
 * a doc enriched-and-searchable while its chunks never landed in Chroma.
 *
 * `deleteByDocId` runs strictly BEFORE upsert (via `where:{docId}`) so a doc
 * whose chunk count shrinks between indexings does not orphan stale `docId::N`
 * chunks. A delete failure short-circuits to `false` (never upsert onto a
 * half-deleted chunk set). First-time capture: the delete is a no-op.
 */
export async function reindexDocument(doc: BrainDocument): Promise<boolean> {
  const chunks = chunkDocument(doc.id, doc.content)
  if (chunks.length === 0) return true

  const deleted = await deleteByDocId(doc.id)
  if (!deleted) return false

  let vectors: number[][]
  try {
    vectors = await embedTexts(chunks.map((c) => c.text))
  } catch (err) {
    console.error(
      '[brain-mcp] reindex: embedding failed:',
      (err as Error).message
    )
    return false
  }

  return upsertChunks(chunks, vectors, { type: doc.type, source: doc.source })
}
