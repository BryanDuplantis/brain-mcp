/**
 * Scoped delete-excluded principal (S1): the gate accepts a SECOND static Bearer
 * credential (MCP_SECRET_HERMES) that authenticates exactly like the full secret
 * but stamps `req.allowDelete = false`, so `app.post('/mcp')` builds a server
 * WITHOUT the `delete` tool for that caller. The full secret and the OAuth path
 * stamp `allowDelete = true`.
 *
 * These tests prove the flag stamping directly. The "delete tool absent from
 * tools/list" end-to-end signal is the deploy-time behavioral acceptance gate.
 */
import { describe, it, expect } from 'vitest'
import type { Request, Response } from 'express'
import { combinedAuthMiddleware, type AuthedRequest } from '../src/auth/gate.js'

const SECRET = 'full-secret-value-aaaaaaaaaaaaaaaa'
const HERMES = 'hermes-scoped-secret-bbbbbbbbbbbb'

function mockReq(headers: Record<string, string> = {}): Request {
  return { headers } as unknown as Request
}

interface MockRes {
  statusCode: number
  body?: unknown
  headers: Record<string, string>
  status(c: number): MockRes
  json(b: unknown): MockRes
  set(n: string, v: string): MockRes
}

function mockRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    headers: {},
    status(c) {
      this.statusCode = c
      return this
    },
    json(b) {
      this.body = b
      return this
    },
    set(n, v) {
      this.headers[n] = v
      return this
    }
  }
  return res
}

const verifier = {
  async verifyAccessToken(token: string) {
    if (token === 'good-oauth-token') {
      return { token, clientId: 'client-1', scopes: ['mcp:tools'] }
    }
    throw new Error('invalid token')
  }
}

describe('combinedAuthMiddleware — scoped delete-excluded principal', () => {
  const gate = combinedAuthMiddleware(SECRET, verifier, undefined, HERMES)

  it('full MCP_SECRET → next() with allowDelete=true', async () => {
    const req = mockReq({ authorization: `Bearer ${SECRET}` })
    let nexted = false
    await gate(req, mockRes() as unknown as Response, () => {
      nexted = true
    })
    expect(nexted).toBe(true)
    expect((req as AuthedRequest).allowDelete).toBe(true)
  })

  it('MCP_SECRET_HERMES → next() with allowDelete=false (delete excluded)', async () => {
    const req = mockReq({ authorization: `Bearer ${HERMES}` })
    let nexted = false
    await gate(req, mockRes() as unknown as Response, () => {
      nexted = true
    })
    expect(nexted).toBe(true)
    expect((req as AuthedRequest).allowDelete).toBe(false)
  })

  it('valid OAuth token → next() with allowDelete=true (claude.ai is Bryan’s own surface)', async () => {
    const req = mockReq({ authorization: 'Bearer good-oauth-token' })
    let nexted = false
    await gate(req, mockRes() as unknown as Response, () => {
      nexted = true
    })
    expect(nexted).toBe(true)
    expect((req as AuthedRequest).allowDelete).toBe(true)
  })

  it('unknown bearer → 401, never nexts, allowDelete unset', async () => {
    const req = mockReq({ authorization: 'Bearer not-a-real-token' })
    const res = mockRes()
    let nexted = false
    await gate(req, res as unknown as Response, () => {
      nexted = true
    })
    expect(nexted).toBe(false)
    expect(res.statusCode).toBe(401)
    expect((req as AuthedRequest).allowDelete).toBeUndefined()
  })

  it('near-miss of the restricted secret (length differs) → 401, no throw', async () => {
    const req = mockReq({ authorization: `Bearer ${HERMES}x` })
    const res = mockRes()
    let nexted = false
    await gate(req, res as unknown as Response, () => {
      nexted = true
    })
    expect(nexted).toBe(false)
    expect(res.statusCode).toBe(401)
  })
})

describe('combinedAuthMiddleware — no restricted secret configured', () => {
  // When MCP_SECRET_HERMES is unset, the Hermes value is just an unknown token.
  const gate = combinedAuthMiddleware(SECRET, verifier, undefined, undefined)

  it('the Hermes value is rejected as an unknown bearer (401)', async () => {
    const req = mockReq({ authorization: `Bearer ${HERMES}` })
    const res = mockRes()
    let nexted = false
    await gate(req, res as unknown as Response, () => {
      nexted = true
    })
    expect(nexted).toBe(false)
    expect(res.statusCode).toBe(401)
  })

  it('full secret still allows with allowDelete=true', async () => {
    const req = mockReq({ authorization: `Bearer ${SECRET}` })
    let nexted = false
    await gate(req, mockRes() as unknown as Response, () => {
      nexted = true
    })
    expect(nexted).toBe(true)
    expect((req as AuthedRequest).allowDelete).toBe(true)
  })
})
