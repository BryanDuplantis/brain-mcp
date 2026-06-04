import { z } from 'zod'
import { writeDocument } from '../storage/writer.js'
import { reindexDocument } from '../rag/reindex.js'
import { CAPTURE_TYPES } from '../types.js'
import type { CaptureResult, CaptureSource } from '../types.js'

export const captureInputSchema = {
  content: z.string().min(1, 'content is required').max(100_000, 'content exceeds 100KB limit'),
  type: z.enum(CAPTURE_TYPES as unknown as [string, ...string[]]),
  // Length caps (M3): bound every user-controlled write path to disk + Chroma.
  // Generous headroom — title derives to a 60-char ID, tags/platform are short
  // labels — so legit captures never hit these; they only stop pathological input.
  title: z.string().max(1000, 'title exceeds 1000 chars').optional(),
  tags: z.array(z.string().max(100, 'tag exceeds 100 chars')).max(50, 'too many tags').optional(),
  source: z.enum(['ios', 'macos', 'claude.ai', 'claude-code', 'hermes', 'bulk', 'unknown']).optional(),
  // D2-A "four questions" — structured watchlist fields. Optional and meaningful
  // only for type === 'watchlist' (the writer ignores them for other types).
  // Unlike `enrichment_override`, these ARE part of the public schema: they are
  // user-supplied capture inputs, not a privilege-bearing internal override.
  year: z.number().int().nullable().optional(),
  kind: z.enum(['movie', 'tv']).optional(),
  platform: z.string().max(500, 'platform exceeds 500 chars').nullable().optional(),
  rating: z.number().nullable().optional()
}

// R1 micro-rework: `.strict()` makes Zod throw on unknown keys instead of
// silently dropping them. The privilege boundary is *the schema itself* — the
// internal-only WriteInput fields (`enrichment_override`, `captured_at`,
// `created`, `expected_captured_at`) MUST be rejected at the MCP boundary, not
// silently filtered. A malformed caller passing one gets a Zod parse error
// here; only direct in-process import callers (the P2 backfill script, the
// brain-enricher worker) can request those overrides.
const fullSchema = z.object(captureInputSchema).strict()
type CaptureInput = z.infer<typeof fullSchema>

export async function captureHandler(
  rawInput: unknown
): Promise<CaptureResult> {
  const input: CaptureInput = fullSchema.parse(rawInput)

  const { document } = await writeDocument({
    content: input.content,
    type: input.type as CaptureInput['type'] as never,
    title: input.title,
    tags: input.tags,
    source: (input.source ?? 'unknown') as CaptureSource,
    year: input.year,
    kind: input.kind,
    platform: input.platform,
    rating: input.rating
  })

  // reindexDocument is the SINGLE indexing path, shared with the brain-enricher
  // worker (D1-B). It returns false (never throws-on-failure) when the doc's
  // chunks did not land in Chroma — the document is still stored, so capture
  // succeeds with `embedded: false`. Store-but-not-embedded is recoverable;
  // the reverse is not (brain-mcp CLAUDE.md RAG contract).
  const embedded = await reindexDocument(document)

  return {
    id: document.id,
    stored: true,
    embedded,
    path: document.id + '.md'  // filename only — full Pi path not exposed to caller
  }
}
