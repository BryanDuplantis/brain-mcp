import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Anthropic from '@anthropic-ai/sdk'
import { parseWatchlist } from './parse-watchlist.js'
import {
  SYSTEM_PROMPT,
  type Enrichment,
  type EnrichedEntry,
  type WatchlistEntry
} from '../src/shared/index.js'

// Re-export for callers (e.g., ingest-watchlist.ts) that import via this file.
export type { Enrichment, EnrichedEntry } from '../src/shared/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const WATCHLIST_PATH = path.join(process.env.HOME ?? '', 'Downloads', 'watchlist.md')
const OUT_PATH = path.join(__dirname, '..', 'scratch', 'watchlist-enriched.json')
const MODEL = process.env.ANTHROPIC_PRIMARY_MODEL ?? 'claude-sonnet-4-6'
const CONCURRENCY = 8
const MAX_TOKENS = 600

const client = new Anthropic()

interface UsageStats {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  callCount: number
}

const usage: UsageStats = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  callCount: 0
}

async function enrichOne(entry: WatchlistEntry): Promise<Enrichment> {
  const userMsg = `Title: ${entry.title}\nYear: ${entry.year ?? 'unknown'}\nKind: ${entry.kind}\nPlatform: ${entry.platform ?? 'unknown'}\nRating: ${entry.rating ?? 'unknown'}`

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' }
      }
    ],
    messages: [{ role: 'user', content: userMsg }]
  })

  usage.callCount++
  usage.inputTokens += resp.usage.input_tokens
  usage.outputTokens += resp.usage.output_tokens
  usage.cacheReadTokens += resp.usage.cache_read_input_tokens ?? 0
  usage.cacheWriteTokens += resp.usage.cache_creation_input_tokens ?? 0

  const text = resp.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('')

  const trimmed = text.trim()
  const jsonStart = trimmed.indexOf('{')
  const jsonEnd = trimmed.lastIndexOf('}')
  if (jsonStart < 0 || jsonEnd < 0) {
    throw new Error(`No JSON in response: ${trimmed.slice(0, 200)}`)
  }
  return JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1)) as Enrichment
}

async function loadState(): Promise<EnrichedEntry[]> {
  try {
    const txt = await fs.readFile(OUT_PATH, 'utf8')
    return JSON.parse(txt) as EnrichedEntry[]
  } catch {
    return []
  }
}

async function saveState(entries: EnrichedEntry[]): Promise<void> {
  const tmp = OUT_PATH + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(entries, null, 2), 'utf8')
  await fs.rename(tmp, OUT_PATH)
}

function fallbackEnrichment(reason: string): Enrichment {
  return {
    confidence: 'unknown',
    genres: [],
    cast_top: [],
    synopsis: '',
    themes: [],
    notes: reason.slice(0, 100)
  }
}

