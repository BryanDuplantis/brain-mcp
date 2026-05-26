import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Anthropic from '@anthropic-ai/sdk'
import { parseWatchlist, type WatchlistEntry } from './parse-watchlist.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const WATCHLIST_PATH = '/Users/bryanduplantis/Downloads/watchlist.md'
const OUT_PATH = path.join(__dirname, '..', 'scratch', 'watchlist-enriched.json')
const MODEL = process.env.ANTHROPIC_PRIMARY_MODEL ?? 'claude-sonnet-4-6'
const CONCURRENCY = 8
const MAX_TOKENS = 600

export interface Enrichment {
  confidence: 'high' | 'medium' | 'low' | 'unknown'
  genres: string[]
  directors?: string[]
  creators?: string[]
  cast_top: string[]
  synopsis: string
  themes: string[]
  notes?: string
}

export interface EnrichedEntry extends WatchlistEntry {
  enrichment: Enrichment | null
  error?: string
}

const SYSTEM_PROMPT = `You enrich a movie/TV watchlist entry with structured semantic metadata for a personal RAG/embedding system. The user is Bryan, an Atlanta-based engineer who watches a mix of prestige drama, body horror, A24-style indie, stand-up comedy, action, and foreign-language film. Your enrichments will be embedded and searched by genre/theme/director queries like "body horror by Fargeat", "A24-vibe slow burn", or "ensemble heist". Quality here directly determines whether semantic search of the watchlist later surfaces the right title or misses it entirely.

OUTPUT CONTRACT — STRICT JSON, NO COMMENTARY:
{
  "confidence": "high" | "medium" | "low" | "unknown",
  "genres": [1-4 lowercase tags, comma-free strings],
  "directors": [array of director names, MOVIES ONLY],
  "creators": [array of showrunner/creator names, TV ONLY],
  "cast_top": [1-3 lead actor names, billed order],
  "synopsis": "one-sentence plot description, under 200 chars",
  "themes": [1-4 thematic tags like "grief", "found family", "techno-thriller"],
  "notes": "optional short note for low/unknown confidence, under 100 chars"
}

CONFIDENCE GRADING (this is the load-bearing field — get it honest, not optimistic):
- "high" — you recognize the title+year unambiguously and have detailed recall of plot, cast, and director/creator. You could describe a scene.
- "medium" — you recognize it but recall is partial; some fields may be best-guess inferred from context (e.g., you know the director but are guessing on cast).
- "low" — weak recall; you may be confusing this with a similarly-named work, or you only know the franchise but not this specific entry. Return your best guess but flag.
- "unknown" — you do not recognize this title+year combo at all. Return empty arrays, synopsis="", notes="not recognized". Empty is correct here — DO NOT INVENT.

DISAMBIGUATION RULES:
- Year + kind (movie/tv) + platform are the canonical anchors. If your recall of the title points to a different year, that's a different work — set confidence="low" and put "[year mismatch: input Y, recalled X]" in notes.
- The same title can refer to multiple distinct works (e.g., "Code 3" exists as both a 2025 movie and a 1957 TV series — both real, treat each entry independently using year+kind to identify which).
- For TV shows, "Yr" is the show's debut year — long-running shows still use the debut year.
- For movies released in late-year prestige windows (Oct-Dec), the year may be the festival/limited-release year, not wide-release.
- For foreign-language film, the year is typically the country-of-origin theatrical year, not the US release.

GENRE TAGGING NORMS (lowercase, compound when more specific):
- Prefer compound tags: "body horror", "psychological thriller", "found-footage horror", "ensemble heist", "spy thriller", "courtroom drama", "stand-up comedy", "true crime", "musical biopic", "neo-noir", "cosmic horror", "slasher".
- Avoid generic "drama" alone — pair it: "family drama", "period drama", "legal drama", "crime drama", "war drama".
- "comedy" can stand alone for traditional sitcoms; otherwise specify "dark comedy" / "cringe comedy" / "rom-com" / "satire" / "absurdist comedy".
- For foreign-language film, prepend language-locus when distinctive: "korean revenge", "french-language crime", "japanese family drama", "spanish-language thriller".
- For limited prestige series, "limited series" can be a genre tag alongside the topical one.

THEME TAGGING NORMS (these are NOT genres — they're the EMOTIONAL / NARRATIVE registers):
- Examples: "grief", "found family", "class conflict", "midlife crisis", "addiction", "AI threat", "cold war paranoia", "domestic abuse", "religious extremism", "memory loss", "father-son", "mother-daughter", "queer awakening", "post-apocalyptic survival", "media manipulation", "corporate malfeasance".
- 1-4 themes max. Skip if no obvious one — empty array is fine and better than reaching.

CAST RULES:
- cast_top is the LEAD actors only, max 3, billed order.
- Use commonly-known names ("Demi Moore" not "Demi Moore [as Elisabeth]").
- For ensembles (e.g., heist films, the big-cast prestige series), pick the billed-first three.

EDGE CASES:
- Stand-up specials: kind=movie. Genre=["stand-up comedy"]. cast_top=[performer]. directors=[performer or filmed-by director if known]. Synopsis describes the performer's angle.
- Limited series / anthology: kind=tv. Use creators[], not directors[].
- Foreign-language unfamiliar title: confidence="unknown" is the right answer. Don't invent details. Better empty than wrong.
- Sequels/franchise entries: synopsis can reference the franchise but should describe THIS entry's specific hook.
- Documentaries: genre=["documentary"] plus topical (e.g., "true crime", "music documentary", "political documentary").

OUTPUT: ONLY valid JSON. No prose, no markdown fences, no preamble. First character must be { and last character must be }. If you cannot produce valid JSON, return {"confidence":"unknown","genres":[],"cast_top":[],"synopsis":"","themes":[],"notes":"output error"}.`

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
