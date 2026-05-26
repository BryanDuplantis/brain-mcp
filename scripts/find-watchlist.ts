import { findHandler } from '../src/tools/find.js'

interface QuerySpec {
  query: string
  expect: string  // human-readable expectation, for eyeball
  topK?: number
}

const QUERIES: QuerySpec[] = [
  { query: 'body horror Fargeat aging self-destruction', expect: 'The Substance, maybe Possession' },
  { query: 'A24 slow burn psychological horror', expect: 'Hereditary, Daddy\'s Head, indie horror' },
  { query: 'korean revenge action thriller', expect: 'Officer Black Belt, Korean genre films' },
  { query: 'ensemble heist crime drama', expect: 'Roofman, heist-shaped' },
  { query: 'stand-up comedy special Netflix', expect: 'Ramy Youssef, Rachel Bloom, comedy specials' },
  { query: 'prestige limited series grief', expect: 'The Beast in Me, Mare-shaped' },
  { query: 'office workplace comedy spinoff', expect: 'The Paper (Office spinoff)' },
  { query: 'musical biopic Bob Dylan folk music', expect: 'A Complete Unknown' },
  { query: 'father son drama', expect: 'Daddy\'s Head, father-son themed' },
  { query: 'superhero crime drama Gotham', expect: 'The Penguin' },
  { query: 'AI threat techno-thriller', expect: 'Mr. Robot-shaped, Industry adjacent' },
  { query: 'japanese horror cursed videotape', expect: 'Ring' },
  { query: 'spiritual successor to Mare of Easttown', expect: 'Task (Brad Ingelsby)' },
  { query: 'Channing Tatum starring', expect: 'Roofman' },
  { query: 'Netflix true crime documentary', expect: 'Unknown Number, Anatomy of Lies' },
  { query: 'Atwood Handmaids Tale sequel Gilead', expect: 'The Testaments' },
  { query: 'paramedic emergency medicine dark comedy', expect: 'Code 3 (2025), The Pitt' },
  { query: 'Coppola epic political allegory', expect: 'Megalopolis' },
  { query: 'foreign-language Spanish magical realism', expect: 'One Hundred Years of Solitude' },
  { query: 'Michelin star chef documentary culinary', expect: 'Knife Edge: Chasing Michelin Stars' }
]

async function runQuery(spec: QuerySpec, idx: number, total: number): Promise<void> {
  const topK = spec.topK ?? 5
  const result = await findHandler({
    query: spec.query,
    type: ['watchlist'],
    topK
  })
  console.log(`\n[${idx + 1}/${total}] "${spec.query}"`)
  console.log(`  expect: ${spec.expect}`)
  if (result.status !== 'ok') {
    console.log(`  FAIL: ${result.status} — ${result.message ?? '(no message)'}`)
    return
  }
  if (result.results.length === 0) {
    console.log(`  (no results)`)
    return
  }
  for (const r of result.results) {
    const preview = r.preview.replace(/\s+/g, ' ').slice(0, 120)
    console.log(`  ${r.score.toFixed(3)}  ${r.title}`)
    console.log(`         ${preview}...`)
  }
}

async function main(): Promise<void> {
  console.log(`BRAIN_DATA_DIR: ${process.env.BRAIN_DATA_DIR ?? '(default)'}`)
  console.log(`CHROMA_URL:     ${process.env.CHROMA_URL ?? '(default)'}`)
  console.log(`\n=== ${QUERIES.length} semantic queries against watchlist corpus ===`)
  const t0 = Date.now()
  for (let i = 0; i < QUERIES.length; i++) {
    await runQuery(QUERIES[i], i, QUERIES.length)
  }
  const elapsed = (Date.now() - t0) / 1000
  console.log(`\n=== Done in ${elapsed.toFixed(1)}s (avg ${(elapsed / QUERIES.length).toFixed(1)}s/query) ===`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
