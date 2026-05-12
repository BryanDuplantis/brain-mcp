#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import crypto from 'node:crypto'
import express, { type Request, type Response, type NextFunction } from 'express'

import { captureHandler, captureInputSchema } from './tools/capture.js'
import { searchHandler, searchInputSchema } from './tools/search.js'
import { recallHandler, recallInputSchema } from './tools/recall.js'

function buildServer(): McpServer {
  const server = new McpServer({
    name: 'brain-mcp',
    version: '1.0.0'
  })

  server.tool(
    'capture',
    'Store a thought, decision, idea, project note, or session log in the brain. Returns whether storage and embedding succeeded.',
    captureInputSchema,
    async (args) => {
      const result = await captureHandler(args)
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>
      }
    }
  )

  server.tool(
    'search',
    'Semantic search over the brain. Returns SearchResponse with status field. status="index_unavailable" means ChromaDB is unreachable, not that there are no matches.',
    searchInputSchema,
    async (args) => {
      const result = await searchHandler(args)
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>
      }
    }
  )

  server.tool(
    'recall',
    'Retrieve a full brain document by its ID. ID format: YYYY-MM-DD-{type}-{slug}.',
    recallInputSchema,
    async (args) => {
      const result = await recallHandler(args)
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>
      }
    }
  )

  return server
}

function parseAllowedOrigins(): Set<string> | null {
  const raw = process.env.MCP_ALLOWED_ORIGINS
  if (!raw || !raw.trim()) return null
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  )
}

function authMiddleware(secret: string | undefined) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!secret) {
      // Open mode — perimeter defense is Funnel URL obscurity only.
      // Intentional trade-off for clients (e.g. claude.ai custom connectors)
      // that only support OAuth and reject arbitrary Bearer tokens.
      next()
      return
    }
    const auth = req.headers['authorization'] ?? ''
    const expected = `Bearer ${secret}`
    const match =
      auth.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expected))
    if (!match) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    next()
  }
}

function originMiddleware(allowed: Set<string> | null) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!allowed) {
      next()
      return
    }
    const origin = req.headers['origin']
    if (typeof origin === 'string' && allowed.has(origin)) {
      next()
      return
    }
    if (!origin) {
      next()
      return
    }
    res.status(403).json({ error: 'Origin not allowed' })
  }
}

async function runHttp(): Promise<void> {
  const app = express()
  app.use(express.json({ limit: '4mb' }))

  const secret = process.env.MCP_SECRET
  const allowed = parseAllowedOrigins()

  if (!secret) {
    console.warn(
      '[brain-mcp] WARNING: MCP_SECRET unset — running in OPEN mode. ' +
      'Only the Funnel URL obscurity protects this server.'
    )
  }

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'brain-mcp', version: '1.0.0' })
  })

  app.use('/mcp', originMiddleware(allowed))
  app.use('/mcp', authMiddleware(secret))

  app.post('/mcp', async (req, res) => {
    const server = buildServer()
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    })
    res.on('close', () => {
      transport.close().catch(() => undefined)
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  })

  const port = parseInt(process.env.MCP_PORT ?? '3001', 10) || 3001
  app.listen(port, () => {
    console.log(`[brain-mcp] HTTP server listening on port ${port}`)
  })
}

async function runStdio(): Promise<void> {
  const server = buildServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

function shouldUseHttp(argv: string[]): boolean {
  const i = argv.indexOf('--transport')
  if (i === -1) return false
  return argv[i + 1] === 'http'
}

async function main(): Promise<void> {
  if (shouldUseHttp(process.argv)) {
    await runHttp()
  } else {
    await runStdio()
  }
}

main().catch((err) => {
  console.error('[brain-mcp] fatal:', err)
  process.exit(1)
})
