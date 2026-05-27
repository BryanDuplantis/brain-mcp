import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Anthropic from '@anthropic-ai/sdk'
import type { EnrichedEntry, Enrichment } from '../src/shared/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_PATH = path.join(__dirname, '..', 'scratch', 'watchlist-enriched.json')
const MODEL = process.env.ANTHROPIC_PRIMARY_MODEL ?? 'claude-sonnet-4-6'
const CONCURRENCY = 4
const MAX_TOKENS = 1500
const MAX_SEARCHES_PER_ENTRY = 3

const SYSTEM_PROMPT = `You enrich a movie/TV watchlist entry with structured semantic metadata for a personal RAG/embedding system. The user is Bryan, an Atlanta-based engineer. Your enrichments will be embedded and searched by genre/theme/director queries like "body horror by Fargeat", "A24-vibe slow burn", or "ensemble heist". Quality directly determines whether semantic search of the watchlist later surfaces the right title or misses it entirely.

THIS IS A SECOND-PASS RE-ENRICHMENT for entries where the first pass returned low or unknown confidence. You have a web_search tool available. USE IT — search by "<title> <year> <kind>" plus targeted modifiers (cast, director, genre, plot) as needed. Spend up to 3 searches per entry. Many of these entries are post-training-cutoff releases (2025-2026), foreign-language films, or obscure indie titles — web search is the load-bearing capability for this pass.

OUTPUT CONTRACT — STRICT JSON, NO COMMENTARY:
{
  "confidence": "high" | "medium" | "low" | "unknown",
  "genres": [1-4 lowercase tags, comma-free strings],
  "directors": [array of director names, MOVIES ONLY],
  "creators": [array of showrunner/creator names, TV ONLY],
  "cast_top": [1-3 lead actor names, billed order],
  "synopsis": "one-sentence plot description, under 200 chars",
  "themes": [1-4 thematic tags like "grief", "found family", "techno-thriller"],
  "notes": "optional short note, under 100 chars"
}

CONFIDENCE GRADING (post-web-search):
- "high" — search returned a clear, authoritative match; you have detailed plot, cast, director from results.
- "medium" — search returned partial information; some fields are best-guess inferences from sparse coverage.
- "low" — search returned ambiguous results, or the title is so new/niche that coverage is thin. Best guess flagged.
- "unknown" — search returned no useful results, the work does not appear to exist, or your searches failed to find any matching title+year+kind combination. Return empty arrays + synopsis="" + notes explaining why.

GENRE NORMS: compound tags preferred: "body horror", "psychological thriller", "ensemble heist", "stand-up comedy", "musical biopic", "neo-noir". Avoid bare "drama" — pair it ("family drama", "period drama", "war drama"). For foreign-language film, prepend locus ("korean revenge", "french-language crime", "japanese family drama", "indonesian horror").

THEME NORMS: 1-4 tags of EMOTIONAL/NARRATIVE register (NOT genre). Examples: "grief", "found family", "class conflict", "midlife crisis", "addiction", "AI threat", "cold war paranoia", "memory loss", "queer awakening", "religious extremism", "domestic abuse". Empty array is fine if no obvious theme.

CAST: max 3 leads, billed order, commonly-known names ("Demi Moore" not "Demi Moore [Elisabeth]").

EDGE CASES:
- Stand-up specials: kind=movie. genre=["stand-up comedy"]. cast=[performer]. directors=[performer or filmed-by director].
- Limited series / anthology: kind=tv. Use creators[], not directors[].
- Foreign-language unfamiliar: search by transliterated title + year + country. If results too sparse, confidence="unknown" is honest.
- Sequels/franchise: synopsis describes THIS specific entry, not the franchise.
- Documentaries: genre=["documentary"] plus topical (e.g., "true crime", "music documentary").
- Year mismatch in search results vs input: trust the input year (it came from JustWatch). If search shows year X but input says Y, note it.

OUTPUT: After all web searches and reasoning, your FINAL text content must be the JSON object alone. No prose around it, no markdown fences. First character { and last character }. If output cannot be valid JSON for any reason, return {"confidence":"unknown","genres":[],"cast_top":[],"synopsis":"","themes":[],"notes":"output error"}.`

