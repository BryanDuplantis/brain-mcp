const APPROX_CHARS_PER_TOKEN = 4
const TARGET_TOKENS = 500
const MAX_TOKENS = 1000
const TARGET_CHARS = TARGET_TOKENS * APPROX_CHARS_PER_TOKEN
const MAX_CHARS = MAX_TOKENS * APPROX_CHARS_PER_TOKEN

export interface Chunk {
  docId: string
  chunkIndex: number
  text: string
}

function splitOversizedParagraph(p: string): string[] {
  const parts: string[] = []
  for (let i = 0; i < p.length; i += MAX_CHARS) {
    parts.push(p.slice(i, i + MAX_CHARS))
  }
  return parts
}

export function chunkDocument(docId: string, content: string): Chunk[] {
  const paragraphs = content
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .flatMap((p) => (p.length > MAX_CHARS ? splitOversizedParagraph(p) : [p]))

  const chunks: string[] = []
  let buf = ''

  for (const p of paragraphs) {
    if (!buf) {
      buf = p
      continue
    }
    if (buf.length + 2 + p.length <= TARGET_CHARS) {
      buf = `${buf}\n\n${p}`
    } else {
      chunks.push(buf)
      buf = p
    }
  }
  if (buf) chunks.push(buf)

  return chunks.map((text, chunkIndex) => ({ docId, chunkIndex, text }))
}
