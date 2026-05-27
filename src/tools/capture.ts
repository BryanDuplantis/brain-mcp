import { z } from 'zod'
import { writeDocument } from '../storage/writer.js'
import { chunkDocument } from '../rag/chunk.js'
import { embedTexts } from '../rag/embed.js'
import { upsertChunks } from '../rag/store.js'
import { CAPTURE_TYPES } from '../types.js'
import type { CaptureResult, CaptureSource, CaptureType } from '../types.js'

export const captureInputSchema = {
  content: z.string().min(1, 'content is required').max(100_000, 'content exceeds 100KB limit'),
  type: z.enum(CAPTURE_TYPES as unknown as [string, ...string[]]),
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
  source: z.enum(['ios', 'macos', 'claude.ai', 'claude-code', 'bulk', 'unknown']).optional()
}

// R1 micro-rework: `.strict()` makes Zod throw on unknown keys instead of
// silently dropping them. The privilege boundary is *the schema itself* —
// `enrichment_override` (and any other future internal-only WriteInput field)
// MUST be rejected at the MCP boundary, not silently filtered. A malformed
// caller passing `enrichment_override: { status: 'v1', ... }` gets a Zod
// parse error here; only direct in-process import callers (e.g. P2 backfill)
// can request the override via `writeDocument(..., { enrichment_override: ... })`.
const fullSchema = z.object(captureInputSchema).strict()
type CaptureInput = z.infer<typeof fullSchema>

export async function captureHandler(
  rawInput: unknown
): Promise<CaptureResult> {
  const input: CaptureInput = fullSchema.parse(rawInput)

  const { document, path } = await writeDocument({
    content: input.content,
    type: input.type as CaptureInput['type'] as never,
    title: input.title,
    tags: input.tags,
    source: (input.source ?? 'unknown') as CaptureSource
  })

  let embedded = false
  try {
    const chunks = chunkDocument(document.id, document.content)
    if (chunks.length > 0) {
      const vectors = await embedTexts(chunks.map((c) => c.text))
      embedded = await upsertChunks(chunks, vectors, {
        type: document.type as CaptureType,
        source: document.source
      })
    }
  } catch (err) {
    console.error(
      '[brain-mcp] capture: embedding failed but document stored:',
      (err as Error).message
    )
    embedded = false
  }

  return {
    id: document.id,
    stored: true,
    embedded,
    path: document.id + '.md'  // filename only — full Pi path not exposed to caller
  }
}
