/**
 * delete(id, confirm) contract. HARD delete: Chroma chunks + the markdown file.
 * Guarded by `confirm: true` at the schema layer. Order mirrors reindexDocument:
 * deleteByDocId runs strictly BEFORE unlink, and a chunk-delete failure aborts
 * before the file is touched (never orphan a live vector against a missing file).
 *
 * readDocument, deleteByDocId, and fs.unlink are mocked — the branching contract
 * is verified without real storage or a running Chroma.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { z } from 'zod'

vi.mock('../src/storage/reader.js', () => ({ readDocument: vi.fn() }))
vi.mock('../src/rag/store.js', () => ({ deleteByDocId: vi.fn() }))
vi.mock('node:fs/promises', () => {
  const unlink = vi.fn()
  return { default: { unlink }, unlink }
})

import { deleteHandler, deleteInputSchema } from '../src/tools/delete.js'
import { readDocument } from '../src/storage/reader.js'
import { deleteByDocId } from '../src/rag/store.js'
import fsPromises from 'node:fs/promises'
import type { BrainDocument } from '../src/types.js'

const mockRead = vi.mocked(readDocument)
const mockDelete = vi.mocked(deleteByDocId)
const mockUnlink = vi.mocked(fsPromises.unlink)
const schema = z.object(deleteInputSchema)

const ID = '2026-05-12-note-brain-mcp-how-to-worksheet'

function doc(id = ID): BrainDocument {
  return {
    id,
    type: 'note',
    title: 'Worksheet',
    content: 'body',
    tags: ['reference'],
    created: '2026-05-12',
    captured_at: '2026-05-12T10:00:00',
    source: 'claude-code',
    enrichment_status: 'pending',
    enrichment_schema_version: 0
  }
}

beforeEach(() => vi.clearAllMocks())

describe('delete — confirm guard (schema)', () => {
  it('accepts confirm:true', () => {
    expect(() => schema.parse({ id: ID, confirm: true })).not.toThrow()
  })
  it('rejects confirm:false (no deletion can occur — parse throws first)', () => {
    expect(() => schema.parse({ id: ID, confirm: false })).toThrow()
  })
  it('rejects a missing confirm', () => {
    expect(() => schema.parse({ id: ID })).toThrow()
  })
})

describe('deleteHandler', () => {
  it('hard-deletes: Chroma chunks BEFORE unlink, returns deleted:true', async () => {
    mockRead.mockResolvedValue(doc())
    mockDelete.mockResolvedValue(true)
    mockUnlink.mockResolvedValue(undefined)

    const r = await deleteHandler({ id: ID, confirm: true })

    expect(r.deleted).toBe(true)
    expect(r.id).toBe(ID)
    expect(mockDelete).toHaveBeenCalledWith(ID)
    expect(mockUnlink).toHaveBeenCalledTimes(1)
    expect(mockDelete.mock.invocationCallOrder[0]).toBeLessThan(
      mockUnlink.mock.invocationCallOrder[0]
    )
  })

  it('not_found → no chunk delete, no unlink', async () => {
    mockRead.mockResolvedValue(null)
    const r = await deleteHandler({ id: ID, confirm: true })
    expect(r).toEqual({ deleted: false, id: ID, reason: 'not_found' })
    expect(mockDelete).not.toHaveBeenCalled()
    expect(mockUnlink).not.toHaveBeenCalled()
  })

  it('index_delete_failed → aborts BEFORE unlink (never orphan file vs vectors)', async () => {
    mockRead.mockResolvedValue(doc())
    mockDelete.mockResolvedValue(false)
    const r = await deleteHandler({ id: ID, confirm: true })
    expect(r).toEqual({ deleted: false, id: ID, reason: 'index_delete_failed' })
    expect(mockUnlink).not.toHaveBeenCalled()
  })

  it('ENOENT on unlink (after a successful chunk delete) is still deleted:true', async () => {
    mockRead.mockResolvedValue(doc())
    mockDelete.mockResolvedValue(true)
    mockUnlink.mockRejectedValue(
      Object.assign(new Error('no such file'), { code: 'ENOENT' })
    )
    const r = await deleteHandler({ id: ID, confirm: true })
    expect(r.deleted).toBe(true)
  })

  it('non-ENOENT unlink failure → file_delete_failed (chunks already gone)', async () => {
    mockRead.mockResolvedValue(doc())
    mockDelete.mockResolvedValue(true)
    mockUnlink.mockRejectedValue(
      Object.assign(new Error('permission denied'), { code: 'EPERM' })
    )
    const r = await deleteHandler({ id: ID, confirm: true })
    expect(r.deleted).toBe(false)
    expect(r.reason).toBe('file_delete_failed')
  })
})
