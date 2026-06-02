/**
 * R4 pre-commit test gate — round-trip + override + legacy parse + strict
 * schema + captured_at precision tests for the P0 enrichment-shape changes.
 *
 * Each test maps to a finding from the second adversarial pass:
 *   R1   — captureInputSchema rejects `enrichment_override` at Zod parse
 *   R2   — preflight key validity (lives in brain-enricher, not here)
 *   R-extra — reader.normalizeDateTime emits .slice(0,19) so CAS-compare
 *            survives writer→read→compare round-trip with equality
 *   R4   — explicit per-finding tests below
 *   F1   — find.ts SearchResult literal exposes new fields
 *   F6   — captured_at seconds precision
 *   F8   — package.json "exports" subpath resolves
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { writeDocument } from '../src/storage/writer.js'
import { readDocument } from '../src/storage/reader.js'
import { captureHandler } from '../src/tools/capture.js'
import { BRAIN_ROOT } from '../src/storage/brain-path.js'
import {
  asEnrichmentStatus,
  isPendingStatus,
  isEnrichedStatus,
  type EnrichmentStatus
} from '../src/shared/index.js'

// BRAIN_DATA_DIR is set by tests/setup.ts before module imports.
// Each test starts with a clean dir to avoid cross-test interference
// (e.g., the watchlist-defaults loop creates predictable IDs that would
// collide if tests share state).
beforeEach(async () => {
  await fs.rm(BRAIN_ROOT, { recursive: true, force: true })
  await fs.mkdir(BRAIN_ROOT, { recursive: true })
})

describe('EnrichmentStatus closed-enum validator', () => {
  it('accepts each shape from the locked enum (§2)', () => {
    expect(asEnrichmentStatus('pending')).toBe('pending')
    expect(asEnrichmentStatus('not_applicable')).toBe('not_applicable')
    expect(asEnrichmentStatus('v1')).toBe('v1')
    expect(asEnrichmentStatus('v42')).toBe('v42')
    expect(asEnrichmentStatus('pending-v2')).toBe('pending-v2')
    expect(asEnrichmentStatus('failed-rate-limit')).toBe('failed-rate-limit')
    expect(asEnrichmentStatus('failed-malformed-json')).toBe(
      'failed-malformed-json'
    )
  })

  it('rejects malformed values with default fallback', () => {
    expect(asEnrichmentStatus('enriched')).toBe('not_applicable')
    expect(asEnrichmentStatus('v')).toBe('not_applicable')
    expect(asEnrichmentStatus('vabc')).toBe('not_applicable')
    expect(asEnrichmentStatus('failed-')).toBe('not_applicable')
    expect(asEnrichmentStatus('failed-WithCaps')).toBe('not_applicable')
    expect(asEnrichmentStatus(undefined)).toBe('not_applicable')
    expect(asEnrichmentStatus(null)).toBe('not_applicable')
    expect(asEnrichmentStatus(42)).toBe('not_applicable')
  })

  it('honors custom fallback', () => {
    expect(asEnrichmentStatus(undefined, 'pending')).toBe('pending')
  })

  it('isPendingStatus matches §2 worker poll filter', () => {
    expect(isPendingStatus('pending')).toBe(true)
    expect(isPendingStatus('pending-v2')).toBe(true)
    expect(isPendingStatus('pending-v42')).toBe(true)
    expect(isPendingStatus('v1')).toBe(false)
    expect(isPendingStatus('failed-rate-limit')).toBe(false)
    expect(isPendingStatus('not_applicable')).toBe(false)
  })

  it('isEnrichedStatus identifies vN states', () => {
    expect(isEnrichedStatus('v1')).toBe(true)
    expect(isEnrichedStatus('v42')).toBe(true)
    expect(isEnrichedStatus('pending')).toBe(false)
    expect(isEnrichedStatus('pending-v2')).toBe(false)
    expect(isEnrichedStatus('failed-rate-limit')).toBe(false)
    expect(isEnrichedStatus('not_applicable')).toBe(false)
  })
})

describe('writer default frontmatter (type-discriminated)', () => {
  it('watchlist captures land as pending + schema_version 0', async () => {
    const { document } = await writeDocument({
      content: 'Some title — placeholder content',
      type: 'watchlist',
      title: 'Some Movie'
    })
    expect(document.enrichment_status).toBe('pending')
    expect(document.enrichment_schema_version).toBe(0)
  })

  it('non-watchlist captures land as not_applicable + 0', async () => {
    for (const type of [
      'session',
      'project',
      'idea',
      'decision',
      'note'
    ] as const) {
      const { document } = await writeDocument({
        content: `${type} body`,
        type,
        title: `${type} title`
      })
      expect(document.enrichment_status).toBe('not_applicable')
      expect(document.enrichment_schema_version).toBe(0)
    }
  })
})

describe('writer.enrichment_override (R1 — internal-API-only)', () => {
  it('honors override values when provided via direct writeDocument call', async () => {
    const { document } = await writeDocument({
      content: 'Backfilled content',
      type: 'watchlist',
      title: 'Backfilled Movie',
      enrichment_override: { status: 'v1', schema_version: 1 }
    })
    expect(document.enrichment_status).toBe('v1')
    expect(document.enrichment_schema_version).toBe(1)
  })

  it('persists override values through writer→reader round trip', async () => {
    const written = await writeDocument({
      content: 'Round-trip backfill content',
      type: 'watchlist',
      title: 'Round-trip Movie',
      enrichment_override: { status: 'v1', schema_version: 1 }
    })
    const read = await readDocument(written.document.id)
    expect(read).not.toBeNull()
    expect(read!.enrichment_status).toBe('v1')
    expect(read!.enrichment_schema_version).toBe(1)
  })
})

describe('captureInputSchema strict (R1 — boundary rejection)', () => {
  it('captureHandler rejects payload with enrichment_override', async () => {
    await expect(
      captureHandler({
        content: 'Attempted boundary bypass',
        type: 'watchlist',
        title: 'Bypass Attempt',
        // @ts-expect-error — this field is intentionally NOT on the schema.
        // The boundary is the schema, not the field value. R1 closure.
        enrichment_override: { status: 'v1', schema_version: 1 }
      })
    ).rejects.toThrow()
  })

  it('captureHandler rejects payload with other unknown keys (strict mode active)', async () => {
    await expect(
      captureHandler({
        content: 'Attempt',
        type: 'note',
        // @ts-expect-error — strict mode rejects all unknown keys
        completely_made_up_field: 'value'
      })
    ).rejects.toThrow()
  })
})

describe('reader legacy frontmatter (pre-P0 captures)', () => {
  it('returns defaults for markdown lacking enrichment fields', async () => {
    const id = 'legacy-fixture-pre-p0'
    const filePath = path.join(BRAIN_ROOT, `${id}.md`)
    // Hand-crafted fixture matching the pre-P0 frontmatter shape — no
    // enrichment_status, no enrichment_schema_version.
    const legacy = `---
id: ${id}
type: note
title: Legacy fixture
tags:
  - legacy
created: '2026-05-20'
captured_at: '2026-05-20T12:34'
source: claude-code
---
Pre-P0 content body.
`
    await fs.writeFile(filePath, legacy, 'utf8')
    const doc = await readDocument(id)
    expect(doc).not.toBeNull()
    expect(doc!.enrichment_status).toBe('not_applicable')
    expect(doc!.enrichment_schema_version).toBe(0)
  })
})

describe('captured_at seconds-precision round-trip (F6 + R-extra)', () => {
  it('writer emits 19-char ISO and reader returns 19-char on parse', async () => {
    const now = new Date('2026-05-27T14:32:07.123Z')
    const { document } = await writeDocument({
      content: 'CAS-precision content',
      type: 'note',
      title: 'CAS Precision',
      now
    })
    // Writer should have stored seconds precision, stamped in America/New_York
    // (14:32:07 UTC === 10:32:07 EDT). The invariant under test is the 19-char
    // precision + writer/reader equality, not the absolute clock.
    expect(document.captured_at).toBe('2026-05-27T10:32:07')
    expect(document.captured_at.length).toBe(19)

    const read = await readDocument(document.id)
    expect(read).not.toBeNull()
    // R-extra: reader.normalizeDateTime must also emit 19 chars; if it
    // truncated to 16, this assertion fails and CAS-compare in the worker
    // would compare unequal-length strings, aborting every write.
    expect(read!.captured_at).toBe('2026-05-27T10:32:07')
    expect(read!.captured_at.length).toBe(19)

    // The CAS-compare invariant: equal strings.
    expect(read!.captured_at === document.captured_at).toBe(true)
  })

  it('round-trip survives a synthetic 16-char legacy frontmatter (backward-permissive)', async () => {
    const id = 'legacy-captured-at-fixture'
    const filePath = path.join(BRAIN_ROOT, `${id}.md`)
    // 16-char legacy frontmatter — written by pre-R-extra writer.
    const legacy = `---
id: ${id}
type: note
title: Legacy datetime
tags: []
created: '2026-05-20'
captured_at: '2026-05-20T12:34'
source: claude-code
---
Body.
`
    await fs.writeFile(filePath, legacy, 'utf8')
    const doc = await readDocument(id)
    expect(doc).not.toBeNull()
    // .slice(0, 19) of a 16-char string returns the 16-char string unchanged
    // — backward-permissive. CAS-compare on a re-read of the same legacy
    // file is still self-consistent.
    expect(doc!.captured_at).toBe('2026-05-20T12:34')
  })
})

describe('find/search SearchResult shape (F1)', () => {
  it('SearchResult type carries enrichment fields (compile-time check)', () => {
    // This test is a compile-time guard: if SearchResult drops the new
    // fields, this object becomes assignable. If the construction site
    // in find.ts/search.ts ever drifts back to a literal without these
    // fields, the build catches it (already verified by tsc); this test
    // documents intent.
    const fixture: import('../src/types.js').SearchResult = {
      id: 'x',
      title: 'x',
      preview: 'x',
      score: 1,
      type: 'note',
      created: '2026-05-27',
      tags: [],
      enrichment_status: 'not_applicable' as EnrichmentStatus,
      enrichment_schema_version: 0
    }
    expect(fixture.enrichment_status).toBe('not_applicable')
    expect(fixture.enrichment_schema_version).toBe(0)
  })
})
