import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Request, Response } from 'express'
import { InvalidClientMetadataError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js'

import { combinedAuthMiddleware } from '../src/auth/gate.js'
import { FileClientStore } from '../src/auth/store.js'
import { FileOAuthProvider } from '../src/auth/provider.js'
import { __test as consent } from '../src/auth/consent.js'

const SECRET = 'super-secret-bearer-value-12345'

function mockReq(headers: Record<string, string> = {}): Request {
  return { headers } as unknown as Request
}

interface MockRes {
  statusCode: number
  body?: unknown
  redirectedTo?: string
  cookies: Record<string, string>
  headers: Record<string, string>
  status(c: number): MockRes
  json(b: unknown): MockRes
  redirect(u: string): MockRes
  cookie(n: string, v: string): MockRes
  set(n: string, v: string): MockRes
}

function mockRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    cookies: {},
    headers: {},
    status(c) {
      this.statusCode = c
      return this
    },
    json(b) {
      this.body = b
      return this
    },
    redirect(u) {
      this.redirectedTo = u
      return this
    },
    cookie(n, v) {
      this.cookies[n] = v
      return this
    },
    set(n, v) {
      this.headers[n] = v
      return this
    }
  }
  return res
}

function fakeClient(id = 'client-1'): OAuthClientInformationFull {
  return {
    client_id: id,
    client_secret: 'shh',
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback']
  } as OAuthClientInformationFull
}

// --- Combined /mcp gate ---

describe('combinedAuthMiddleware', () => {
  const verifier = {
    async verifyAccessToken(token: string) {
      if (token === 'good-oauth-token') {
        return { token, clientId: 'client-1', scopes: ['mcp:tools'] }
      }
      throw new Error('invalid token')
    }
  }
  const RMU = 'https://h.example/.well-known/oauth-protected-resource/mcp'
  const gate = combinedAuthMiddleware(SECRET, verifier, RMU)

  it('401s when Authorization header is absent (no fail-open)', async () => {
    const res = mockRes()
    let nexted = false
    await gate(mockReq(), res as unknown as Response, () => {
      nexted = true
    })
    expect(nexted).toBe(false)
    expect(res.statusCode).toBe(401)
  })

  it('emits a WWW-Authenticate header with resource_metadata on 401 (RFC 9728 discovery)', async () => {
    const res = mockRes()
    await gate(mockReq(), res as unknown as Response, () => undefined)
    expect(res.headers['WWW-Authenticate']).toContain(`resource_metadata="${RMU}"`)
  })

  it('401s on a non-Bearer header', async () => {
    const res = mockRes()
    let nexted = false
    await gate(mockReq({ authorization: 'Basic abc' }), res as unknown as Response, () => {
      nexted = true
    })
    expect(nexted).toBe(false)
    expect(res.statusCode).toBe(401)
  })

  it('allows the static MCP_SECRET bearer (iOS / Claude Code path)', async () => {
    const res = mockRes()
    let nexted = false
    await gate(
      mockReq({ authorization: `Bearer ${SECRET}` }),
      res as unknown as Response,
      () => {
        nexted = true
      }
    )
    expect(nexted).toBe(true)
    expect(res.statusCode).toBe(200)
  })

  it('allows a valid OAuth access token (claude.ai path)', async () => {
    const res = mockRes()
    let nexted = false
    await gate(
      mockReq({ authorization: 'Bearer good-oauth-token' }),
      res as unknown as Response,
      () => {
        nexted = true
      }
    )
    expect(nexted).toBe(true)
  })

  it('401s on an invalid OAuth token', async () => {
    const res = mockRes()
    let nexted = false
    await gate(
      mockReq({ authorization: 'Bearer not-a-real-token' }),
      res as unknown as Response,
      () => {
        nexted = true
      }
    )
    expect(nexted).toBe(false)
    expect(res.statusCode).toBe(401)
  })

  it('401s on a near-miss of the static secret (length differs)', async () => {
    const res = mockRes()
    let nexted = false
    await gate(
      mockReq({ authorization: `Bearer ${SECRET}x` }),
      res as unknown as Response,
      () => {
        nexted = true
      }
    )
    expect(nexted).toBe(false)
    expect(res.statusCode).toBe(401)
  })
})

