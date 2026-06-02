# CLAUDE.md — brain-mcp

Agent entry point. Read this file completely before taking any action.
Do not write code, create files, or make decisions until orientation is complete.

---

## What This System Does

A personal MCP (Model Context Protocol) server that makes Bryan's accumulated
knowledge queryable by Claude across all surfaces — iOS app, macOS app, claude.ai,
and Claude Code.

**The single value proposition:** anything Bryan captures through a Claude conversation
is permanently stored, embedded, and retrievable by Claude in any future session —
without Bryan needing to remember where he put it or that it exists.

This is not a dashboard. There is no UI for browsing. Claude is the interface.

---

## Architecture

```
Claude iOS / macOS / claude.ai
           ↓
    Tailscale Funnel (public HTTPS → Pi)
    https://<pi-hostname>.<tailnet>.ts.net
           ↓
Claude Code (local)
           ↓
    stdio MCP transport (no network hop)
           ↓
    Raspberry Pi 5 (always-on)
    ├── MCP server — Streamable HTTP (port 3001)
    ├── ChromaDB   — Docker (port 8000)
    ├── ~/brain/   — markdown flat file store
    └── Embedding pipeline (Voyage AI voyage-4)
           ↑
    Mac mini M4 (on-demand)
    └── Bulk ingestion / re-embedding jobs
```

**Remote transport:** Streamable HTTP over HTTPS via Tailscale Funnel.
Funnel creates a public HTTPS endpoint (`https://<hostname>.ts.net`) that routes
to the Pi's local port. No port forwarding. No VPN required on client devices.
Automatic TLS certificates via Let's Encrypt.

**Local Claude Code transport:** stdio (faster, no network hop, spawned as child process).

**Storage:** Markdown files with YAML frontmatter + ChromaDB vectors.
**Embeddings:** Voyage AI `voyage-4` — Anthropic's recommended embedding partner.
Anthropic does not offer its own embedding model.

---

## The Three MVP Tools

These are the only tools in v1. No additions without explicit approval.

| Tool | Signature | Purpose |
|------|-----------|---------|
| `capture` | `(content: string, type: CaptureType, title?: string, tags?: string[])` | Write to ~/brain/, queue for embedding |
| `search` | `(query: string, topK?: number)` | Semantic search over embedded content |
| `recall` | `(id: string)` | Retrieve full document by ID |

**CaptureType enum:** `session` \| `project` \| `idea` \| `decision` \| `note`

**Title derivation:** if `title` is not provided, derive from first line or first
60 characters of `content`. Never require title — capture friction kills the habit.

Every other tool is v2. Do not implement `list_recent`, `summarize`, `get_project`,
or any other tool until all three MVP tools are validated end-to-end.

---

## Architecture Boundaries (Hard Rules)

| Boundary | Rule |
|----------|------|
| Ingestion source | Claude apps only. No RSS, no email, no web scrapers, no custom UI. |
| AI chat provider | Anthropic only. Model: `process.env.ANTHROPIC_PRIMARY_MODEL ?? 'claude-sonnet-4-6'` |
| Embeddings | Voyage AI `voyage-4`. Anthropic has no embedding API. Do not use OpenAI for embeddings. |
| Remote transport | Streamable HTTP over Tailscale Funnel. SSE is deprecated — do not use it for new code. |
| Local transport | stdio for Claude Code. Never HTTP for local. |
| Network exposure | Tailscale Funnel only. No raw port forwarding. No static public IP. |
| Data location | `~/brain/` on the Pi. `BRAIN_ROOT` constant is the single source of truth — never hardcode the path. |
| Vector store | ChromaDB with persistent Docker volume. In-memory fallback is dev only — never production on Pi. |
| MCP framework | Official `@modelcontextprotocol/sdk`. Do not hand-roll the protocol. |
| Auth | Bearer token via `MCP_SECRET` when set; otherwise OPEN mode (relies on Funnel URL obscurity). Open mode is the documented escape hatch for clients like claude.ai custom connectors that only support OAuth and reject arbitrary Bearer tokens. Strict mode is recommended for higher-threat environments; future v2 will add proper MCP OAuth/DCR. Origin header always validated when `MCP_ALLOWED_ORIGINS` is set. |

Violating a boundary requires explicit approval before proceeding.

---

## File Structure

```
brain-mcp/
├── CLAUDE.md               ← this file
├── FAILURE_MODES.md        ← companion, read alongside this
├── README.md               ← setup and usage
├── .mcp.json               ← project-scoped Claude Code MCP config
├── src/
│   ├── server.ts           ← MCP server entry point (stdio + Streamable HTTP)
│   ├── tools/
│   │   ├── capture.ts      ← capture tool implementation
│   │   ├── search.ts       ← search tool implementation
│   │   └── recall.ts       ← recall tool implementation
│   ├── storage/
│   │   ├── brain-path.ts   ← BRAIN_ROOT constant (import this, never hardcode)
│   │   ├── writer.ts       ← atomic markdown file writes
│   │   └── reader.ts       ← markdown file reads
│   ├── rag/
│   │   ├── embed.ts        ← Voyage AI voyage-4 embedding pipeline
│   │   ├── store.ts        ← ChromaDB client (upsert + query)
│   │   └── chunk.ts        ← document chunking (500-1000 tokens)
│   └── types.ts            ← all TypeScript interfaces
├── scripts/
│   └── ingest-bulk.ts      ← bulk ingestion for Mac mini jobs
├── .env.example
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

---

## TypeScript Interfaces (Source of Truth)

```typescript
type CaptureType = 'session' | 'project' | 'idea' | 'decision' | 'note'

