import { describe, it, expect } from 'vitest'
import { kebab, deriveTitle, makeId, writeDocument, zonedStamp } from '../src/storage/writer.js'
import { readDocument } from '../src/storage/reader.js'

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

describe('date slug uses America/New_York, not UTC (evening crossover)', () => {
  // 2026-06-01 20:22 EDT === 2026-06-02 00:22 UTC. The UTC path stamped the
  // slug 2026-06-02 (tomorrow); ET must keep it 2026-06-01.
  const eveningET = new Date('2026-06-02T00:22:00Z')

  it('an 8:22 PM ET capture is dated today, not tomorrow', () => {
    expect(makeId('note', 'Late Night Idea', eveningET)).toBe(
      '2026-06-01-note-late-night-idea'
    )
  })

  it('body created/captured_at share the slug clock (ET)', () => {
    const stamp = zonedStamp(eveningET)
    expect(stamp.date).toBe('2026-06-01')
    expect(stamp.dateTime).toBe('2026-06-01T20:22:00')
  })

  it('a normal daytime capture is unaffected', () => {
    // 14:05 EDT === 18:05 UTC — same day either way; the control case.
    const middayET = new Date('2026-06-01T18:05:30Z')
    expect(makeId('note', 'Midday Thought', middayET)).toBe(
      '2026-06-01-note-midday-thought'
    )
    expect(zonedStamp(middayET).dateTime).toBe('2026-06-01T14:05:30')
  })
})

describe('writeDocument concurrent same-id (C2 — unique tmp path)', () => {
  it('does not throw ENOENT when many writers race the same id', async () => {
    const N = 30
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        writeDocument({
          content: `race body ${i}`,
          type: 'watchlist',
          title: 'Concurrent Race Target'
        })
      )
    )
    const enoent = results.filter(
      (r) =>
        r.status === 'rejected' &&
        /ENOENT/.test(String((r as PromiseRejectedResult).reason))
    )
    // Shared `${finalPath}.tmp` would let one writer's rename consume the staging
    // file out from under another → ENOENT. Unique per-write tmp ⇒ never.
    expect(enoent).toHaveLength(0)
    // The id is deterministic (watchlist = title-only) and the file is valid.
    const doc = await readDocument(makeId('watchlist', 'Concurrent Race Target'))
    expect(doc).toBeTruthy()
    expect(doc?.content).toMatch(/race body/)
  })
})