// --- File-backed client / refresh store ---

describe('FileClientStore', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-oauth-test-'))
    process.env.OAUTH_ALLOWED_REDIRECT_URIS = 'https://claude.ai/api/mcp/auth_callback'
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    delete process.env.OAUTH_ALLOWED_REDIRECT_URIS
  })

  it('registers a client with an allowed redirect_uri and reads it back', async () => {
    const store = new FileClientStore(dir)
    const client = await store.registerClient(fakeClient() as never)
    expect(client.client_id).toBe('client-1')
    const got = await store.getClient('client-1')
    expect(got?.client_id).toBe('client-1')
  })

  it('rejects a redirect_uri not on the allowlist', async () => {
    const store = new FileClientStore(dir)
    const evil = {
      client_id: 'evil',
      redirect_uris: ['https://attacker.example/steal']
    } as OAuthClientInformationFull
    await expect(store.registerClient(evil as never)).rejects.toBeInstanceOf(
      InvalidClientMetadataError
    )
  })

  it('rejects all registration when the allowlist is empty', async () => {
    delete process.env.OAUTH_ALLOWED_REDIRECT_URIS
    const store = new FileClientStore(dir)
    await expect(store.registerClient(fakeClient() as never)).rejects.toBeInstanceOf(
      InvalidClientMetadataError
    )
  })

  it('persists across store instances (file-backed, survives restart)', async () => {
    const store1 = new FileClientStore(dir)
    await store1.registerClient(fakeClient('persist-me') as never)
    const store2 = new FileClientStore(dir)
    const got = await store2.getClient('persist-me')
    expect(got?.client_id).toBe('persist-me')
  })

  it('round-trips refresh tokens and deletes them', async () => {
    const store = new FileClientStore(dir)
    await store.saveRefresh('rt-1', { clientId: 'client-1', scopes: ['mcp:tools'], issuedAt: 1 })
    expect((await store.getRefresh('rt-1'))?.clientId).toBe('client-1')
    // survives a fresh instance
    const store2 = new FileClientStore(dir)
    expect((await store2.getRefresh('rt-1'))?.clientId).toBe('client-1')
    await store2.deleteRefresh('rt-1')
    expect(await store2.getRefresh('rt-1')).toBeUndefined()
  })
})

// --- Provider: codes, tokens, refresh ---

describe('FileOAuthProvider', () => {
  let dir: string
  let provider: FileOAuthProvider

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-oauth-prov-'))
    process.env.OAUTH_ALLOWED_REDIRECT_URIS = 'https://claude.ai/api/mcp/auth_callback'
    provider = new FileOAuthProvider(new FileClientStore(dir))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    delete process.env.OAUTH_ALLOWED_REDIRECT_URIS
  })

  async function authorizeAndGetCode(): Promise<string> {
    const res = mockRes()
    await provider.authorize(
      fakeClient(),
      {
        codeChallenge: 'challenge-abc',
        redirectUri: 'https://claude.ai/api/mcp/auth_callback',
        state: 'st-1',
        scopes: ['mcp:tools']
      },
      res as unknown as Response
    )
    expect(res.redirectedTo).toBeDefined()
    const url = new URL(res.redirectedTo as string)
    expect(url.searchParams.get('state')).toBe('st-1')
    const code = url.searchParams.get('code')
    expect(code).toBeTruthy()
    return code as string
  }

  it('authorize mints a code and challengeForAuthorizationCode returns the stored challenge', async () => {
    const code = await authorizeAndGetCode()
    expect(await provider.challengeForAuthorizationCode(fakeClient(), code)).toBe('challenge-abc')
  })

  it('authorize rejects an unregistered redirect_uri', async () => {
    const res = mockRes()
    await expect(
      provider.authorize(
        fakeClient(),
        {
          codeChallenge: 'x',
          redirectUri: 'https://attacker.example/cb'
        },
        res as unknown as Response
      )
    ).rejects.toThrow()
  })

  it('exchangeAuthorizationCode returns tokens, then rejects code reuse (single-use)', async () => {
    const code = await authorizeAndGetCode()
    const tokens = await provider.exchangeAuthorizationCode(fakeClient(), code)
    expect(tokens.access_token).toBeTruthy()
    expect(tokens.token_type).toBe('bearer')
    expect(tokens.expires_in).toBe(3600)
    expect(tokens.refresh_token).toBeTruthy()
    // replay must fail
    await expect(provider.exchangeAuthorizationCode(fakeClient(), code)).rejects.toThrow()
  })

  it('exchangeAuthorizationCode rejects a code issued to a different client', async () => {
    const code = await authorizeAndGetCode()
    await expect(
      provider.exchangeAuthorizationCode(fakeClient('other-client'), code)
    ).rejects.toThrow()
  })

  it('verifyAccessToken validates a freshly issued token and rejects unknown ones', async () => {
    const code = await authorizeAndGetCode()
    const tokens = await provider.exchangeAuthorizationCode(fakeClient(), code)
    const info = await provider.verifyAccessToken(tokens.access_token)
    expect(info.clientId).toBe('client-1')
    expect(info.scopes).toContain('mcp:tools')
    await expect(provider.verifyAccessToken('bogus')).rejects.toThrow()
  })

  it('exchangeRefreshToken mints a new access token and keeps the same refresh token (non-rotating)', async () => {
    const code = await authorizeAndGetCode()
    const first = await provider.exchangeAuthorizationCode(fakeClient(), code)
    const refreshed = await provider.exchangeRefreshToken(
      fakeClient(),
      first.refresh_token as string
    )
    expect(refreshed.access_token).toBeTruthy()
    expect(refreshed.access_token).not.toBe(first.access_token)
    expect(refreshed.refresh_token).toBe(first.refresh_token)
    // the new access token verifies
    expect((await provider.verifyAccessToken(refreshed.access_token)).clientId).toBe('client-1')
  })

  it('exchangeRefreshToken rejects an unknown refresh token', async () => {
    await expect(provider.exchangeRefreshToken(fakeClient(), 'nope')).rejects.toThrow()
  })
})

