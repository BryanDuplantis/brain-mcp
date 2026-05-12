export type CaptureType = 'session' | 'project' | 'idea' | 'decision' | 'note'

export const CAPTURE_TYPES: readonly CaptureType[] = [
  'session',
  'project',
  'idea',
  'decision',
  'note'
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
}

export interface SearchResult {
  id: string
  title: string
  preview: string
  score: number
  type: CaptureType
  created: string
  tags: string[]
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
