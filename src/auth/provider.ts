import crypto from 'node:crypto'
import type { Response } from 'express'
import type {
  OAuthServerProvider,
  AuthorizationParams
} from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type {
  OAuthClientInformationFull,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import {
  InvalidGrantError,
  InvalidRequestError
} from '@modelcontextprotocol/sdk/server/auth/errors.js'
import { FileClientStore, type RefreshRecord } from './store.js'

const ACCESS_TOKEN_TTL_SECONDS = 3600 // 1h
const AUTH_CODE_TTL_MS = 60_000 // 60s — single-use, in-memory only

interface CodeRecord {
  client: OAuthClientInformationFull
  params: AuthorizationParams
  expiresAt: number // ms
}

interface AccessRecord {
  clientId: string
  scopes: string[]
  expiresAt: number // ms
  resource?: URL
}

function opaqueToken(): string {
  return crypto.randomBytes(32).toString('base64url')
}

/**
 * FileOAuthProvider — the brain-mcp authorization server (build "C").
 *
 * PKCE is verified by the SDK token handler (we keep `skipLocalPkceValidation`
 * unset): our only PKCE job is to store the `codeChallenge` at authorize time
 * and return it from `challengeForAuthorizationCode`.
 *
 * Authorization codes and access tokens are in-memory (short TTL). Registered
 * clients and refresh tokens persist via FileClientStore so a Pi restart costs
 * at most one silent refresh round-trip, never a re-consent.
 *
 * The human gate (single-user password) is enforced UPSTREAM of this provider
 * by the consent middleware in consent.ts — `authorize()` is only ever reached
 * after a valid consent cookie, so an arbitrary internet party cannot mint a
 * code here even though DCR `/register` is open.
 */
export class FileOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: FileClientStore
  private readonly codes = new Map<string, CodeRecord>()
  private readonly accessTokens = new Map<string, AccessRecord>()
  // skipLocalPkceValidation intentionally left unset (false): we are the real
  // authorization server, so the SDK performs PKCE verification.

  constructor(store: FileClientStore = new FileClientStore()) {
    this.clientsStore = store
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    // Defense-in-depth — the SDK authorize handler already exact-matches this,
    // but never redirect to an unregistered URI.
    if (!client.redirect_uris.includes(params.redirectUri)) {
      throw new InvalidRequestError('Unregistered redirect_uri')
    }

    const code = opaqueToken()
    this.codes.set(code, {
      client,
      params,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS
    })

    const target = new URL(params.redirectUri)
    target.searchParams.set('code', code)
    if (params.state !== undefined) target.searchParams.set('state', params.state)
    res.redirect(target.toString())
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const record = this.codes.get(authorizationCode)
    if (!record || record.expiresAt < Date.now()) {
      throw new InvalidGrantError('Invalid or expired authorization code')
    }
    return record.params.codeChallenge
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string, // PKCE verified by the SDK token handler
    _redirectUri?: string,
    _resource?: URL
  ): Promise<OAuthTokens> {
    const record = this.codes.get(authorizationCode)
    if (!record || record.expiresAt < Date.now()) {
      this.codes.delete(authorizationCode)
      throw new InvalidGrantError('Invalid or expired authorization code')
    }
    if (record.client.client_id !== client.client_id) {
      throw new InvalidGrantError('Authorization code was not issued to this client')
    }
    // Single-use: delete before issuing so a replay cannot mint a second token.
    this.codes.delete(authorizationCode)

    const scopes = record.params.scopes ?? []
    const resource = record.params.resource
    return this.issueTokens(client.client_id, scopes, resource, true)
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    const record = await this.clientsStore.getRefresh(refreshToken)
    if (!record) throw new InvalidGrantError('Invalid refresh token')
    if (record.clientId !== client.client_id) {
      throw new InvalidGrantError('Refresh token was not issued to this client')
    }
    // Non-rotating refresh (v1): re-mint the access token, keep the same refresh
    // token. Avoids the atomic-swap-on-crash hazard of rotation.
    const grantScopes = scopes && scopes.length > 0 ? scopes : record.scopes
    return this.issueTokens(client.client_id, grantScopes, resource, false, refreshToken)
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.accessTokens.get(token)
    if (!record || record.expiresAt < Date.now()) {
      this.accessTokens.delete(token)
      throw new InvalidGrantError('Invalid or expired access token')
    }
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: Math.floor(record.expiresAt / 1000),
      resource: record.resource
    }
  }

  private async issueTokens(
    clientId: string,
    scopes: string[],
    resource: URL | undefined,
    withRefresh: boolean,
    existingRefresh?: string
  ): Promise<OAuthTokens> {
    const accessToken = opaqueToken()
    this.accessTokens.set(accessToken, {
      clientId,
      scopes,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000,
      resource
    })

    const tokens: OAuthTokens = {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      scope: scopes.join(' ')
    }

    if (existingRefresh) {
      tokens.refresh_token = existingRefresh
    } else if (withRefresh) {
      const refreshToken = opaqueToken()
      const record: RefreshRecord = {
        clientId,
        scopes,
        issuedAt: Date.now()
      }
      await this.clientsStore.saveRefresh(refreshToken, record)
      tokens.refresh_token = refreshToken
    }

    return tokens
  }
}
