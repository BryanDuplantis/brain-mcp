import { z } from 'zod'
import { readDocument } from '../storage/reader.js'
import type { RecallResult } from '../types.js'

const ID_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}-(?:session|project|idea|decision|note)-[a-z0-9-]{1,40}$/

export const recallInputSchema = {
  id: z.string().min(1, 'id is required').regex(ID_RE, 'id must match format YYYY-MM-DD-type-slug')
}

const fullSchema = z.object(recallInputSchema)

export async function recallHandler(rawInput: unknown): Promise<RecallResult> {
  const { id } = fullSchema.parse(rawInput)

  const doc = await readDocument(id)
  if (!doc) {
    return {
      found: false,
      message: `No document found for id "${id}"`
    }
  }
  return { found: true, document: doc }
}
