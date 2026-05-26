import { describe, it, expect } from 'vitest'
import { kebab, deriveTitle, makeId } from '../src/storage/writer.js'

describe('kebab', () => {
  it('lowercases and hyphenates', () => {
    expect(kebab('Hello World Test')).toBe('hello-world-test')
  })
  it('strips punctuation', () => {
    expect(kebab('What is this?!')).toBe('what-is-this')
  })
  it('caps at 40 chars', () => {
    expect(kebab('a'.repeat(60)).length).toBeLessThanOrEqual(40)
  })
})

describe('deriveTitle', () => {
  it('uses provided title when given', () => {
    expect(deriveTitle('content', 'My Title')).toBe('My Title')
  })
  it('falls back to first line if short', () => {
    expect(deriveTitle('short line\nmore')).toBe('short line')
  })
  it('truncates long first line to 60 chars', () => {
    const long = 'a'.repeat(100)
    expect(deriveTitle(long).length).toBe(60)
  })
})

describe('makeId', () => {
  it('produces YYYY-MM-DD-type-slug format', () => {
    const id = makeId('note', 'Hello World', new Date('2026-05-12T10:00:00Z'))
    expect(id).toBe('2026-05-12-note-hello-world')
  })
  it('omits the date prefix for watchlist type', () => {
    const id = makeId('watchlist', 'The Matrix', new Date('2026-05-26T10:00:00Z'))
    expect(id).toBe('watchlist-the-matrix')
  })
  it('strips punctuation from watchlist titles', () => {
    const id = makeId('watchlist', 'Spider-Man: Into the Spider-Verse')
    expect(id).toBe('watchlist-spider-man-into-the-spider-verse')
  })
})