const client = new Anthropic()

interface UsageStats {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  webSearchesUsed: number
  callCount: number
}

const usage: UsageStats = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  webSearchesUsed: 0,
  callCount: 0
}

async function reEnrichOne(entry: EnrichedEntry): Promise<Enrichment> {
  const userMsg =
    `Title: ${entry.title}\n` +
    `Year: ${entry.year ?? 'unknown'}\n` +
    `Kind: ${entry.kind}\n` +
    `Platform: ${entry.platform ?? 'unknown'}\n` +
    `Rating: ${entry.rating ?? 'unknown'}\n\n` +
    `Previous pass returned confidence="${entry.enrichment?.confidence}" with notes: "${entry.enrichment?.notes ?? '(none)'}". Re-enrich using web search.`

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
    tools: [
      {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: MAX_SEARCHES_PER_ENTRY
      } as unknown as Anthropic.Tool
    ],
    messages: [{ role: 'user', content: userMsg }]
  })

  usage.callCount++
  usage.inputTokens += resp.usage.input_tokens
  usage.outputTokens += resp.usage.output_tokens
  usage.cacheReadTokens += resp.usage.cache_read_input_tokens ?? 0
  usage.cacheWriteTokens += resp.usage.cache_creation_input_tokens ?? 0
  for (const block of resp.content) {
    if ((block as { type: string }).type === 'server_tool_use') {
      usage.webSearchesUsed++
    }
  }

  const text = resp.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('\n')

  // Find JSON containing "confidence" — prefer the last such block (final answer)
  const matches = [...text.matchAll(/\{[\s\S]*?\}/g)]
  for (let i = matches.length - 1; i >= 0; i--) {
    const cand = matches[i][0]
    if (cand.includes('"confidence"')) {
      try {
        return JSON.parse(cand) as Enrichment
      } catch {
        /* try previous */
      }
    }
  }
  // Fallback: brace-span over the whole text
  const trimmed = text.trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end >= 0) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as Enrichment
    } catch {
      /* throw below */
    }
  }
  throw new Error(`No valid JSON in response: ${text.slice(0, 300)}`)
}

async function loadState(): Promise<EnrichedEntry[]> {
  const txt = await fs.readFile(OUT_PATH, 'utf8')
  return JSON.parse(txt) as EnrichedEntry[]
}

async function saveState(entries: EnrichedEntry[]): Promise<void> {
  const tmp = OUT_PATH + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(entries, null, 2), 'utf8')
  await fs.rename(tmp, OUT_PATH)
}

