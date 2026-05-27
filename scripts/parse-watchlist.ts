import fs from 'node:fs/promises'
import type { WatchlistEntry } from '../src/shared/index.js'

// Re-export for backward compat — existing callers import { WatchlistEntry } from this file.
export type { WatchlistEntry }

const KEBAB_MAX = 40

function kebab(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, KEBAB_MAX)
    .replace(/-+$/, '')
}

function parseTableRow(line: string): string[] | null {
  if (!line.startsWith('|')) return null
  if (line.startsWith('|----') || line.startsWith('|-----')) return null
  if (line.includes('---')) return null
  const cells = line.split('|').slice(1, -1).map((c) => c.trim())
  if (cells.length === 0) return null
  return cells
}

function parseYear(raw: string): number | null {
  if (!raw || raw === '—' || raw === '-') return null
  const n = parseInt(raw, 10)
  return Number.isFinite(n) ? n : null
}

function parsePlatform(raw: string): string | null {
  if (!raw || raw === '—' || raw === '-') return null
  return raw
}

function parseRating(raw: string): number | null {
  if (!raw || raw === '—' || raw === '-') return null
  const n = parseFloat(raw)
  return Number.isFinite(n) ? n : null
}

export async function parseWatchlist(path: string): Promise<WatchlistEntry[]> {
  const text = await fs.readFile(path, 'utf8')
  const lines = text.split('\n')

  const entries: WatchlistEntry[] = []
  let section: 'none' | 'movies' | 'tv' = 'none'

  for (const line of lines) {
    if (line.startsWith('### Movies')) { section = 'movies'; continue }
    if (line.startsWith('### TV')) { section = 'tv'; continue }
    if (line.startsWith('## ')) { section = 'none'; continue }
    if (section === 'none') continue

    const cells = parseTableRow(line)
    if (!cells || cells.length < 4) continue
    if (cells[0] === 'Title') continue  // header row

    const [title, yr, platform, rating] = cells
    entries.push({
      title,
      year: parseYear(yr),
      kind: section === 'movies' ? 'movie' : 'tv',
      platform: parsePlatform(platform),
      rating: parseRating(rating),
      slug: ''  // assigned below
    })
  }

  // Disambiguate collisions: if a kebab(title) collides with another entry,
  // suffix all colliding entries with `-<year>`. If year still collides
  // (same title, same year — shouldn't happen but defensively), suffix with kind.
  const titleSlugCounts = new Map<string, number>()
  for (const e of entries) {
    const k = kebab(e.title)
    titleSlugCounts.set(k, (titleSlugCounts.get(k) ?? 0) + 1)
  }
  for (const e of entries) {
    const baseSlug = kebab(e.title)
    if ((titleSlugCounts.get(baseSlug) ?? 0) > 1) {
      const yearSlug = e.year ? `${baseSlug}-${e.year}` : `${baseSlug}-${e.kind}`
      e.slug = yearSlug.slice(0, KEBAB_MAX).replace(/-+$/, '')
    } else {
      e.slug = baseSlug
    }
  }

  // Final collision check — should be empty
  const finalCounts = new Map<string, WatchlistEntry[]>()
  for (const e of entries) {
    const arr = finalCounts.get(e.slug) ?? []
    arr.push(e)
    finalCounts.set(e.slug, arr)
  }
  for (const [slug, arr] of finalCounts) {
    if (arr.length > 1) {
      // Still a collision — append kind as tiebreaker
      for (const e of arr) {
        const tied = `${e.slug}-${e.kind}`
        e.slug = tied.slice(0, KEBAB_MAX).replace(/-+$/, '')
      }
      console.warn(`[parse] slug collision resolved with -kind suffix for "${slug}": ${arr.map(x => `${x.title} (${x.year})`).join(' / ')}`)
    }
  }

  return entries
}

// Standalone dry-run: print count + first 3 + collisions + sanity stats
if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2] ?? '/Users/bryanduplantis/Downloads/watchlist.md'
  parseWatchlist(path).then((entries) => {
    const movies = entries.filter((e) => e.kind === 'movie').length
    const tv = entries.filter((e) => e.kind === 'tv').length
    const withYear = entries.filter((e) => e.year != null).length
    const withPlatform = entries.filter((e) => e.platform != null).length
    const withRating = entries.filter((e) => e.rating != null).length

    console.log(`Parsed ${entries.length} entries (${movies} movies, ${tv} TV)`)
    console.log(`  with year:     ${withYear}`)
    console.log(`  with platform: ${withPlatform}`)
    console.log(`  with rating:   ${withRating}`)

    const slugs = new Set<string>()
    let dupes = 0
    for (const e of entries) {
      if (slugs.has(e.slug)) dupes++
      slugs.add(e.slug)
    }
    console.log(`  unique slugs:  ${slugs.size} (collisions: ${dupes})`)

    console.log('\nFirst 3 entries:')
    for (const e of entries.slice(0, 3)) {
      console.log(`  ${JSON.stringify(e)}`)
    }
    console.log('\nLast 3 entries:')
    for (const e of entries.slice(-3)) {
      console.log(`  ${JSON.stringify(e)}`)
    }
  })
}
