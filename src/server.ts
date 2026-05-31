#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js'
import express, { type Request, type Response, type NextFunction } from 'express'

import { captureHandler, captureInputSchema } from './tools/capture.js'
import { searchHandler, searchInputSchema } from './tools/search.js'
import { recallHandler, recallInputSchema } from './tools/recall.js'
import { findHandler, findInputSchema } from './tools/find.js'
import { deleteHandler, deleteInputSchema } from './tools/delete.js'
import { FileOAuthProvider } from './auth/provider.js'
import { FileClientStore } from './auth/store.js'
import { combinedAuthMiddleware } from './auth/gate.js'
import { createConsentHandlers } from './auth/consent.js'

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
    'Retrieve a full brain document by its ID. ID format: YYYY-MM-DD-{session|project|idea|decision|note}-{slug} or watchlist-{slug}.',
    recallInputSchema,
    async (args) => {
      const result = await recallHandler(args)
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>
      }
    }
  )

  server.tool(
    'find',
    'Semantic search with optional type/source metadata filters. Use search for default knowledge retrieval; use find when you need to scope to specific capture types (e.g. ["watchlist"]) or sources, or to widen the default result count via topK. NOTE: metadata-based filtering only matches captures created from 2026-05-26 onward (P1 cutover). Earlier captures lack type/source metadata on their chunks and will not surface under a type/source filter — query them via the search tool or omit filters.',
    findInputSchema,
    async (args) => {
      const result = await findHandler(args)
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>
      }
    }
  )

  server.tool(
    'delete',
    'PERMANENTLY delete a brain document by ID — removes its markdown file AND its ChromaDB chunks. IRREVERSIBLE. Requires confirm:true (a missing or false confirm is rejected with no deletion). Single-user destructive operation — never call speculatively; only on an explicit user request to delete a specific document.',
    deleteInputSchema,
    async (args) => {
      const result = await deleteHandler(args)
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>
      }
    }
  )

  return server
}

function parseAllowedOrigins(raw: string): Set<string> {
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  )
}

// Distinct browser Origins that passed while the allowlist was empty — logged
// once each so the off-state is observable (not silent) and we can learn the real
// client Origins before populating MCP_ALLOWED_ORIGINS to enforce (H1, Option A).
const seenUnvalidatedOrigins = new Set<string>()

/**
 * Origin allowlist for /mcp. Behaviour by allowlist state (H1, Option A —
 * "enforce when set, loud when empty"; never crash-boots, never silent):
 *
 *  - allowlist EMPTY  → origin validation is OFF, but LOUD: each distinct browser
 *    Origin that passes is logged once (`origin-unvalidated`). This is the current
 *    prod reality (MCP_ALLOWED_ORIGINS=""). Populate the env var to switch to
 *    enforcement — no code change needed.
 *  - allowlist SET    → present-but-unlisted Origin is rejected (the DNS-rebinding
 *    / browser cross-site defense). Present-and-listed passes.
 *
 * A MISSING Origin always passes: non-browser MCP clients (native iOS/macOS apps,
 * the SDK HTTP client, Claude Code) don't send one and can't mount a browser
 * cross-site attack; they stay gated by combinedAuthMiddleware (Bearer/OAuth)
 * mounted immediately after. A duplicated Origin header (array) is abnormal and
 * falls through to the 403 when the allowlist is set.
 */
function originMiddleware(allowed: Set<string>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers['origin']
    if (!origin) {
      next()
      return
    }
    if (allowed.size === 0) {
      if (typeof origin === 'string' && !seenUnvalidatedOrigins.has(origin)) {
        seenUnvalidatedOrigins.add(origin)
        console.warn(
          `[brain-mcp] origin-unvalidated: MCP_ALLOWED_ORIGINS empty — passed Origin=${origin}. ` +
            'Add it (and any others) to MCP_ALLOWED_ORIGINS to enforce.'
        )
      }
      next()
      return
    }
    if (typeof origin === 'string' && allowed.has(origin)) {
      next()
      return
    }
    res.status(403).json({ error: 'Origin not allowed' })
  }
}

/**
 * HTTP transport requires the full auth stack (build "C"). Fail fast — never
 * boot into a partially-configured or open state (H1).
 */
interface HttpConfig {
  secret: string
  publicBaseUrl: string
  authorizePassword: string
  allowedOrigins: Set<string>
}

