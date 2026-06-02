# Session Brief: brain-mcp MVP Build

Read CLAUDE.md and FAILURE_MODES.md first. This brief governs this session only.

---

## Mission

Build the three MVP tools end-to-end. Both transports working before this session ends.
Nothing else.

---

## Step 1 — Environment and Baseline

```bash
# Always first in Claude Code
unset ANTHROPIC_API_KEY && unset ANTHROPIC_BASE_URL

# Verify ChromaDB (v2 endpoint)
curl -s http://localhost:8000/api/v2/heartbeat && echo "Chroma: OK" || echo "Chroma: DOWN — start Docker first"

# Initialize if new repo
npm init -y
npm install @modelcontextprotocol/sdk @anthropic-ai/sdk voyageai chromadb gray-matter
npm install -D typescript @types/node vitest ts-node
```

**`tsconfig.json`:**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*", "scripts/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

---

## Step 2 — Types First

Create `src/types.ts` before any other file. Every other file imports from here.

```typescript
export type CaptureType = 'session' | 'project' | 'idea' | 'decision' | 'note'

export interface BrainDocument {
  id: string           // YYYY-MM-DD-{type}-{title-kebab-max-40-chars}
  type: CaptureType
  title: string
  content: string
  tags: string[]
  created: string      // YYYY-MM-DD
  captured_at: string  // YYYY-MM-DDTHH:MM
  source: string
}

export interface SearchResult {
  id: string
  title: string
  preview: string      // first 200 chars
  score: number
  type: CaptureType
  created: string
  tags: string[]
}

// CRITICAL: always return this, never bare SearchResult[]
// Empty results and unavailable index are different states
export interface SearchResponse {
  results: SearchResult[]
  status: 'ok' | 'index_unavailable'
  message?: string
}

export interface CaptureResult {
  id: string
  stored: boolean
  embedded: boolean
  path: string
}
```

---

## Step 3 — Storage Layer

**`src/storage/brain-path.ts`:**
```typescript
import path from 'path'
import os from 'os'

export const BRAIN_ROOT = process.env.BRAIN_DATA_DIR
  ?? path.join(os.homedir(), 'brain')
```

**`src/storage/writer.ts`** — atomic markdown writes:
- Generate ID: `YYYY-MM-DD-{type}-{title-kebab-max-40-chars}`
- Derive title from first line or first 60 chars if not provided
- Write frontmatter + content using `gray-matter`
- Atomic write: `.tmp` file → `rename()` into place
- Confirm file exists after write before returning success

**`src/storage/reader.ts`** — markdown reads:
- Read by ID, construct path via `BRAIN_ROOT`
- Parse frontmatter with `gray-matter`
- Handle `gray-matter` Date auto-parse: `.toISOString().slice(0, 10)` before returning
- Return typed `BrainDocument`

Validate before moving on:
```bash
npx tsc --noEmit
```

---

## Step 4 — RAG Layer

Build in order. Validate each before the next.

**`src/rag/chunk.ts`**
- Split content into ~500-token chunks by paragraph
- Preserve `docId`, `chunkIndex`, `text` per chunk
- No chunk exceeds 1000 tokens

**`src/rag/embed.ts`** — Voyage AI embeddings:
```typescript
import VoyageAI from 'voyageai'

const client = new VoyageAI({ apiKey: process.env.VOYAGE_API_KEY })

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const result = await client.embed({
    input: texts,
    model: 'voyage-4',
    inputType: 'document'
  })
  return result.embeddings
}

export async function embedQuery(query: string): Promise<number[]> {
  const result = await client.embed({
    input: [query],
    model: 'voyage-4',
    inputType: 'query'  // different input_type for queries vs documents
  })
  return result.embeddings[0]
}
```

Note: Voyage uses different `inputType` for documents (`'document'`) vs queries
(`'query'`). This distinction improves retrieval quality — do not unify them.

**`src/rag/store.ts`** — ChromaDB client:
- `upsert(docId, chunks, vectors)` — upsert to collection
- `query(vector, topK)` — returns `{ results: RawResult[], available: boolean }`
- On ChromaDB error: return `{ results: [], available: false }` and log warning
- Never throw — caller decides what to do with unavailability

**Validate:**
```bash
npx tsc --noEmit && npm test
```

---

## Step 5 — Tool Implementations

One tool at a time. Validate after each. Commit after each.

---

### capture tool (`src/tools/capture.ts`)

**Input:** `{ content: string, type: CaptureType, title?: string, tags?: string[] }`

**Logic:**
1. Validate: `content` required, `type` must be valid `CaptureType`
2. Derive title: use `title` if provided, else first line or first 60 chars of content
3. Write to `~/brain/` via `writer.ts` — **store first**
4. If store succeeds: chunk and embed via Voyage AI asynchronously
5. Return `CaptureResult` with both `stored` and `embedded` status

**Critical:** if embedding fails, return `{ stored: true, embedded: false }` —
do not fail the capture. Storage is the priority. Embedding is recoverable.

```bash
# Validate
npx tsc --noEmit && npm run build
# Commit
git add -A && git commit -m "feat: capture tool"
```

---

### search tool (`src/tools/search.ts`)

**Input:** `{ query: string, topK?: number }`