async function main(): Promise<void> {
  console.log(`Model: ${MODEL}`)
  console.log(`Concurrency: ${CONCURRENCY}`)
  console.log(`Max searches/entry: ${MAX_SEARCHES_PER_ENTRY}\n`)

  const entries = await loadState()
  const targets = entries.filter(
    (e) =>
      e.enrichment?.confidence === 'low' ||
      e.enrichment?.confidence === 'unknown'
  )
  console.log(`Targets: ${targets.length} entries (low+unknown from first pass)`)
  if (targets.length === 0) {
    console.log('Nothing to do.')
    return
  }

  const startTime = Date.now()

  console.log('[warm-up] populating prompt cache with first target...')
  const first = targets[0]
  try {
    const enrichment = await reEnrichOne(first)
    const target = entries.find((e) => e.slug === first.slug)!
    target.enrichment = enrichment
    target.error = undefined
  } catch (err) {
    const target = entries.find((e) => e.slug === first.slug)!
    target.error = String(err).slice(0, 200)
  }
  await saveState(entries)
  console.log(
    `[warm-up] cache write: ${usage.cacheWriteTokens} tok, searches: ${usage.webSearchesUsed}\n`
  )

  const rest = targets.slice(1)
  let completed = 1

  for (let i = 0; i < rest.length; i += CONCURRENCY) {
    const batch = rest.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(
      batch.map((e) => reEnrichOne(e))
    )
    for (let j = 0; j < batch.length; j++) {
      const r = results[j]
      const target = entries.find((e) => e.slug === batch[j].slug)!
      if (r.status === 'fulfilled') {
        target.enrichment = r.value
        target.error = undefined
      } else {
        target.error = String(r.reason).slice(0, 200)
        // keep first-pass enrichment on failure
      }
      completed++
    }
    await saveState(entries)
    const elapsed = (Date.now() - startTime) / 1000
    const rate = completed / elapsed
    const eta = (targets.length - completed) / rate
    console.log(
      `  [${completed}/${targets.length}] ${elapsed.toFixed(0)}s, ${rate.toFixed(2)}/s, ${usage.webSearchesUsed} searches, ETA ${eta.toFixed(0)}s`
    )
  }

  // Corpus-level confidence
  const conf = new Map<string, number>()
  for (const e of entries) {
    const c = e.enrichment?.confidence ?? 'null'
    conf.set(c, (conf.get(c) ?? 0) + 1)
  }
  console.log('\n=== New confidence distribution (entire 230 corpus) ===')
  for (const k of ['high', 'medium', 'low', 'unknown']) {
    if (conf.has(k)) console.log(`  ${k.padEnd(8)}: ${conf.get(k)}`)
  }

  // Re-enriched targets, sorted by new confidence
  console.log('\n=== All 64 re-enriched targets, new state ===')
  const order: Record<string, number> = {
    high: 0,
    medium: 1,
    low: 2,
    unknown: 3
  }
  const reTargets = targets.map(
    (t) => entries.find((e) => e.slug === t.slug)!
  )
  reTargets.sort(
    (a, b) =>
      (order[a.enrichment?.confidence ?? 'unknown'] ?? 99) -
      (order[b.enrichment?.confidence ?? 'unknown'] ?? 99)
  )
  for (const e of reTargets) {
    const en = e.enrichment!
    const dirs =
      en.directors?.join(', ') || en.creators?.join(', ') || '—'
    console.log(`  ${e.title} (${e.year}, ${e.kind}, ${en.confidence})`)
    console.log(`    by:     ${dirs}`)
    console.log(`    cast:   ${en.cast_top.join(', ')}`)
    console.log(`    synop:  ${en.synopsis}`)
    if (en.themes && en.themes.length > 0)
      console.log(`    themes: ${en.themes.join(', ')}`)
    if (en.notes) console.log(`    notes:  ${en.notes}`)
  }

  console.log('\n=== Usage / Cost ===')
  console.log(`  Calls:        ${usage.callCount}`)
  console.log(`  Web searches: ${usage.webSearchesUsed}`)
  console.log(`  Input:        ${usage.inputTokens} tokens (uncached)`)
  console.log(`  Cache write:  ${usage.cacheWriteTokens} tokens`)
  console.log(`  Cache read:   ${usage.cacheReadTokens} tokens`)
  console.log(`  Output:       ${usage.outputTokens} tokens`)
  const ic = (usage.inputTokens / 1_000_000) * 3
  const oc = (usage.outputTokens / 1_000_000) * 15
  const cwc = (usage.cacheWriteTokens / 1_000_000) * 3.75
  const crc = (usage.cacheReadTokens / 1_000_000) * 0.3
  const wsc = usage.webSearchesUsed * 0.01
  const total = ic + oc + cwc + crc + wsc
  console.log(
    `  Est. cost:    $${total.toFixed(4)} (inference $${(ic + oc + cwc + crc).toFixed(4)} + searches $${wsc.toFixed(4)})`
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
