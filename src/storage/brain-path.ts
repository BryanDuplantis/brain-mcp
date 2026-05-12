import path from 'node:path'
import os from 'node:os'

export const BRAIN_ROOT: string =
  process.env.BRAIN_DATA_DIR ?? path.join(os.homedir(), 'brain')

export function brainFilePath(id: string): string {
  const root = path.resolve(BRAIN_ROOT)
  const resolved = path.resolve(root, `${id}.md`)
  if (!resolved.startsWith(root + path.sep)) {
    throw new Error(`Invalid document id: path traversal detected`)
  }
  return resolved
}

export function brainInboxDir(): string {
  return path.join(BRAIN_ROOT, 'inbox')
}
