import type { EnrichmentStatus } from './shared/index.js'

// Re-export so consumers can `import type { EnrichmentStatus } from '../types.js'`
// alongside BrainDocument without needing to know about the shared module's layout.
export type { EnrichmentStatus } from './shared/index.js'

export type CaptureType =
  | 'session'
  | 'project'
  | 'idea'
  | 'decision'
  | 'note'
  | 'watchlist'

export const CAPTURE_TYPES: readonly CaptureType[] = [
  'session',
  'project',
  'idea',
  'decision',
  'note',
  'watchlist'
] as const

export type CaptureSource =
  | 'ios'
  | 'macos'
  | 'claude.ai'
  | 'claude-code'
  | 'bulk'
  | 'unknown'

export interface BrainDocument {
  id: string
  type: CaptureType
  title: string
  content: string
  tags: string[]
  created: string
  captured_at: string
  source: CaptureSource
  enrichment_status: EnrichmentStatus
  enrichment_schema_version: number
  // D2-A structured watchlist fields — present only on type === 'watchlist'
  // (the "four questions": title+year, movie/tv, platform, rating). The
  // brain-enricher worker reads these to build a WatchlistEntry for Sonnet
  // without reverse-parsing prose.
  year?: number | null
  kind?: 'movie' | 'tv'
  platform?: string | null
  rating?: number | null
}

export interface SearchResult {
  id: string
  title: string
  preview: string
  score: number
  type: CaptureType
  created: string
  tags: string[]
  enrichment_status: EnrichmentStatus
  enrichment_schema_version: number
}

export interface SearchResponse {
  results: SearchResult[]
  status: 'ok' | 'index_unavailable'
  message?: string
}

export interface CaptureResult {
  id: string
  stored: boolean
  embedded: boolean
  path: string
}

export interface RecallResult {
  found: boolean
  document?: BrainDocument
  message?: string
}

export interface DeleteResult {
  deleted: boolean
  id: string
  // Set on success — the unlinked markdown path.
  path?: string
  // Set on a non-deletion: why it didn't happen.
  reason?: 'not_found' | 'index_delete_failed' | 'file_delete_failed'
  message?: string
}
