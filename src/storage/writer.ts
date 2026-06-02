import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import matter from 'gray-matter'
import { BRAIN_ROOT, brainFilePath } from './brain-path.js'
import type {
  BrainDocument,
  CaptureSource,
  CaptureType,
  EnrichmentStatus
} from '../types.js'

const KEBAB_MAX = 40

/**
 * brain-mcp runs on an America/New_York Pi. The date *slug* and the body
 * timestamps must reflect the day Bryan actually wrote the note — not UTC.
 * `Date.prototype.toISOString()` is always UTC, so a capture at e.g. 20:22 EDT
 * (already past midnight UTC) rolled the slug a full day forward; any capture
 * between ~8 PM and midnight ET landed on tomorrow's date. We format wall-clock
 * date/datetime in an EXPLICIT IANA zone — not the system-local default — so a
 * future host TZ change can't silently reintroduce the drift.
 */
const CAPTURE_TIME_ZONE = 'America/New_York'

export function zonedStamp(
  now: Date,
  timeZone: string = CAPTURE_TIME_ZONE
): { date: string; dateTime: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now)
  const v = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? ''
  const date = `${v('year')}-${v('month')}-${v('day')}`
  // Matches the writer's prior 19-char emit: YYYY-MM-DDTHH:MM:SS
  const dateTime = `${date}T${v('hour')}:${v('minute')}:${v('second')}`
  return { date, dateTime }
}

export function kebab(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, KEBAB_MAX)
    .replace(/-+$/, '')
}

export function deriveTitle(
  content: string,
  provided?: string
): string {
  if (provided && provided.trim()) return provided.trim()
  const firstLine = content.split('\n').find((l) => l.trim().length > 0) ?? ''
  if (firstLine.length <= 60) return firstLine.trim() || 'untitled'
  return firstLine.slice(0, 60).trim() || 'untitled'
}

export function makeId(
  type: CaptureType,
  title: string,
  now: Date = new Date()
): string {
  const slug = kebab(title) || 'untitled'
  if (type === 'watchlist') return `watchlist-${slug}`
  const date = zonedStamp(now).date
  return `${date}-${type}-${slug}`
}

export interface WriteInput {
  content: string
  type: CaptureType
  title?: string
  tags?: string[]
  source?: CaptureSource
  now?: Date
  /**
   * Structured watchlist fields (D2-A "four questions": title+year, movie/tv,
   * platform, rating). Written to frontmatter ONLY when `type === 'watchlist'`
   * so the brain-enricher worker can reconstruct a WatchlistEntry without
   * reverse-parsing prose. Ignored for every other capture type.
   */
  year?: number | null
  kind?: 'movie' | 'tv'
  platform?: string | null
  rating?: number | null
  /**
   * Internal-API-only override for enrichment fields. NOT exposed via the
   * MCP capture tool's Zod schema (`captureInputSchema` rejects this field
   * at the network boundary). Only in-process import callers — like the
   * P2 backfill script and the brain-enricher worker — can request it.
   *
   * When omitted: writer applies type-discriminated defaults:
   *   `watchlist` → 'pending' + 0
   *   anything else → 'not_applicable' + 0
   *
   * Security note: this param represents a privilege boundary. Changing
   * the boundary (e.g., adding the field to captureInputSchema) requires
   * an explicit security review pass per plan §4 P2.
   */
  enrichment_override?: {
    status: EnrichmentStatus
    schema_version: number
  }
  /**
   * Internal-API-only verbatim timestamp preserve (review CRITICAL 6a). When
   * set, used as-is for frontmatter — NO `new Date()` round-trip (parsing a
   * 19-char ISO string like `2026-05-27T14:32:18` through Date→toISOString can
   * shift the timezone and corrupt the value). The brain-enricher worker passes
   * the original doc's values so a re-write does NOT mutate `captured_at` — the
   * very field the worker's CAS check compares against. NOT on captureInputSchema.
   */
  captured_at?: string
  created?: string
  /**
   * Internal-API-only CAS-aware write (review CRITICAL 6b). When set, the writer
   * re-reads the LIVE file's `captured_at` after writing `.tmp` and immediately
   * before `rename`; if it differs from this value, a concurrent writer (a
   * re-capture) landed since the caller's snapshot — the write aborts (`.tmp`
   * unlinked, `CasAbort` thrown). Shrinks the worker's CAS→rename race down to
   * the rename syscall itself. No-op for normal capture. NOT on captureInputSchema.
   */
  expected_captured_at?: string
}

