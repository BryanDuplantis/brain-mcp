import fs from 'node:fs/promises'
import path from 'node:path'
import { brainInboxDir } from '../src/storage/brain-path.js'
import { writeDocument } from '../src/storage/writer.js'
import { readDocument, listDocumentIds } from '../src/storage/reader.js'
import { chunkDocument } from '../src/rag/chunk.js'
import { embedTexts } from '../src/rag/embed.js'
import { upsertChunks } from '../src/rag/store.js'
import type { CaptureType } from '../src/types.js'

const INBOX_EXTS = new Set(['.md', '.markdown', '.txt'])

function inferType(filename: string): CaptureType {
  const lower = filename.toLowerCase()
  if (lower.includes('session')) return 'session'
  if (lower.includes('project')) return 'project'
  if (lower.includes('decision')) return 'decision'
  if (lower.includes('idea')) return 'idea'
  return 'note'
}

async function ingestInbox(): Promise<void> {
  const dir = brainInboxDir()
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log(`[ingest-bulk] Inbox not found at ${dir} (nothing to do)`)
      return
    }
    throw err
  }

  for (const name of entries) {
    const ext = path.extname(name).toLowerCase()
    if (!INBOX_EXTS.has(ext)) continue

    const filePath = path.join(dir, name)
    const stat = await fs.lstat(filePath)
    if (!stat.isFile()) continue  // skips symlinks and directories

    const content = await fs.readFile(filePath, 'utf8')
    const title = path.basename(name, ext)
    const type = inferType(name)

    const { document, path: outPath } = await writeDocument({
      content,
      type,
      title,
      tags: ['ingested'],
      source: 'bulk'
    })
    console.log(`[ingest-bulk] stored ${document.id} → ${outPath}`)
  }
}

async function reembedAll(): Promise<void> {
  const ids = await listDocumentIds()
  console.log(`[ingest-bulk] re-embedding ${ids.length} documents`)
  for (const id of ids) {
    const doc = await readDocument(id)
    if (!doc) continue
    const chunks = chunkDocument(doc.id, doc.content)
    if (chunks.length === 0) continue
    try {
      const vectors = await embedTexts(chunks.map((c) => c.text))
      const ok = await upsertChunks(chunks, vectors)
      console.log(
        `[ingest-bulk] ${ok ? 'embedded' : 'FAILED'} ${doc.id} (${chunks.length} chunks)`
      )
    } catch (err) {
      console.error(
        `[ingest-bulk] embed error for ${doc.id}:`,
        (err as Error).message
      )
    }
  }
}

async function main(): Promise<void> {
  await ingestInbox()
  await reembedAll()
  console.log('[ingest-bulk] done')
}

main().catch((err) => {
  console.error('[ingest-bulk] fatal:', err)
  process.exit(1)
})
