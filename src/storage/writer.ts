import fs from 'node:fs/promises'
import path from 'node:path'
import matter from 'gray-matter'
import { BRAIN_ROOT, brainFilePath } from './brain-path.js'
import type { BrainDocument, CaptureSource, CaptureType } from '../types.js'

const KEBAB_MAX = 40

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
  const date = now.toISOString().slice(0, 10)
  return `${date}-${type}-${slug}`
}

export interface WriteInput {
  content: string
  type: CaptureType
  title?: string
  tags?: string[]
  source?: CaptureSource
  now?: Date
}

export async function writeDocument(
  input: WriteInput
): Promise<{ document: BrainDocument; path: string }> {
  await fs.mkdir(BRAIN_ROOT, { recursive: true })

  const now = input.now ?? new Date()
  const title = deriveTitle(input.content, input.title)
  const id = makeId(input.type, title, now)

  const doc: BrainDocument = {
    id,
    type: input.type,
    title,
    content: input.content,
    tags: input.tags ?? [],
    created: now.toISOString().slice(0, 10),
    captured_at: now.toISOString().slice(0, 16),
    source: input.source ?? 'unknown'
  }

  const frontmatter = {
    id: doc.id,
    type: doc.type,
    title: doc.title,
    tags: doc.tags,
    created: doc.created,
    captured_at: doc.captured_at,
    source: doc.source
  }
  const serialized = matter.stringify(doc.content, frontmatter)

  const finalPath = brainFilePath(id)
  const tmpPath = `${finalPath}.tmp`

  await fs.writeFile(tmpPath, serialized, 'utf8')
  await fs.rename(tmpPath, finalPath)

  await fs.access(finalPath)

  return { document: doc, path: finalPath }
}
