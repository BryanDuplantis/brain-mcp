import fs from 'node:fs/promises'
import matter from 'gray-matter'
import { brainFilePath, BRAIN_ROOT } from './brain-path.js'
import type { BrainDocument, CaptureSource, CaptureType } from '../types.js'
import { CAPTURE_TYPES } from '../types.js'
import { asEnrichmentStatus } from '../shared/index.js'

function normalizeDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'string') return value.slice(0, 10)
  return ''
}

// Seconds-precision timestamps (R-extra micro-rework). The writer emits
// `.slice(0, 19)` from `.toISOString()` → `2026-05-27T14:32:07`. If this
// reader truncates to `.slice(0, 16)`, CAS round-trip writes pendingStartedAt
// at 19 chars and re-reads at 16 chars — string equality fails on every
// write, worker aborts every enrichment. Both branches must match writer's
// 19-char emit.
function normalizeDateTime(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 19)
  if (typeof value === 'string') return value.slice(0, 19)
  return ''
}

function asCaptureType(value: unknown): CaptureType {
  if (typeof value === 'string' && (CAPTURE_TYPES as readonly string[]).includes(value)) {
    return value as CaptureType
  }
  return 'note'
}

function asSource(value: unknown): CaptureSource {
  const valid: CaptureSource[] = ['ios', 'macos', 'claude.ai', 'claude-code', 'bulk', 'unknown']
  if (typeof value === 'string' && (valid as string[]).includes(value)) {
    return value as CaptureSource
  }
  return 'unknown'
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string')
  return []
}

// Integer parse with default. Defends against accidental floats/strings in
// frontmatter (gray-matter typically parses unquoted numeric YAML to number,
// but legacy or hand-edited frontmatter may carry a string).
function asInteger(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string') {
    const n = parseInt(value, 10)
    if (Number.isInteger(n)) return n
  }
  return fallback
}

// D2-A watchlist-field parsers. Permissive: unrecognized/absent values return
// `undefined` so the reader simply omits the field (non-watchlist docs and
// legacy watchlist docs carry none of these).
function asKind(value: unknown): 'movie' | 'tv' | undefined {
  return value === 'movie' || value === 'tv' ? value : undefined
}

function asNumberOrNull(value: unknown): number | null | undefined {
  if (value === null) return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

function asStringOrNull(value: unknown): string | null | undefined {
  if (value === null) return null
  if (typeof value === 'string') return value
  return undefined
}

export async function readDocument(id: string): Promise<BrainDocument | null> {
  if (!id || typeof id !== 'string') return null

  const filePath = brainFilePath(id)
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    const parsed = matter(raw)
    const fm = parsed.data as Record<string, unknown>

    const doc: BrainDocument = {
      id: typeof fm.id === 'string' ? fm.id : id,
      type: asCaptureType(fm.type),
      title: typeof fm.title === 'string' ? fm.title : id,
      content: parsed.content,
      tags: asStringArray(fm.tags),
      created: normalizeDate(fm.created),
      captured_at: normalizeDateTime(fm.captured_at),
      source: asSource(fm.source),
      // Legacy frontmatter (pre-P0) lacks both fields; defaults route those
      // captures to `not_applicable` so the worker scan-loop skips them.
      enrichment_status: asEnrichmentStatus(fm.enrichment_status, 'not_applicable'),
      enrichment_schema_version: asInteger(fm.enrichment_schema_version, 0)
    }

    // D2-A: attach structured watchlist fields only when present in frontmatter.
    const year = asNumberOrNull(fm.year)
    if (year !== undefined) doc.year = year
    const kind = asKind(fm.kind)
    if (kind !== undefined) doc.kind = kind
    const platform = asStringOrNull(fm.platform)
    if (platform !== undefined) doc.platform = platform
    const rating = asNumberOrNull(fm.rating)
    if (rating !== undefined) doc.rating = rating

    return doc
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    throw err
  }
}

export async function listDocumentIds(): Promise<string[]> {
  try {
    const entries = await fs.readdir(BRAIN_ROOT, { withFileTypes: true })
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name.replace(/\.md$/, ''))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return []
    throw err
  }
}
