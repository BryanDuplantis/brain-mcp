import { captureHandler } from '../src/tools/capture.js'
import { findHandler } from '../src/tools/find.js'
import { searchHandler } from '../src/tools/search.js'
import { recallHandler } from '../src/tools/recall.js'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ok   ${name}`)
    passed++
  } else {
    console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`)
    failed++
  }
}

async function main(): Promise<void> {
  console.log('=== P1 smoke: watchlist + find tool ===\n')

  console.log('[1] Capture note')
  const noteCapture = await captureHandler({
    content:
      'Death Angel at Variety Playhouse Atlanta — thrash metal headliner show. ' +
      'Bay Area thrash legacy band, 1980s formation. ' +
      'Killswitch Engage and Megadeth-era influences on the bill.',
    type: 'note',
    title: 'Death Angel at Variety Playhouse',
    tags: ['concert', 'atlanta'],
    source: 'claude-code'
  })
  check('note stored', noteCapture.stored === true)
  check('note embedded', noteCapture.embedded === true)
  check(
    'note id has date+type prefix',
    /^\d{4}-\d{2}-\d{2}-note-/.test(noteCapture.id),
    noteCapture.id
  )

  console.log('\n[2] Capture watchlist')
  const wlCapture = await captureHandler({
    content:
      'The Substance — 2024 body horror film directed by Coralie Fargeat ' +
      'starring Demi Moore. Body horror genre, Academy Award winner for ' +
      'Best Makeup. Streaming on MUBI.',
    type: 'watchlist',
    title: 'The Substance 2024 body horror Fargeat',
    tags: ['film', 'horror'],
    source: 'claude-code'
  })
  check('watchlist stored', wlCapture.stored === true)
  check('watchlist embedded', wlCapture.embedded === true)
  check(
    'watchlist id is watchlist-<slug> (no date)',
    /^watchlist-[a-z0-9-]+$/.test(wlCapture.id) &&
      !/^\d{4}-/.test(wlCapture.id),
    wlCapture.id
  )

  const noteId = noteCapture.id
  const wlId = wlCapture.id

  console.log('\n[3] find type=[watchlist]')
  const wlFind = await findHandler({
    query: 'body horror film fargeat',
    type: ['watchlist'],
    topK: 12
  })
  check('status ok', wlFind.status === 'ok', JSON.stringify(wlFind.message))
  check('returns >=1 result', wlFind.results.length >= 1)
  check(
    'all results are watchlist',
    wlFind.results.every((r) => r.type === 'watchlist'),
    'types=' + wlFind.results.map((r) => r.type).join(',')
  )
  check(
    'includes our watchlist id',
    wlFind.results.some((r) => r.id === wlId)
  )

  console.log('\n[4] find type=[note]')
  const noteFind = await findHandler({
    query: 'thrash metal concert variety playhouse',
    type: ['note'],
    topK: 12
  })
  check('status ok', noteFind.status === 'ok', JSON.stringify(noteFind.message))
  check('returns >=1 result', noteFind.results.length >= 1)
  check(
    'all results are note',
    noteFind.results.every((r) => r.type === 'note'),
    'types=' + noteFind.results.map((r) => r.type).join(',')
  )
  check(
    'includes our note id',
    noteFind.results.some((r) => r.id === noteId)
  )

  console.log('\n[5] find no filter')
  const allFind = await findHandler({
    query: 'concert horror film atlanta playhouse body',
    topK: 12
  })
  check('status ok', allFind.status === 'ok', JSON.stringify(allFind.message))
  check(
    'includes note id',
    allFind.results.some((r) => r.id === noteId),
    'ids=' + allFind.results.map((r) => r.id).join(',')
  )
  check(
    'includes watchlist id',
    allFind.results.some((r) => r.id === wlId),
    'ids=' + allFind.results.map((r) => r.id).join(',')
  )

  console.log('\n[6] search (unchanged)')
  const searchOut = await searchHandler({
    query: 'concert horror film atlanta playhouse body',
    topK: 12
  })
  check('status ok', searchOut.status === 'ok', JSON.stringify(searchOut.message))
  check(
    'includes note id',
    searchOut.results.some((r) => r.id === noteId),
    'ids=' + searchOut.results.map((r) => r.id).join(',')
  )
  check(
    'includes watchlist id',
    searchOut.results.some((r) => r.id === wlId),
    'ids=' + searchOut.results.map((r) => r.id).join(',')
  )

  console.log('\n[7] recall round-trip')
  const noteRecall = await recallHandler({ id: noteId })
  check('note found', noteRecall.found === true)
  check(
    'note title matches',
    noteRecall.document?.title === 'Death Angel at Variety Playhouse',
    String(noteRecall.document?.title)
  )
  check('note type=note', noteRecall.document?.type === 'note')

  const wlRecall = await recallHandler({ id: wlId })
  check('watchlist found', wlRecall.found === true)
  check('watchlist type=watchlist', wlRecall.document?.type === 'watchlist')

  console.log(`\n=== ${passed} passed, ${failed} failed ===`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error('Smoke crashed:', err)
  process.exit(2)
})
