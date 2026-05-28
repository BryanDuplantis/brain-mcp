/**
 * reindexDocument contract (D1-B). The single indexing path shared by capture
 * and the brain-enricher worker. The load-bearing property: it NEVER returns
 * `true` on failure — the worker gates `pending → v1` on this boolean. And
 * deleteByDocId must run strictly BEFORE upsert so a shrinking chunk count
 * cannot orphan stale chunks.
 *
 * embed + store are mocked so the contract is verified without a live Voyage
 * key or a running Chroma.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('../src/rag/embed.js', () => ({
  embedTexts: vi.fn()
}))
vi.mock('../src/rag/store.js', () => ({
  deleteByDocId: vi.fn(),
  upsertChunks: vi.fn()
}))

import { reindexDocument } from '../src/rag/reindex.js'
import { embedTexts } from '../src/rag/embed.js'
import { deleteByDocId, upsertChunks } from '../src/rag/store.js'
import type { BrainDocument } from '../src/types.js'

const mockEmbed = vi.mocked(embedTexts)
const mockDelete = vi.mocked(deleteByDocId)
const mockUpsert = vi.mocked(upsertChunks)

function doc(content = 'Some enriched body text.'): BrainDocument {
  return {
    id: 'watchlist-test',
    type: 'watchlist',
    title: 'Test',
    content,
    tags: ['watchlist', 'movie'],
    created: '2026-05-27',
    captured_at: '2026-05-27T14:00:00',
    source: 'claude-code',
    enrichment_status: 'pending',
    enrichment_schema_version: 0
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('reindexDocument contract (D1-B)', () => {
  it('deletes BEFORE upsert and returns true on success', async () => {
    mockDelete.mockResolvedValue(true)
    mockEmbed.mockResolvedValue([[0.1, 0.2]])
    mockUpsert.mockResolvedValue(true)

    const result = await reindexDocument(doc())
    expect(result).toBe(true)
    expect(mockDelete).toHaveBeenCalledWith('watchlist-test')
    expect(mockUpsert).toHaveBeenCalledTimes(1)
    expect(mockDelete.mock.invocationCallOrder[0]).toBeLessThan(
      mockUpsert.mock.invocationCallOrder[0]
    )
  })

  it('returns false and does NOT embed/upsert when delete fails', async () => {
    mockDelete.mockResolvedValue(false)
    const result = await reindexDocument(doc())
    expect(result).toBe(false)
    expect(mockEmbed).not.toHaveBeenCalled()
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it('returns false and does NOT upsert when embedding throws', async () => {
    mockDelete.mockResolvedValue(true)
    mockEmbed.mockRejectedValue(new Error('VOYAGE down'))
    const result = await reindexDocument(doc())
    expect(result).toBe(false)
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it('returns false when upsert fails (never true-on-failure)', async () => {
    mockDelete.mockResolvedValue(true)
    mockEmbed.mockResolvedValue([[0.1]])
    mockUpsert.mockResolvedValue(false)
    const result = await reindexDocument(doc())
    expect(result).toBe(false)
  })

  it('returns true and skips delete/embed for empty content', async () => {
    const result = await reindexDocument(doc('   '))
    expect(result).toBe(true)
    expect(mockDelete).not.toHaveBeenCalled()
    expect(mockEmbed).not.toHaveBeenCalled()
  })
})
