import crypto from 'node:crypto'
import type { Request, Response, NextFunction, RequestHandler } from 'express'

/**
 * Single-user consent gate for the OAuth `/authorize` endpoint (build "C").
 *
 * THIS is the control that keeps H1 closed under OAuth: DCR `/register` is open,
 * but a registered client still cannot mint a token without a human passing the
 * password here. We never auto-approve.
 *
 * Flow:
 *   1. claude.ai opens GET /authorize?...  → gate() sees no consent cookie →
 *      renders a password form whose hidden fields carry the original OAuth
 *      params; the form POSTs to /authorize/consent.
 *   2. submit() timing-safe-checks the password (rate-limited, constant delay),
 *      sets a short-lived signed httpOnly cookie, and 302s back to
 *      /authorize?<original params>.
 *   3. GET /authorize?... now carries the cookie → gate() calls next() → the
 *      SDK's mcpAuthRouter authorize handler does all real OAuth validation
 *      (client, redirect_uri exact-match, PKCE) and mints the code.
 *
 * The cookie only proves "the human authenticated recently" — the access token
 * still requires the auth code + PKCE + client auth at /token.
 */

const COOKIE_NAME = 'brain_oauth_consent'
const COOKIE_TTL_MS = 5 * 60_000 // 5 min
const RATE_WINDOW_MS = 15 * 60_000 // 15 min
const RATE_MAX_FAILURES = 5
const CONSTANT_DELAY_MS = 250 // blunt brute-force + timing oracle

export interface ConsentConfig {
  /** OAUTH_AUTHORIZE_PASSWORD — the single-user gate secret. */
  password: string
  /** Key for signing the consent cookie (MCP_SECRET). */
  cookieKey: string
  /** Set the cookie Secure flag (true when PUBLIC_BASE_URL is https). */
  secureCookie: boolean
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    if (k) out[k] = decodeURIComponent(v)
  }
  return out
}

function timingSafeStrEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

function signConsent(key: string, now: number = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ exp: now + COOKIE_TTL_MS })).toString('base64url')
  const mac = crypto.createHmac('sha256', key).update(payload).digest('base64url')
  return `${payload}.${mac}`
}

function verifyConsent(key: string, value: string | undefined, now: number = Date.now()): boolean {
  if (!value) return false
  const dot = value.indexOf('.')
  if (dot === -1) return false
  const payload = value.slice(0, dot)
  const mac = value.slice(dot + 1)
  const expected = crypto.createHmac('sha256', key).update(payload).digest('base64url')
  if (!timingSafeStrEqual(mac, expected)) return false
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: number
    }
    return typeof parsed.exp === 'number' && parsed.exp > now
  } catch {
    return false
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * In-memory failure counter. Single-user → a global window is sufficient and
 * simpler than per-IP (and the Funnel collapses source IPs anyway).
 */
class FailureWindow {
  private failures: number[] = []
  record(now: number = Date.now()): void {
    this.failures.push(now)
  }
  lockedOut(now: number = Date.now()): boolean {
    this.failures = this.failures.filter((t) => t > now - RATE_WINDOW_MS)
    return this.failures.length >= RATE_MAX_FAILURES
  }
  reset(): void {
    this.failures = []
  }
}

function renderForm(
  res: Response,
  params: Record<string, string>,
  opts: { error?: boolean } = {}
): void {
  const hidden = Object.entries(params)
    .map(
      ([k, v]) =>
        `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`
    )
    .join('\n      ')
  const errBanner = opts.error
    ? '<p class="err">Incorrect password.</p>'
    : ''
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>brain-mcp — authorize</title>
<style>
  body{font-family:system-ui,sans-serif;background:#fafaf7;color:#1c1917;display:flex;
    min-height:100vh;align-items:center;justify-content:center;margin:0}
  form{background:#fff;border:1px solid #e7e5e4;border-radius:10px;padding:2rem;
    width:320px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
  h1{font-size:1.1rem;margin:0 0 .25rem}
  p.sub{color:#78716c;font-size:.85rem;margin:0 0 1.25rem}
  label{display:block;font-size:.8rem;color:#57534e;margin-bottom:.35rem}
  input[type=password]{width:100%;box-sizing:border-box;padding:.6rem;border:1px solid #d6d3d1;
    border-radius:6px;font-size:1rem}
  button{margin-top:1rem;width:100%;padding:.65rem;background:#7a1e1e;color:#fff;border:0;
    border-radius:6px;font-size:.95rem;cursor:pointer}
  .err{color:#7a1e1e;font-size:.85rem;margin:0 0 1rem}
</style></head>
<body>
  <form method="POST" action="/authorize/consent" autocomplete="off">
    <h1>Authorize connector</h1>
    <p class="sub">brain-mcp wants to grant a connector access to your brain.</p>
    ${errBanner}
    <label for="password">Authorization password</label>
    <input id="password" type="password" name="password" autofocus required>
    ${hidden}
    <button type="submit">Authorize</button>
  </form>
</body></html>`)
}

export interface ConsentHandlers {
  gate: RequestHandler
  submit: RequestHandler
}

export function createConsentHandlers(config: ConsentConfig): ConsentHandlers {
  const failures = new FailureWindow()

  const cookieOpts = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.secureCookie,
    maxAge: COOKIE_TTL_MS,
    path: '/'
  }

  const gate: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
    const cookies = parseCookies(req.headers.cookie)
    if (verifyConsent(config.cookieKey, cookies[COOKIE_NAME])) {
      next()
      return
    }
    // No valid consent → render the password form, preserving OAuth params so
    // the post-consent redirect can rebuild the /authorize request.
    const source = (req.method === 'POST' ? req.body : req.query) as Record<string, unknown>
    const params: Record<string, string> = {}
    for (const [k, v] of Object.entries(source ?? {})) {
      if (k === 'password') continue
      if (typeof v === 'string') params[k] = v
    }
    renderForm(res, params)
  }

  const submit: RequestHandler = async (req: Request, res: Response): Promise<void> => {
    await sleep(CONSTANT_DELAY_MS)
    const body = (req.body ?? {}) as Record<string, unknown>
    const submitted = typeof body.password === 'string' ? body.password : ''

    // Rebuild the OAuth params (everything but the password) for re-issue / re-render.
    const params: Record<string, string> = {}
    for (const [k, v] of Object.entries(body)) {
      if (k === 'password') continue
      if (typeof v === 'string') params[k] = v
    }

    if (failures.lockedOut()) {
      res.status(429)
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Retry-After', '900')
      res.send('Too many failed attempts. Try again later.')
      return
    }

    if (!timingSafeStrEqual(submitted, config.password)) {
      failures.record()
      res.status(401)
      renderForm(res, params, { error: true })
      return
    }

    failures.reset()
    res.cookie(COOKIE_NAME, signConsent(config.cookieKey), cookieOpts)
    const qs = new URLSearchParams(params).toString()
    res.redirect(`/authorize${qs ? `?${qs}` : ''}`)
  }

  return { gate, submit }
}

// Exposed for unit tests.
export const __test = { signConsent, verifyConsent, timingSafeStrEqual, parseCookies, FailureWindow }