function printReport(entries: EnrichedEntry[]): void {
  const conf = new Map<string, number>()
  for (const e of entries) {
    const c = e.enrichment?.confidence ?? 'null'
    conf.set(c, (conf.get(c) ?? 0) + 1)
  }
  console.log('\n=== Confidence distribution ===')
  for (const k of ['high', 'medium', 'low', 'unknown', 'null']) {
    if (conf.has(k)) console.log(`  ${k.padEnd(8)}: ${conf.get(k)}`)
  }

  const real = entries.filter(
    (e) => e.enrichment && e.enrichment.confidence !== 'unknown'
  )
  const sample = real
    .map((e) => ({ e, sort: Math.random() }))
    .sort((a, b) => a.sort - b.sort)
    .slice(0, 20)
    .map((x) => x.e)
  console.log('\n=== 20 random samples (spot-check eyeball) ===')
  for (const e of sample) {
    const en = e.enrichment!
    const dirs =
      en.directors?.join(', ') || en.creators?.join(', ') || '—'
    console.log(`  ${e.title} (${e.year}, ${e.kind}, ${en.confidence})`)
    console.log(`    genres: ${en.genres.join(', ')}`)
    console.log(`    by:     ${dirs}`)
    console.log(`    cast:   ${en.cast_top.join(', ')}`)
    console.log(`    synop:  ${en.synopsis}`)
    if (en.themes.length > 0) console.log(`    themes: ${en.themes.join(', ')}`)
    if (en.notes) console.log(`    notes:  ${en.notes}`)
  }

  const unknowns = entries.filter(
    (e) => e.enrichment?.confidence === 'unknown'
  )
  if (unknowns.length > 0) {
    console.log(`\n=== ${unknowns.length} entries flagged 'unknown' ===`)
    for (const e of unknowns) {
      console.log(
        `  ${e.title} (${e.year}, ${e.kind}, ${e.platform ?? '—'})`
      )
    }
  }

  const lows = entries.filter((e) => e.enrichment?.confidence === 'low')
  if (lows.length > 0) {
    console.log(`\n=== ${lows.length} entries flagged 'low' ===`)
    for (const e of lows) {
      const en = e.enrichment!
      console.log(
        `  ${e.title} (${e.year}, ${e.kind}) — ${en.notes ?? '(no note)'}`
      )
    }
  }

  console.log('\n=== Usage / Cost ===')
  console.log(`  Calls:        ${usage.callCount}`)
  console.log(`  Input:        ${usage.inputTokens} tokens (uncached)`)
  console.log(`  Cache write:  ${usage.cacheWriteTokens} tokens`)
  console.log(`  Cache read:   ${usage.cacheReadTokens} tokens`)
  console.log(`  Output:       ${usage.outputTokens} tokens`)
  // Sonnet 4.6 pricing: $3/M input, $15/M output, $3.75/M cache write, $0.30/M cache read
  const inputCost = (usage.inputTokens / 1_000_000) * 3
  const outputCost = (usage.outputTokens / 1_000_000) * 15
  const cacheWriteCost = (usage.cacheWriteTokens / 1_000_000) * 3.75
  const cacheReadCost = (usage.cacheReadTokens / 1_000_000) * 0.3
  const total = inputCost + outputCost + cacheWriteCost + cacheReadCost
  console.log(`  Est. cost:    $${total.toFixed(4)}`)
}

async function main(): Promise<void> {
  console.log(`Model: ${MODEL}`)
  console.log(`Concurrency: ${CONCURRENCY}`)
  console.log(`Output: ${OUT_PATH}\n`)

  const fresh = await parseWatchlist(WATCHLIST_PATH)
  const existing = await loadState()
  const bySlug = new Map(existing.map((e) => [e.slug, e]))

  const merged: EnrichedEntry[] = fresh.map((f) => {
    const prev = bySlug.get(f.slug)
    return prev?.enrichment != null
      ? { ...f, enrichment: prev.enrichment }
      : { ...f, enrichment: null }
  })

  await saveState(merged)

  const todo = merged.filter((m) => m.enrichment == null)
  console.log(
    `Total: ${merged.length}, already enriched: ${merged.length - todo.length}, to enrich: ${todo.length}`
  )

  if (todo.length === 0) {
    console.log('Nothing to do.')
    printReport(merged)
    return
  }

  const startTime = Date.now()

  // Warm-up: serially process first entry to populate prompt cache before parallel batches
  console.log('\n[warm-up] populating prompt cache with first entry...')
  const warmupEntry = todo[0]
  try {
    warmupEntry.enrichment = await enrichOne(warmupEntry)
  } catch (err) {
    warmupEntry.error = String(err).slice(0, 200)
    warmupEntry.enrichment = fallbackEnrichment('warm-up crashed: ' + String(err).slice(0, 80))
  }
  await saveState(merged)
  console.log(`[warm-up] done — cache write: ${usage.cacheWriteTokens} tok\n`)

  const rest = todo.slice(1)
  let completed = 1

  for (let i = 0; i < rest.length; i += CONCURRENCY) {
    const batch = rest.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(batch.map((e) => enrichOne(e)))
    for (let j = 0; j < batch.length; j++) {
      const r = results[j]
      const target = merged.find((m) => m.slug === batch[j].slug)!
      if (r.status === 'fulfilled') {
        target.enrichment = r.value
      } else {
        target.error = String(r.reason).slice(0, 200)
        target.enrichment = fallbackEnrichment('call failed: ' + String(r.reason).slice(0, 80))
      }
      completed++
    }
    await saveState(merged)
    const elapsed = (Date.now() - startTime) / 1000
    const rate = completed / elapsed
    const eta = (todo.length - completed) / rate
    console.log(
      `  [${completed}/${todo.length}] ${elapsed.toFixed(0)}s elapsed, ${rate.toFixed(1)}/s, ETA ${eta.toFixed(0)}s`
    )
  }

  console.log(`\nDone in ${((Date.now() - startTime) / 1000).toFixed(0)}s`)
  printReport(merged)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
