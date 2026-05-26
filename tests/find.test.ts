import { describe, it, expect } from 'vitest'
import { buildWhere } from '../src/tools/find.js'

describe('buildWhere', () => {
  it('returns undefined when no filters are passed', () => {
    expect(buildWhere()).toBeUndefined()
  })

  it('returns undefined for empty filter arrays', () => {
    expect(buildWhere([], [])).toBeUndefined()
  })

  it('returns a single clause when only type is set', () => {
    expect(buildWhere(['watchlist'])).toEqual({
      type: { $in: ['watchlist'] }
    })
  })

  it('returns a single clause when only source is set', () => {
    expect(buildWhere(undefined, ['claude-code'])).toEqual({
      source: { $in: ['claude-code'] }
    })
  })

  it('combines type and source under $and', () => {
    expect(buildWhere(['session', 'note'], ['bulk'])).toEqual({
      $and: [
        { type: { $in: ['session', 'note'] } },
        { source: { $in: ['bulk'] } }
      ]
    })
  })
})
