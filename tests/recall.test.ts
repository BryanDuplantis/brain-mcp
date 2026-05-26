import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { recallInputSchema } from '../src/tools/recall.js'

const schema = z.object(recallInputSchema)

describe('recall ID validation', () => {
  it('accepts traditional YYYY-MM-DD-type-slug', () => {
    expect(() =>
      schema.parse({ id: '2026-05-26-session-brain-mcp-persist-fix-retry' })
    ).not.toThrow()
  })

  it('accepts every legacy capture type', () => {
    const types = ['session', 'project', 'idea', 'decision', 'note']
    for (const t of types) {
      expect(() => schema.parse({ id: `2026-05-26-${t}-foo` })).not.toThrow()
    }
  })

  it('accepts watchlist-slug (no date prefix)', () => {
    expect(() =>
      schema.parse({ id: 'watchlist-the-matrix' })
    ).not.toThrow()
  })

  it('rejects bare unknown text', () => {
    expect(() => schema.parse({ id: 'just-random-text' })).toThrow()
  })

  it('rejects watchlist with a date prefix', () => {
    expect(() =>
      schema.parse({ id: '2026-05-26-watchlist-foo' })
    ).toThrow()
  })

  it('rejects empty id', () => {
    expect(() => schema.parse({ id: '' })).toThrow()
  })

  it('rejects malformed date components', () => {
    expect(() =>
      schema.parse({ id: '2026-5-26-session-foo' })
    ).toThrow()
  })

  it('rejects slug with uppercase or punctuation', () => {
    expect(() =>
      schema.parse({ id: 'watchlist-Spider-Man!' })
    ).toThrow()
  })
})
