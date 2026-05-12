import { describe, it, expect } from 'vitest'
import { chunkDocument } from '../src/rag/chunk.js'

describe('chunkDocument', () => {
  it('returns single chunk for short content', () => {
    const chunks = chunkDocument('doc1', 'short content')
    expect(chunks).toHaveLength(1)
    expect(chunks[0].docId).toBe('doc1')
    expect(chunks[0].chunkIndex).toBe(0)
  })

  it('respects max chunk size', () => {
    const para = 'word '.repeat(300)
    const content = [para, para, para, para].join('\n\n')
    const chunks = chunkDocument('doc2', content)
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(4000)
    }
  })

  it('returns empty array for empty content', () => {
    expect(chunkDocument('doc3', '')).toEqual([])
  })

  it('assigns sequential chunk indexes', () => {
    const para = 'word '.repeat(300)
    const content = [para, para, para, para].join('\n\n')
    const chunks = chunkDocument('doc4', content)
    chunks.forEach((c, i) => expect(c.chunkIndex).toBe(i))
  })
})
