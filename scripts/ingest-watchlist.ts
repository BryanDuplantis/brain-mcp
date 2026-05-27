import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureHandler } from '../src/tools/capture.js'
import {
  formatContent,
  shapeTitle,
  tagsFor,
  type EnrichedEntry
} from '../src/shared/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STATE_PATH = path.join(__dirname, '..', 'scratch', 'watchlist-enriched.json')
const LOG_PATH = path.join(__dirname, '..', 'scratch', 'ingest-log.json')
const CONCURRENCY = 3

interface IngestRecord {
  id: string
  stored: boolean
  embedded: boolean
  error?: string
}

async function loadState(): Promise<EnrichedEntry[]> {
  return JSON.parse(await fs.readFile(STATE_PATH, 'utf8')) as EnrichedEntry[]
}

async function loadLog(): Promise<Record<string, IngestRecord>> {
  try {
    return JSON.parse(await fs.readFile(LOG_PATH, 'utf8')) as Record<string, IngestRecord>
  } catch {
    return {}
  }
}

async function saveLog(log: Record<string, IngestRecord>): Promise<void> {
  const tmp = LOG_PATH + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(log, null, 2), 'utf8')
  await fs.rename(tmp, LOG_PATH)
}

async function ingestOne(entry: EnrichedEntry): Promise<IngestRecord> {
  const result = await captureHandler({
    content: formatContent(entry),
    type: 'watchlist',
    title: shapeTitle(entry),
    tags: tagsFor(entry),
    source: 'bulk'
  })
  return { id: result.id, stored: result.stored, embedded: result.embedded }
}

async function main(): Promise<void> {
  console.log(`BRAIN_DATA_DIR: ${process.env.BRAIN_DATA_DIR ?? '(default)'}`)
  console.log(`CHROMA_URL:     ${process.env.CHROMA_URL ?? '(default)'}`)
  console.log(`Concurrency:    ${CONCURRENCY}\n`)

  const entries = await loadState()
  const log = await loadLog()
  const todo = entries.filter((e) => !log[e.slug] || !log[e.slug].stored)
  console.log(
    `Total: ${entries.length}, already ingested: ${entries.length - todo.length}, to ingest: ${todo.length}`
  )
  if (todo.length === 0) {
    console.log('Nothing to do.')
    return
  }

  let ok = 0
  let storeFail = 0
  let embedFail = 0
  let slugMismatch = 0
  const startTime = Date.now()

  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const batch = todo.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(batch.map((e) => ingestOne(e)))
    for (let j = 0; j < batch.length; j++) {
      const r = results[j]
      const entry = batch[j]
      const expectedId = `watchlist-${entry.slug}`
      if (r.status === 'fulfilled') {
        log[entry.slug] = r.value
        if (r.value.stored) ok++
        else storeFail++
        if (r.value.stored && !r.value.embedded) embedFail++
        if (r.value.id !== expectedId) {
          slugMismatch++
          console.warn(`  SLUG MISMATCH: ${entry.title} — expected ${expectedId}, got ${r.value.id}`)
        }
      } else {
        log[entry.slug] = { id: '', stored: false, embedded: false, error: String(r.reason).slice(0, 200) }
        storeFail++
        console.error(`  fail ${entry.slug}: ${String(r.reason).slice(0, 100)}`)
      }
    }
    await saveLog(log)
    const done = i + batch.length
    const elapsed = (Date.now() - startTime) / 1000
    const rate = done / elapsed
    const eta = (todo.length - done) / rate
    console.log(
      `  [${done}/${todo.length}] ${elapsed.toFixed(0)}s, ${rate.toFixed(1)}/s, ok=${ok} store-fail=${storeFail} embed-fail=${embedFail}, ETA ${eta.toFixed(0)}s`
    )
  }

  console.log(`\n=== Done in ${((Date.now() - startTime) / 1000).toFixed(0)}s ===`)
  console.log(`  stored:    ${ok}`)
  console.log(`  store-fail:${storeFail}`)
  console.log(`  embed-fail:${embedFail}`)
  console.log(`  slug-mismatch:${slugMismatch}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
