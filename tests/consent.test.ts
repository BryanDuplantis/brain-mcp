/**
 * H-1 fix: the consent cookie is bound to the OAuth `/authorize` params
 * (client_id + redirect_uri + code_challenge), so a cookie minted for one
 * authorization request cannot authorize a DIFFERENT request within the TTL.
 *
 * These tests exercise the binding directly via the __test export. The mac /
 * expiry / wrong-key cases live in tests/oauth.test.ts; here we prove the
 * param-binding: TRUE for the originating params, FALSE for any single-field
 * mutation, and FALSE on expiry regardless of params.
 */
import { describe, it, expect } from 'vitest'
import { __test as consent } from '../src/auth/consent.js'

const KEY = 'cookie-signing-key'
const NOW = 1_000_000

const PARAMS_A = {
  client_id: 'client-A',
  redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
  code_challenge: 'challenge-A'
}

describe('H-1 consent cookie param binding', () => {
  it('verifies TRUE for the params it was minted for', () => {
    const cookie = consent.signConsent(KEY, PARAMS_A, NOW)
    expect(consent.verifyConsent(KEY, cookie, PARAMS_A, NOW + 1000)).toBe(true)
  })

  it('rejects a mutated redirect_uri', () => {
    const cookie = consent.signConsent(KEY, PARAMS_A, NOW)
    const mutated = { ...PARAMS_A, redirect_uri: 'https://evil.example/callback' }
    expect(consent.verifyConsent(KEY, cookie, mutated, NOW + 1000)).toBe(false)
  })

  it('rejects a mutated code_challenge', () => {
    const cookie = consent.signConsent(KEY, PARAMS_A, NOW)
    const mutated = { ...PARAMS_A, code_challenge: 'challenge-B' }
    expect(consent.verifyConsent(KEY, cookie, mutated, NOW + 1000)).toBe(false)
  })

  it('rejects a mutated client_id', () => {
    const cookie = consent.signConsent(KEY, PARAMS_A, NOW)
    const mutated = { ...PARAMS_A, client_id: 'client-B' }
    expect(consent.verifyConsent(KEY, cookie, mutated, NOW + 1000)).toBe(false)
  })

  it('rejects an expired cookie even when params match', () => {
    const cookie = consent.signConsent(KEY, PARAMS_A, NOW)
    expect(consent.verifyConsent(KEY, cookie, PARAMS_A, NOW + 10 * 60_000)).toBe(false)
  })

  it('does NOT silently pass when code_challenge is absent', () => {
    // A cookie minted WITH a code_challenge must not verify against a request
    // that omits it — absent canonicalizes to "" (distinct), never a wildcard.
    const cookie = consent.signConsent(KEY, PARAMS_A, NOW)
    const dropped = consent.extractParams({
      client_id: PARAMS_A.client_id,
      redirect_uri: PARAMS_A.redirect_uri
      // code_challenge omitted
    })
    expect(dropped.code_challenge).toBe('')
    expect(consent.verifyConsent(KEY, cookie, dropped, NOW + 1000)).toBe(false)
  })

  it('extractParams coerces missing / non-string values to empty strings', () => {
    const p = consent.extractParams({ client_id: ['array', 'value'], redirect_uri: 42 })
    expect(p).toEqual({ client_id: '', redirect_uri: '', code_challenge: '' })
  })

  it('canonicalParams is collision-free across field boundaries', () => {
    // A naive concat would collide "ab"+"c"+"" with "a"+"bc"+""; the array form must not.
    const left = consent.canonicalParams({ client_id: 'ab', redirect_uri: 'c', code_challenge: '' })
    const right = consent.canonicalParams({ client_id: 'a', redirect_uri: 'bc', code_challenge: '' })
    expect(left).not.toBe(right)
  })
})