/**
 * Thrown by `writeDocument` when an `expected_captured_at` CAS check fails: the
 * live file's `captured_at` changed between the caller's snapshot and the
 * rename, signalling a concurrent re-capture. The brain-enricher worker treats
 * this as a normal CAS abort (re-enqueue on next tick), NOT an error to alert on.
 */
export class CasAbort extends Error {
  constructor(
    public readonly id: string,
    public readonly expected: string,
    public readonly actual: string | null
  ) {
    super(
      `CAS abort on ${id}: expected captured_at=${expected}, found ${actual ?? '<missing>'}`
    )
    this.name = 'CasAbort'
  }
}

export async function writeDocument(
  input: WriteInput
): Promise<{ document: BrainDocument; path: string }> {
  await fs.mkdir(BRAIN_ROOT, { recursive: true })

  const now = input.now ?? new Date()
  const title = deriveTitle(input.content, input.title)
  const id = makeId(input.type, title, now)

  const defaultStatus: EnrichmentStatus =
    input.type === 'watchlist' ? 'pending' : 'not_applicable'
  const enrichmentStatus: EnrichmentStatus =
    input.enrichment_override?.status ?? defaultStatus
  const enrichmentSchemaVersion: number =
    input.enrichment_override?.schema_version ?? 0

  // Verbatim timestamp preserve (6a): use supplied strings as-is; only derive
  // from `now` when not provided. No Date round-trip on the override path.
  // When derived, stamp in America/New_York (see zonedStamp) so the body
  // timestamps share the slug's clock — never UTC.
  const stamp = zonedStamp(now)
  const created = input.created ?? stamp.date
  const capturedAt = input.captured_at ?? stamp.dateTime

  const doc: BrainDocument = {
    id,
    type: input.type,
    title,
    content: input.content,
    tags: input.tags ?? [],
    created,
    captured_at: capturedAt,
    source: input.source ?? 'unknown',
    enrichment_status: enrichmentStatus,
    enrichment_schema_version: enrichmentSchemaVersion
  }

  // D2-A: structured watchlist fields are frontmatter only for watchlist docs.
  if (input.type === 'watchlist') {
    if (input.year !== undefined) doc.year = input.year
    if (input.kind !== undefined) doc.kind = input.kind
    if (input.platform !== undefined) doc.platform = input.platform
    if (input.rating !== undefined) doc.rating = input.rating
  }

  const frontmatter: Record<string, unknown> = {
    id: doc.id,
    type: doc.type,
    title: doc.title,
    tags: doc.tags,
    created: doc.created,
    captured_at: doc.captured_at,
    source: doc.source,
    enrichment_status: doc.enrichment_status,
    enrichment_schema_version: doc.enrichment_schema_version
  }
  if (doc.year !== undefined) frontmatter.year = doc.year
  if (doc.kind !== undefined) frontmatter.kind = doc.kind
  if (doc.platform !== undefined) frontmatter.platform = doc.platform
  if (doc.rating !== undefined) frontmatter.rating = doc.rating

  const serialized = matter.stringify(doc.content, frontmatter)

  const finalPath = brainFilePath(id)
  // C2 (BACKLOG): unique tmp path per write. A shared `${finalPath}.tmp` lets two
  // concurrent writers to the same id collide — the first `rename` consumes the
  // staging file, the second hits ENOENT. Scoping the tmp name by pid+uuid means
  // concurrent writers never share a staging file (last rename wins on finalPath,
  // which is the existing CAS-guarded behavior). Hardens every brain-mcp caller.
  const tmpPath = `${finalPath}.${process.pid}.${randomUUID()}.tmp`

  await fs.writeFile(tmpPath, serialized, 'utf8')

  // CAS-aware write (6b): re-read the live file's captured_at right before the
  // rename. If it changed since the caller's snapshot, a concurrent re-capture
  // landed — abort rather than clobber it. No-op for normal capture (unset).
  if (input.expected_captured_at !== undefined) {
    let liveCapturedAt: string | null = null
    try {
      const liveRaw = await fs.readFile(finalPath, 'utf8')
      const liveFm = matter(liveRaw).data as Record<string, unknown>
      liveCapturedAt =
        typeof liveFm.captured_at === 'string'
          ? liveFm.captured_at.slice(0, 19)
          : null
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        await fs.rm(tmpPath, { force: true })
        throw err
      }
      // File vanished since the snapshot — treat as a concurrent change.
      liveCapturedAt = null
    }
    if (liveCapturedAt !== input.expected_captured_at) {
      await fs.rm(tmpPath, { force: true })
      throw new CasAbort(id, input.expected_captured_at, liveCapturedAt)
    }
  }

  await fs.rename(tmpPath, finalPath)

  await fs.access(finalPath)

  return { document: doc, path: finalPath }
}