function loadHttpConfig(): HttpConfig {
  const secret = process.env.MCP_SECRET
  const publicBaseUrl = process.env.PUBLIC_BASE_URL
  const authorizePassword = process.env.OAUTH_AUTHORIZE_PASSWORD
  const allowedRedirects = process.env.OAUTH_ALLOWED_REDIRECT_URIS
  const allowedOrigins = process.env.MCP_ALLOWED_ORIGINS

  const missing: string[] = []
  if (!secret || !secret.trim()) missing.push('MCP_SECRET')
  if (!publicBaseUrl || !publicBaseUrl.trim()) missing.push('PUBLIC_BASE_URL')
  if (!authorizePassword || !authorizePassword.trim()) missing.push('OAUTH_AUTHORIZE_PASSWORD')
  if (!allowedRedirects || !allowedRedirects.trim()) missing.push('OAUTH_ALLOWED_REDIRECT_URIS')
  // MCP_ALLOWED_ORIGINS is NOT required (H1, Option A): an empty value means
  // origin validation is off — surfaced loudly at boot + per-Origin, not fatal.
  // The Bearer/OAuth gate is the real boundary; origin checks are defense-in-depth.

  if (missing.length > 0) {
    console.error(
      `[brain-mcp] FATAL: HTTP transport requires ${missing.join(', ')}. ` +
        'Refusing to start — open mode was removed in build C (H1).'
    )
    process.exit(1)
  }

  // Validated above.
  return {
    secret: secret as string,
    publicBaseUrl: (publicBaseUrl as string).replace(/\/+$/, ''),
    authorizePassword: authorizePassword as string,
    allowedOrigins: parseAllowedOrigins(allowedOrigins ?? '')
  }
}

async function runHttp(): Promise<void> {
  const config = loadHttpConfig()
  if (config.allowedOrigins.size === 0) {
    console.warn(
      '[brain-mcp] WARNING: MCP_ALLOWED_ORIGINS is empty — browser-Origin requests ' +
        'pass UNVALIDATED (each distinct Origin logged once). Non-browser clients always ' +
        'pass. Populate MCP_ALLOWED_ORIGINS to enforce the DNS-rebinding defense.'
    )
  }
  const app = express()
  // Only /mcp carries large bodies (capture content up to 100KB). The OAuth
  // routes (/token, DCR /register) take tiny payloads — cap them at 64KB so an
  // oversized auth-endpoint body can't tie up the Pi's single event loop (L1).
  // express.json is a no-op once req._body is set, so the /mcp-scoped 4MB parser
  // wins for /mcp and the 64KB default applies to everything else.
  app.use('/mcp', express.json({ limit: '4mb' }))
  app.use(express.json({ limit: '64kb' }))

  const allowed = config.allowedOrigins
  const issuerUrl = new URL(config.publicBaseUrl)
  const resourceServerUrl = new URL(`${config.publicBaseUrl}/mcp`)
  const secureCookie = issuerUrl.protocol === 'https:'

  // OAuth authorization server (build C). Provider + persistent client/refresh store.
  const provider = new FileOAuthProvider(new FileClientStore())

  // Consent gate — the single-user password that keeps H1 closed under OAuth.
  const consent = createConsentHandlers({
    password: config.authorizePassword,
    cookieKey: config.secret,
    secureCookie
  })
  // MUST precede mcpAuthRouter so /authorize is gated before the SDK handler runs.
  app.all('/authorize', consent.gate)
  app.post('/authorize/consent', express.urlencoded({ extended: false }), consent.submit)

  // SDK OAuth router: /token, DCR /register, /.well-known/* discovery.
  // clientSecretExpirySeconds:0 — non-expiring; the 30-day default would silently
  // kill the connector in a month (designed-vs-deployed landmine).
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl,
      baseUrl: issuerUrl,
      resourceServerUrl,
      scopesSupported: ['mcp:tools'],
      clientRegistrationOptions: { clientSecretExpirySeconds: 0 }
    })
  )

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'brain-mcp', version: '1.0.0' })
  })

  // RFC 9728 discovery: the 401 points OAuth clients at the protected-resource
  // metadata, which the SDK mounts at /.well-known/oauth-protected-resource<rsPath>.
  const resourceMetadataUrl = `${config.publicBaseUrl}/.well-known/oauth-protected-resource${resourceServerUrl.pathname}`
  app.use('/mcp', originMiddleware(allowed))
  app.use('/mcp', combinedAuthMiddleware(config.secret, provider, resourceMetadataUrl))

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
    console.log(`[brain-mcp] HTTP server listening on port ${port} (Bearer + OAuth)`)
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
