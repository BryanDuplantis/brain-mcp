import { z } from 'zod'
import fs from 'node:fs/promises'
import { readDocument } from '../storage/reader.js'
import { brainFilePath } from '../storage/brain-path.js'
import { deleteByDocId } from '../rag/store.js'
import type { DeleteResult } from '../types.js'

const ID_RE =
  /^(?:[0-9]{4}-[0-9]{2}-[0-9]{2}-(?:session|project|idea|decision|note)|watchlist)-[a-z0-9-]{1,40}$/

export const deleteInputSchema = {
  id: z
    .string()
    .min(1, 'id is required')
    .regex(
      ID_RE,
      'id must match format YYYY-MM-DD-{session|project|idea|decision|note}-{slug} or watchlist-{slug}'
    ),
  // Guard: the schema itself requires `confirm: true`. A missing or false confirm
  // is a parse rejection (thrown before any side effect) — no deletion occurs.
  // Destructive tools are a prompt-injection target on the public surface, so the
  // confirm is in the published input schema, not just a runtime check.
  confirm: z
    .literal(true)
    .describe(
      'Must be true. Delete is IRREVERSIBLE (removes the .md file AND its ChromaDB chunks). A missing or false confirm is rejected with no deletion.'
    )
}

const fullSchema = z.object(deleteInputSchema)

/**
 * HARD delete a brain document: remove its Chroma chunks AND unlink its markdown
 * file. Irreversible. Single-user, authenticated surface; guarded by
 * `confirm: true` (enforced at the schema layer — see deleteInputSchema).
 *
 * Order mirrors reindexDocument's safety: deleteByDocId FIRST (Chroma), then
 * unlink. If the chunk delete fails we abort BEFORE unlink — never orphan a live
 * vector against a missing file (that would surface in search but 404 on recall).
 * A successful chunk delete followed by an already-gone file (ENOENT) is still a
 * success: the doc is removed either way (idempotent).
 */
export async function deleteHandler(rawInput: unknown): Promise<DeleteResult> {
  const { id } = fullSchema.parse(rawInput)

  const doc = await readDocument(id)
  if (!doc) {
    return { deleted: false, id, reason: 'not_found' }
  }

  // 1. Chroma chunks first — abort before touching the file if this fails.
  const chunksDeleted = await deleteByDocId(id)
  if (!chunksDeleted) {
    return { deleted: false, id, reason: 'index_delete_failed' }
  }

  // 2. Unlink the markdown file. ENOENT is benign (already gone) — the chunk
  //    delete succeeded, so the doc is effectively removed.
  const path = brainFilePath(id)
  try {
    await fs.unlink(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return {
        deleted: false,
        id,
        reason: 'file_delete_failed',
        message: (err as Error).message
      }
    }
  }

  return { deleted: true, id, path }
}
