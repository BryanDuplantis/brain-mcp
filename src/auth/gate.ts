import crypto from 'node:crypto'
import type { Request, Response, NextFunction, RequestHandler } from 'express'
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js'

/**
 * Combined `/mcp` auth gate (build "C") — Bearer OR OAuth, no fail-open.
 *
 * Two surfaces, two credentials, one endpoint:
 *   - iOS / Claude Code send the static `Bearer ${MCP_SECRET}` (timing-safe).
 *   - claude.ai sends an OAuth access token (verified via the provider).
 *
 * Hand-rolled rather than the SDK's `requireBearerAuth`, which only knows
 * `verifyAccessToken` and cannot honor the static MCP_SECRET path.
 *
 * CRITICAL (H1): there is NO `next()`-without-auth branch. The previous
 * open-mode fall-through was the unauthenticated Sonnet-injection primitive and
 * must not exist here. MCP_SECRET is required; the server refuses to start
 * without it (see server.ts).
 *
 * `resourceMetadataUrl` (optional) is emitted on the 401 via `WWW-Authenticate:
 * Bearer ... resource_metadata="..."` (RFC 9728). This is the discovery hop an
 * OAuth client (claude.ai) follows from an unauthenticated /mcp request to find
 * the authorization server. The SDK's requireBearerAuth does this automatically;
 * our hand-rolled gate must do it too or live DCR discovery silently 404s.
 *
 * `restrictedSecret` (optional) is a SECOND static Bearer credential for a
 * delete-excluded principal (the Hermes agent). It authenticates exactly like the
 * full `secret` — same timing-safe path — but the gate stamps `req.allowDelete =
 * false` so `app.post('/mcp')` builds a server WITHOUT the `delete` tool for that
 * caller (least-privilege: the destructive capability is never even advertised to
 * Hermes). The full `secret` and the OAuth path both stamp `allowDelete = true`.
 */
export type AuthedRequest = Request & { auth?: unknown; allowDelete?: boolean }

export function combinedAuthMiddleware(
  secret: string,
  verifier: OAuthTokenVerifier,
  resourceMetadataUrl?: string,
  restrictedSecret?: string
): RequestHandler {
  const expected = `Bearer ${secret}`
  const restrictedExpected = restrictedSecret ? `Bearer ${restrictedSecret}` : undefined
  const wwwAuth = (errorCode: string, description: string): string => {
    let header = `Bearer error="${errorCode}", error_description="${description}"`
    if (resourceMetadataUrl) header += `, resource_metadata="${resourceMetadataUrl}"`
    return header
  }
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const auth = req.headers['authorization']
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
      res.set('WWW-Authenticate', wwwAuth('invalid_token', 'Missing or malformed Authorization header'))
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    // 1. Static MCP_SECRET path — full principal (cheap, constant-time, no async).
    if (
      auth.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expected))
    ) {
      ;(req as AuthedRequest).allowDelete = true
      next()
      return
    }

    // 1b. Static restricted-secret path — delete-excluded principal (Hermes).
    // Same timing-safe shape; length-guarded so a wrong-length token can't throw.
    if (
      restrictedExpected &&
      auth.length === restrictedExpected.length &&
      crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(restrictedExpected))
    ) {
      ;(req as AuthedRequest).allowDelete = false
      next()
      return
    }

    // 2. OAuth access token path (only reached when the static paths miss).
    // claude.ai is Bryan's own connector — full principal, delete allowed.
    const token = auth.slice('Bearer '.length)
    try {
      const info = await verifier.verifyAccessToken(token)
      ;(req as AuthedRequest).auth = info
      ;(req as AuthedRequest).allowDelete = true
      next()
      return
    } catch {
      res.set('WWW-Authenticate', wwwAuth('invalid_token', 'Invalid or expired access token'))
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
  }
}