**Logic:**
1. Embed the query via `embedQuery()` (uses `inputType: 'query'`)
2. Call `store.query()` — check `available` field in response
3. If `available: false`: return `{ status: 'index_unavailable', results: [], message: 'ChromaDB unreachable' }`
4. If `available: true`: map results to `SearchResult[]`, return `{ status: 'ok', results: [...] }`
5. Sort results by score descending

**Never** return a bare array. Always return `SearchResponse`.

```bash
npx tsc --noEmit && npm run build
git add -A && git commit -m "feat: search tool"
```

---

### recall tool (`src/tools/recall.ts`)

**Input:** `{ id: string }`

**Logic:**
1. Validate ID format (non-empty string)
2. Construct file path from ID via `BRAIN_ROOT`
3. Read and parse via `reader.ts`
4. If file not found: return structured error object, not a throw
5. Return full `BrainDocument`

```bash
npx tsc --noEmit && npm run build
git add -A && git commit -m "feat: recall tool"
```

---

## Step 6 — MCP Server

**`src/server.ts`** — registers tools, handles both transports:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import express from 'express'

const server = new McpServer({
  name: 'brain-mcp',
  version: '1.0.0'
})

// Register tools
server.tool('capture', captureSchema, captureHandler)
server.tool('search', searchSchema, searchHandler)
server.tool('recall', recallSchema, recallHandler)

const useHttp = process.argv.includes('--transport')
  && process.argv[process.argv.indexOf('--transport') + 1] === 'http'

if (useHttp) {
  const app = express()
  app.use(express.json())

  // Auth middleware — validate Bearer token
  app.use((req, res, next) => {
    const auth = req.headers['authorization']
    const secret = process.env.MCP_SECRET
    if (secret && auth !== `Bearer ${secret}`) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    next()
  })

  // Health endpoint
  app.get('/health', (_, res) => res.json({ status: 'ok' }))

  // Streamable HTTP MCP endpoint
  app.post('/mcp', async (req, res) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  })

  const port = parseInt(process.env.MCP_PORT ?? '3001')
  app.listen(port, () => console.log(`brain-mcp HTTP server on port ${port}`))
} else {
  // stdio for Claude Code
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
```

Note: `StreamableHTTPServerTransport` is the correct transport class — not
`SSEServerTransport`. SSE is deprecated.

```bash
npm install express @types/express
npm run build

# Test stdio
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node dist/server.js

# Test HTTP (background)
node dist/server.js --transport http &
curl http://localhost:3001/health
# Kill background process after test
```

```bash
git add -A && git commit -m "feat: MCP server stdio and Streamable HTTP transports"
```

---

## Step 7 — Claude Code Integration

**Create `.mcp.json` in repo root** (project-scoped, works for anyone with the repo):
```json
{
  "mcpServers": {
    "brain-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["dist/server.js"],
      "env": {
        "BRAIN_DATA_DIR": "/Users/<user>/brain",
        "CHROMA_URL": "http://<pi-tailscale-ip>:8000",
        "VOYAGE_API_KEY": "<your-voyage-key>",
        "ANTHROPIC_PRIMARY_MODEL": "claude-sonnet-4-6"
      }
    }
  }
}
```

Restart Claude Code. Verify with `/mcp` — brain-mcp should show Connected with 3 tools.

**Run end-to-end test:**
```
1. capture("MVP build session. brain-mcp v1 tools working.", "session", undefined, ["brain-mcp", "mvp"])
2. search("brain-mcp MVP")    → status: 'ok', results contains step 1
3. recall("<id from step 1>") → full document returned
```

---

## Step 8 — Deploy to Pi and Test Remote Transport

```bash
# On Pi
git pull && npm install && npm run build
sudo systemctl restart brain-mcp
sudo systemctl status brain-mcp

# Enable Funnel (first time)
tailscale funnel --bg 3001
tailscale funnel status
# Note the public URL: https://<pi-hostname>.ts.net

# Test public endpoint
curl https://<pi-hostname>.ts.net/health
```

Add remote connector in Claude app settings:
```
URL:   https://<pi-hostname>.<tailnet>.ts.net/mcp
Token: <MCP_SECRET value>
```

Run the same three-step test sequence from Claude iOS or macOS app.
Both transports must pass before the session is declared complete.

---

## Done Criteria

- [ ] `capture` stores to `~/brain/` → `{ stored: true }`
- [ ] `capture` embeds via Voyage AI → `{ embedded: true }` when Chroma up
- [ ] `capture` returns `{ stored: true, embedded: false }` gracefully when Chroma down
- [ ] `search` returns `{ status: 'ok', results: [...] }` for known content
- [ ] `search` returns `{ status: 'index_unavailable' }` when Chroma down
- [ ] `recall` returns full document for valid ID
- [ ] `recall` returns structured error (not throw) for invalid ID
- [ ] `npm run build` clean
- [ ] `npx tsc --noEmit` clean
- [ ] `npm test` passing
- [ ] stdio transport tested from Claude Code (`/mcp` shows Connected)
- [ ] Streamable HTTP transport tested from remote Claude app via Tailscale Funnel
- [ ] Pi systemd service running, restarts on reboot
- [ ] Nightly rsync backup configured

---

## Session End

1. `npm run build && npx tsc --noEmit && npm test` — all must pass
2. State each tool completed
3. State transport status: stdio / Streamable HTTP / both
4. State Pi deployment status
5. Update MVP checklist in README.md
6. Note anything deferred to v2