interface BrainDocument {
  id: string           // YYYY-MM-DD-{type}-{title-kebab-max-40-chars}
  type: CaptureType
  title: string        // provided or derived from first 60 chars of content
  content: string
  tags: string[]
  created: string      // YYYY-MM-DD
  captured_at: string  // YYYY-MM-DDTHH:MM
  source: string       // 'ios' | 'macos' | 'claude.ai' | 'claude-code' | 'bulk'
}

interface SearchResult {
  id: string
  title: string
  preview: string      // first 200 chars of content
  score: number        // cosine similarity 0-1
  type: CaptureType
  created: string
  tags: string[]
}

interface SearchResponse {
  results: SearchResult[]
  status: 'ok' | 'index_unavailable'  // distinguish empty from broken
  message?: string                     // populated when status != 'ok'
}

interface CaptureResult {
  id: string
  stored: boolean
  embedded: boolean
  path: string
}
```

**Critical:** `search` returns `SearchResponse`, not `SearchResult[]` directly.
Empty results and unavailable index are different states. Never conflate them.

Changes to these interfaces cascade. Update `src/types.ts` first, then find all consumers.

---

## Validation Contracts

A task is not done until all relevant contracts pass.

### Tool Contract
- [ ] Tool registered in `server.ts` with correct name, description, and input schema
- [ ] Tool input validated before any file or DB operation
- [ ] Tool returns typed output matching interfaces in `src/types.ts`
- [ ] Tool failure returns structured error, never unhandled throw
- [ ] `search` returns `SearchResponse` with `status` field — never bare array

### Storage Contract
- [ ] All file paths constructed via `BRAIN_ROOT` from `src/storage/brain-path.ts`
- [ ] Writes are atomic — write to `.tmp`, then `rename()` into place
- [ ] No write completes without confirming the file exists afterward

### RAG Contract
- [ ] Capture queues embedding — document stored even if embedding fails
- [ ] Search returns `{ status: 'index_unavailable' }` if ChromaDB unreachable — never throws
- [ ] Chunk size stays within 500-1000 tokens — validate on ingest

### Security Contract
- [ ] HTTP transport validates `Authorization: Bearer <token>` on every request
- [ ] HTTP transport validates `Origin` header — rejects unknown origins
- [ ] Bearer token loaded from `MCP_SECRET` env var — never hardcoded

### Transport Contract
- [ ] Streamable HTTP transport used for remote (not SSE)
- [ ] stdio transport used for local Claude Code
- [ ] Both transports tested before declaring v1 complete

### Build Contract
- [ ] `npm run build` passes with zero errors
- [ ] `npx tsc --noEmit` passes with zero errors
- [ ] `npm test` passes (core tool logic covered)

---

## Session Start Protocol

Run at the start of every session before writing any code.

```bash
# 1. Clear Anthropic env collision (always in Claude Code)
unset ANTHROPIC_API_KEY && unset ANTHROPIC_BASE_URL

# 2. Verify ChromaDB is running
curl -s http://localhost:8000/api/v2/heartbeat && echo "Chroma: OK" || echo "Chroma: DOWN"

# 3. Establish baseline
npm run build && npx tsc --noEmit
```

State the task in one sentence before writing any code.
If you can't state it in one sentence, the task isn't defined yet.

---

## Session End Protocol

Before closing every session:

1. `npm run build && npx tsc --noEmit && npm test` — all must pass
2. State what changed, one line per file modified
3. If a new failure pattern appeared twice, add it to `FAILURE_MODES.md`
4. If a tool was completed, mark it in the MVP checklist in `README.md`

---

## Never/Always Rules

- **ALWAYS** import `{ BRAIN_ROOT }` from `src/storage/brain-path.ts` — never hardcode `~/brain/`
- **ALWAYS** stamp capture date/datetime fields via `zonedStamp(now)` in `src/storage/writer.ts` (explicit `America/New_York`), NOT `.toISOString()`. `toISOString()` is UTC, so an evening ET capture (past midnight UTC) rolled the date slug +1 day — see gotchas.md 2026-06-01. The slug, `created`, and `captured_at` must share the ET clock. Verbatim-override values (enricher 6a) pass through untouched — never round-trip them.
- **ALWAYS** store documents before embedding — stored-but-not-embedded is recoverable; the reverse is not
- **ALWAYS** return `SearchResponse` with `status` field from search — never a bare array
- **ALWAYS** use Streamable HTTP for new remote transport code — never SSE
- **ALWAYS** validate Bearer token and Origin on every HTTP request
- **NEVER** add a fourth tool without completing and validating all three MVP tools first
- **NEVER** expose MCP server without Tailscale Funnel or equivalent auth layer
- **NEVER** hardcode model strings — use `process.env.ANTHROPIC_PRIMARY_MODEL ?? 'claude-sonnet-4-6'`
- **NEVER** use OpenAI for embeddings — Voyage AI `voyage-4` only
- **NEVER** commit `.env.local` or any file containing API keys

---

## What "Done" Means

A feature is done when:
- All validation contracts pass
- `npm run build` and `npx tsc --noEmit` are clean
- The tool is callable from Claude Code via stdio
- The tool is callable from a remote Claude surface via Tailscale Funnel
- The behavior can be described in one sentence without hedging

"It works locally" is not done.
"The build passes but I haven't tested both transports" is not done.
