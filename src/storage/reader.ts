import fs from 'node:fs/promises'
import matter from 'gray-matter'
import { brainFilePath, BRAIN_ROOT } from './brain-path.js'
import type { BrainDocument, CaptureSource, CaptureType } from '../types.js'
import { CAPTURE_TYPES } from '../types.js'

function normalizeDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'string') return value.slice(0, 10)
  return ''
}

function normalizeDateTime(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 16)
  if (typeof value === 'string') return value.slice(0, 16)
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

export async function readDocument(id: string): Promise<BrainDocument | null> {
  if (!id || typeof id !== 'string') return null

  const filePath = brainFilePath(id)
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    const parsed = matter(raw)
    const fm = parsed.data as Record<string, unknown>

    return {
      id: typeof fm.id === 'string' ? fm.id : id,
      type: asCaptureType(fm.type),
      title: typeof fm.title === 'string' ? fm.title : id,
      content: parsed.content,
      tags: asStringArray(fm.tags),
      created: normalizeDate(fm.created),
      captured_at: normalizeDateTime(fm.captured_at),
      source: asSource(fm.source)
    }
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
