/**
 * P1 foundation tests — the brain-mcp surface the brain-enricher worker depends
 * on. Maps to the v2-locked proposal §0.5:
 *   6a — WriteInput verbatim captured_at?/created? preserve (no Date round-trip)
 *   6b — expected_captured_at CAS-aware write (positive, negative, ENOENT)
 *   D2-A — four-field watchlist schema round-trip + non-watchlist omission
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { beforeEach, describe, expect, it } from 'vitest'
import { writeDocument, CasAbort } from '../src/storage/writer.js'
import { readDocument } from '../src/storage/reader.js'
import { captureInputSchema } from '../src/tools/capture.js'
import { BRAIN_ROOT } from '../src/storage/brain-path.js'

beforeEach(async () => {
  await fs.rm(BRAIN_ROOT, { recursive: true, force: true })
  await fs.mkdir(BRAIN_ROOT, { recursive: true })
})

describe('WriteInput verbatim timestamp preserve (6a)', () => {
  it('uses supplied captured_at/created as-is, no Date round-trip', async () => {
    const { document } = await writeDocument({
      content: 'preserved-timestamp body',
      type: 'watchlist',
      title: 'Preserve Movie',
      // A value that a Date round-trip (local-tz parse → toISOString) could
      // shift. Verbatim preserve must keep it byte-identical.
      captured_at: '2026-05-27T14:32:18',
      created: '2026-05-27'
    })
    expect(document.captured_at).toBe('2026-05-27T14:32:18')
    expect(document.created).toBe('2026-05-27')

    const read = await readDocument(document.id)
    expect(read!.captured_at).toBe('2026-05-27T14:32:18')
    expect(read!.created).toBe('2026-05-27')
  })

  it('falls back to now-derived timestamps when overrides absent', async () => {
    const now = new Date('2026-05-27T09:00:05.000Z')
    const { document } = await writeDocument({
      content: 'derived body',
      type: 'note',
      title: 'Derived',
      now
    })
    expect(document.captured_at).toBe('2026-05-27T09:00:05')
    expect(document.created).toBe('2026-05-27')
  })
})

describe('expected_captured_at CAS-aware write (6b)', () => {
  it('POSITIVE: write succeeds when live captured_at matches expected', async () => {
    const t0 = '2026-05-27T14:00:00'
    const first = await writeDocument({
      content: 'pending body',
      type: 'watchlist',
      title: 'CAS OK Movie',
      captured_at: t0,
      created: '2026-05-27'
    })

    // Worker WRITE-1 shape: preserve captured_at + CAS against it.
    const updated = await writeDocument({
      content: 'enriched body',
      type: 'watchlist',
      title: 'CAS OK Movie',
      captured_at: t0,
      created: '2026-05-27',
      expected_captured_at: t0
    })
    expect(updated.document.id).toBe(first.document.id)

    const read = await readDocument(first.document.id)
    expect(read!.content.trim()).toBe('enriched body')
    expect(read!.captured_at).toBe(t0) // preserved, not mutated
  })

  it('NEGATIVE: throws CasAbort and leaves the live file untouched on mismatch', async () => {
    const t0 = '2026-05-27T14:00:00'
    const t1 = '2026-05-27T15:00:00'

    await writeDocument({
      content: 'original body',
      type: 'watchlist',
      title: 'CAS Race Movie',
      captured_at: t0,
      created: '2026-05-27'
    })

    // Simulate a concurrent re-capture: same id, NEW captured_at + content.
    const recap = await writeDocument({
      content: 'recaptured fresh body',
      type: 'watchlist',
      title: 'CAS Race Movie',
      captured_at: t1,
      created: '2026-05-27'
    })

    // Worker tries to land its enrichment of the OLD content, CAS against t0.
    await expect(
      writeDocument({
        content: 'stale enriched body',
        type: 'watchlist',
        title: 'CAS Race Movie',
        captured_at: t0,
        created: '2026-05-27',
        expected_captured_at: t0
      })
    ).rejects.toBeInstanceOf(CasAbort)

    // The user's fresh re-capture must survive untouched.
    const read = await readDocument(recap.document.id)
    expect(read!.content.trim()).toBe('recaptured fresh body')
    expect(read!.captured_at).toBe(t1)

    // No leftover .tmp file.
    const tmp = path.join(BRAIN_ROOT, `${recap.document.id}.md.tmp`)
    await expect(fs.access(tmp)).rejects.toThrow()
  })

  it('ENOENT: treats a vanished target as a concurrent change → CasAbort', async () => {
    await expect(
      writeDocument({
        content: 'enriched body for missing doc',
        type: 'watchlist',
        title: 'Nonexistent Movie',
        captured_at: '2026-05-27T14:00:00',
        created: '2026-05-27',
        expected_captured_at: '2026-05-27T14:00:00'
      })
    ).rejects.toBeInstanceOf(CasAbort)
  })
})

describe('D2-A four-field watchlist schema', () => {
  it('round-trips year/kind/platform/rating through writer→reader', async () => {
    const { document } = await writeDocument({
      content: 'Titane enrichment body',
      type: 'watchlist',
      title: 'Titane',
      year: 2021,
      kind: 'movie',
      platform: 'MUBI',
      rating: 8
    })
    expect(document.year).toBe(2021)
    expect(document.kind).toBe('movie')
    expect(document.platform).toBe('MUBI')
    expect(document.rating).toBe(8)

    const read = await readDocument(document.id)
    expect(read!.year).toBe(2021)
    expect(read!.kind).toBe('movie')
    expect(read!.platform).toBe('MUBI')
    expect(read!.rating).toBe(8)
  })

  it('preserves explicit null fields (e.g. unknown year/platform)', async () => {
    const { document } = await writeDocument({
      content: 'unknown-metadata body',
      type: 'watchlist',
      title: 'Obscure Film',
      year: null,
      kind: 'tv',
      platform: null,
      rating: null
    })
    const read = await readDocument(document.id)
    expect(read!.year).toBeNull()
    expect(read!.kind).toBe('tv')
    expect(read!.platform).toBeNull()
    expect(read!.rating).toBeNull()
  })

  it('OMITS the four fields for non-watchlist captures', async () => {
    const { document } = await writeDocument({
      content: 'a note body',
      type: 'note',
      title: 'Just a note',
      // Even if a caller supplies them, the writer drops them for non-watchlist.
      year: 1999,
      kind: 'movie',
      platform: 'Netflix',
      rating: 5
    })
    expect(document.year).toBeUndefined()
    expect(document.kind).toBeUndefined()
    expect(document.platform).toBeUndefined()
    expect(document.rating).toBeUndefined()

    const read = await readDocument(document.id)
    expect(read!.year).toBeUndefined()
    expect(read!.kind).toBeUndefined()
  })

  it('reads a watchlist doc lacking the four fields without error', async () => {
    const { document } = await writeDocument({
      content: 'fieldless watchlist body',
      type: 'watchlist',
      title: 'Fieldless'
    })
    const read = await readDocument(document.id)
    expect(read).not.toBeNull()
    expect(read!.year).toBeUndefined()
    expect(read!.platform).toBeUndefined()
  })
})

describe('captureInputSchema accepts the four questions (public boundary)', () => {
  const schema = z.object(captureInputSchema).strict()

  it('parses a valid watchlist payload with the four fields', () => {
    const parsed = schema.parse({
      content: 'Add Titane to watchlist',
      type: 'watchlist',
      title: 'Titane',
      year: 2021,
      kind: 'movie',
      platform: 'MUBI',
      rating: 8
    })
    expect(parsed.kind).toBe('movie')
    expect(parsed.rating).toBe(8)
  })

  it('rejects an invalid kind', () => {
    expect(() =>
      schema.parse({
        content: 'x',
        type: 'watchlist',
        kind: 'film'
      })
    ).toThrow()
  })

  it('still rejects internal-only overrides at the boundary (strict)', () => {
    expect(() =>
      schema.parse({
        content: 'x',
        type: 'watchlist',
        captured_at: '2026-05-27T14:00:00'
      })
    ).toThrow()
    expect(() =>
      schema.parse({
        content: 'x',
        type: 'watchlist',
        expected_captured_at: '2026-05-27T14:00:00'
      })
    ).toThrow()
  })
})