// --- Consent helpers ---

describe('consent cookie + rate limiting', () => {
  const KEY = 'cookie-signing-key'
  // H-1: signConsent/verifyConsent now bind to OAuth params. These pre-existing
  // tests pass a CONSISTENT params object on both sides so they keep isolating
  // mac-tamper / expiry / wrong-key. Param-mismatch rejection is covered in
  // tests/consent.test.ts.
  const PARAMS = {
    client_id: 'client-1',
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    code_challenge: 'abc123'
  }

  it('signs and verifies a consent cookie', () => {
    const now = 1_000_000
    const cookie = consent.signConsent(KEY, PARAMS, now)
    expect(consent.verifyConsent(KEY, cookie, PARAMS, now + 1000)).toBe(true)
  })

  it('rejects a tampered cookie', () => {
    const cookie = consent.signConsent(KEY, PARAMS, 1_000_000)
    expect(consent.verifyConsent(KEY, cookie + 'x', PARAMS, 1_000_001)).toBe(false)
  })

  it('rejects an expired cookie', () => {
    const now = 1_000_000
    const cookie = consent.signConsent(KEY, PARAMS, now)
    expect(consent.verifyConsent(KEY, cookie, PARAMS, now + 10 * 60_000)).toBe(false)
  })

  it('rejects a cookie signed with a different key', () => {
    const cookie = consent.signConsent(KEY, PARAMS, 1_000_000)
    expect(consent.verifyConsent('other-key', cookie, PARAMS, 1_000_001)).toBe(false)
  })

  it('parses a Cookie header', () => {
    expect(consent.parseCookies('a=1; brain_oauth_consent=xyz')).toEqual({
      a: '1',
      brain_oauth_consent: 'xyz'
    })
  })

  it('FailureWindow locks out after the max and resets', () => {
    const w = new consent.FailureWindow()
    const now = 5_000_000
    for (let i = 0; i < 5; i++) w.record(now)
    expect(w.lockedOut(now)).toBe(true)
    w.reset()
    expect(w.lockedOut(now)).toBe(false)
  })

  it('FailureWindow expires old failures outside the window', () => {
    const w = new consent.FailureWindow()
    const t0 = 5_000_000
    for (let i = 0; i < 5; i++) w.record(t0)
    // 16 minutes later, all are outside the 15-min window
    expect(w.lockedOut(t0 + 16 * 60_000)).toBe(false)
  })
})
