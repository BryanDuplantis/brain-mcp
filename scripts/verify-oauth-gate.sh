#!/usr/bin/env bash
# Local curl verification gate for build "C" (OAuth/DCR). Self-contained:
# spins its own server on a temp BRAIN_DATA_DIR + BRAIN_OAUTH_STATE_DIR, localhost only, no live keys.
# Exits non-zero on the first failed check. Self-cleans the server process.
set -uo pipefail

ROOT="/Users/bryanduplantis/Projects/brain-mcp"
PORT=3399
BASE="http://localhost:${PORT}"
REDIRECT="https://claude.ai/api/mcp/auth_callback"
PASS="test-consent-password-xyz"
SECRET="test-mcp-secret-0123456789abcdef"

WORK="$(mktemp -d /tmp/brain-oauth-gate.XXXXXX)"
DATA="${WORK}/data"
STATE="${WORK}/state"
mkdir -p "$DATA" "$STATE"

PASS_N=0
FAIL_N=0
ok()   { PASS_N=$((PASS_N+1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad()  { FAIL_N=$((FAIL_N+1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; }

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

start_server() {
  MCP_SECRET="$SECRET" \
  PUBLIC_BASE_URL="$BASE" \
  OAUTH_AUTHORIZE_PASSWORD="$PASS" \
  OAUTH_ALLOWED_REDIRECT_URIS="$REDIRECT" \
  BRAIN_DATA_DIR="$DATA" \
  BRAIN_OAUTH_STATE_DIR="$STATE" \
  MCP_PORT="$PORT" \
  node "$ROOT/dist/server.js" --transport http >"$WORK/server.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 40); do
    if curl -fsS "$BASE/health" >/dev/null 2>&1; then return 0; fi
    sleep 0.25
  done
  echo "server failed to start; log:"; cat "$WORK/server.log"; return 1
}

echo "=== starting server (pid pending) ==="
start_server || exit 1
echo "server up (pid $SERVER_PID)"

# ---- 1. AS metadata ----
echo "[1] GET /.well-known/oauth-authorization-server"
AS="$(curl -fsS "$BASE/.well-known/oauth-authorization-server")"
echo "$AS" | grep -q '"authorization_endpoint"' && \
echo "$AS" | grep -q '"token_endpoint"' && \
echo "$AS" | grep -q '"registration_endpoint"' \
  && ok "AS metadata lists authorize/token/register" \
  || { bad "AS metadata missing endpoints"; echo "$AS"; }

# ---- 2. Protected-resource metadata (SDK appends the resource path /mcp) ----
echo "[2] GET /.well-known/oauth-protected-resource/mcp"
PR="$(curl -fsS "$BASE/.well-known/oauth-protected-resource/mcp")"
echo "$PR" | grep -q '"resource"' && ok "protected-resource/mcp metadata 200" || { bad "protected-resource metadata missing"; echo "$PR"; }
# bare path should 404 (no resource mounted at root) — confirm the WWW-Authenticate path instead
WWW="$(curl -sS -D - -o /dev/null -X POST "$BASE/mcp" -H 'Content-Type: application/json' -d '{}' | grep -i '^www-authenticate' || true)"
[ -n "$WWW" ] && ok "401 carries WWW-Authenticate (claude.ai discovery): ${WWW}" || echo "  (note) no WWW-Authenticate header on /mcp 401"

# ---- 3. DCR /register (good + bad redirect) ----
echo "[3] POST /register"
REG="$(curl -sS -X POST "$BASE/register" -H 'Content-Type: application/json' \
  -d "{\"redirect_uris\":[\"$REDIRECT\"],\"token_endpoint_auth_method\":\"none\",\"client_name\":\"gate-test\"}")"
CLIENT_ID="$(echo "$REG" | sed -n 's/.*"client_id"[ ]*:[ ]*"\([^"]*\)".*/\1/p')"
[ -n "$CLIENT_ID" ] && ok "register good redirect → client_id=$CLIENT_ID" || { bad "register good redirect failed"; echo "$REG"; }

REG_BAD_CODE="$(curl -sS -o "$WORK/regbad.json" -w '%{http_code}' -X POST "$BASE/register" \
  -H 'Content-Type: application/json' \
  -d '{"redirect_uris":["https://attacker.example/steal"],"token_endpoint_auth_method":"none"}')"
if [ "$REG_BAD_CODE" = "400" ] && grep -q 'invalid_client_metadata' "$WORK/regbad.json"; then
  ok "register bad redirect → 400 invalid_client_metadata (allowlist enforced)"
else
  bad "register bad redirect expected 400 invalid_client_metadata, got $REG_BAD_CODE"; cat "$WORK/regbad.json"
fi

# ---- PKCE ----
VERIFIER="$(openssl rand 32 | b64url)"
CHALLENGE="$(printf '%s' "$VERIFIER" | openssl dgst -sha256 -binary | b64url)"
OST="st-$(openssl rand -hex 6)"  # OAuth 'state' nonce — distinct from $STATE (the state DIR)
AUTHQ="response_type=code&client_id=${CLIENT_ID}&redirect_uri=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' "$REDIRECT")&code_challenge=${CHALLENGE}&code_challenge_method=S256&state=${OST}&scope=mcp:tools"

# ---- 4. /authorize consent: wrong pw → no code; right pw → code ----
echo "[4] /authorize consent flow"
JAR="$WORK/jar.txt"
# wrong password
WRONG="$(curl -sS -o "$WORK/wrong.html" -w '%{http_code}' -c "$JAR" -X POST "$BASE/authorize/consent" \
  --data-urlencode "password=WRONG-PASSWORD" \
  --data-urlencode "response_type=code" \
  --data-urlencode "client_id=${CLIENT_ID}" \
  --data-urlencode "redirect_uri=${REDIRECT}" \
  --data-urlencode "code_challenge=${CHALLENGE}" \
  --data-urlencode "code_challenge_method=S256" \
  --data-urlencode "state=${OST}" \
  --data-urlencode "scope=mcp:tools")"
if [ "$WRONG" = "401" ] && ! grep -q 'brain_oauth_consent' "$JAR" 2>/dev/null; then
  ok "wrong password → 401, no consent cookie, no code"
else
  bad "wrong password expected 401 + no cookie, got $WRONG"
fi

# right password → sets cookie, 302 to /authorize?...
rm -f "$JAR"
CONSENT_LOC="$(curl -sS -o /dev/null -w '%{redirect_url}' -c "$JAR" -X POST "$BASE/authorize/consent" \
  --data-urlencode "password=${PASS}" \
  --data-urlencode "response_type=code" \
  --data-urlencode "client_id=${CLIENT_ID}" \
  --data-urlencode "redirect_uri=${REDIRECT}" \
  --data-urlencode "code_challenge=${CHALLENGE}" \
  --data-urlencode "code_challenge_method=S256" \
  --data-urlencode "state=${OST}" \
  --data-urlencode "scope=mcp:tools")"
# follow the gated /authorize with the cookie; capture redirect to claude.ai with code
AUTH_LOC="$(curl -sS -o /dev/null -w '%{redirect_url}' -b "$JAR" "$BASE${CONSENT_LOC#$BASE}")"
CODE="$(printf '%s' "$AUTH_LOC" | sed -n 's/.*[?&]code=\([^&]*\).*/\1/p')"
RSTATE="$(printf '%s' "$AUTH_LOC" | sed -n 's/.*[?&]state=\([^&]*\).*/\1/p')"
if [ -n "$CODE" ] && [ "$RSTATE" = "$OST" ]; then
  ok "right password → code minted, state preserved"
else
  bad "right password expected code+state; consent_loc=$CONSENT_LOC auth_loc=$AUTH_LOC"
fi

# ---- 5. /token authorization_code: success, single-use, PKCE ----
echo "[5] POST /token (authorization_code)"
TOK="$(curl -sS -X POST "$BASE/token" \
  --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "code=${CODE}" \
  --data-urlencode "redirect_uri=${REDIRECT}" \
  --data-urlencode "client_id=${CLIENT_ID}" \
  --data-urlencode "code_verifier=${VERIFIER}")"
ACCESS="$(echo "$TOK" | sed -n 's/.*"access_token"[ ]*:[ ]*"\([^"]*\)".*/\1/p')"
REFRESH="$(echo "$TOK" | sed -n 's/.*"refresh_token"[ ]*:[ ]*"\([^"]*\)".*/\1/p')"
[ -n "$ACCESS" ] && [ -n "$REFRESH" ] && ok "token exchange → access+refresh" || { bad "token exchange failed"; echo "$TOK"; }

# reuse same code → must fail (single-use)
REUSE_CODE="$(curl -sS -o "$WORK/reuse.json" -w '%{http_code}' -X POST "$BASE/token" \
  --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "code=${CODE}" \
  --data-urlencode "redirect_uri=${REDIRECT}" \
  --data-urlencode "client_id=${CLIENT_ID}" \
  --data-urlencode "code_verifier=${VERIFIER}")"
[ "$REUSE_CODE" = "400" ] && ok "code reuse → 400 (single-use)" || { bad "code reuse expected 400, got $REUSE_CODE"; cat "$WORK/reuse.json"; }

# ---- 6. /mcp initialize with OAuth access token ----
echo "[6] POST /mcp initialize (OAuth access token)"
INIT_BODY='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"gate","version":"0"}}}'
M_OAUTH="$(curl -sS -o "$WORK/init_oauth.txt" -w '%{http_code}' -X POST "$BASE/mcp" \
  -H "Authorization: Bearer ${ACCESS}" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d "$INIT_BODY")"
[ "$M_OAUTH" = "200" ] && ok "/mcp initialize via OAuth token → 200" || { bad "/mcp OAuth init expected 200, got $M_OAUTH"; cat "$WORK/init_oauth.txt"; }

# ---- 7. /mcp with static MCP_SECRET ----
echo "[7] POST /mcp initialize (static MCP_SECRET)"
M_STATIC="$(curl -sS -o "$WORK/init_static.txt" -w '%{http_code}' -X POST "$BASE/mcp" \
  -H "Authorization: Bearer ${SECRET}" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d "$INIT_BODY")"
[ "$M_STATIC" = "200" ] && ok "/mcp initialize via static secret → 200" || { bad "/mcp static init expected 200, got $M_STATIC"; cat "$WORK/init_static.txt"; }

# ---- 8. /mcp no/bad token → 401 (H1 closed) ----
echo "[8] POST /mcp with no & bad token"
M_NONE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/mcp" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d "$INIT_BODY")"
M_BAD="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/mcp" \
  -H 'Authorization: Bearer not-a-real-token' \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d "$INIT_BODY")"
if [ "$M_NONE" = "401" ] && [ "$M_BAD" = "401" ]; then
  ok "/mcp no-token=401 bad-token=401 (H1 hole closed)"
else
  bad "/mcp expected 401/401, got none=$M_NONE bad=$M_BAD"
fi

# ---- 9. /token refresh_token → new access token ----
echo "[9] POST /token (refresh_token)"
RTOK="$(curl -sS -X POST "$BASE/token" \
  --data-urlencode "grant_type=refresh_token" \
  --data-urlencode "refresh_token=${REFRESH}" \
  --data-urlencode "client_id=${CLIENT_ID}")"
ACCESS2="$(echo "$RTOK" | sed -n 's/.*"access_token"[ ]*:[ ]*"\([^"]*\)".*/\1/p')"
if [ -n "$ACCESS2" ] && [ "$ACCESS2" != "$ACCESS" ]; then
  ok "refresh → new access token (differs from original)"
else
  bad "refresh failed or token not rotated"; echo "$RTOK"
fi
# new access token works on /mcp
M_REFRESHED="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/mcp" \
  -H "Authorization: Bearer ${ACCESS2}" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d "$INIT_BODY")"
[ "$M_REFRESHED" = "200" ] && ok "refreshed access token works on /mcp" || bad "refreshed token /mcp expected 200, got $M_REFRESHED"

# ---- 10. restart → client + refresh survive file store ----
echo "[10] restart server, replay client persistence + refresh"
kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; SERVER_PID=""
start_server || exit 1
echo "  server restarted (pid $SERVER_PID)"
# client persisted?
GETC="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/.well-known/oauth-authorization-server")"
# refresh still valid after restart (refresh.json persisted; access tokens were in-mem)
RTOK2="$(curl -sS -X POST "$BASE/token" \
  --data-urlencode "grant_type=refresh_token" \
  --data-urlencode "refresh_token=${REFRESH}" \
  --data-urlencode "client_id=${CLIENT_ID}")"
ACCESS3="$(echo "$RTOK2" | sed -n 's/.*"access_token"[ ]*:[ ]*"\([^"]*\)".*/\1/p')"
if [ -n "$ACCESS3" ]; then
  ok "post-restart refresh → new access token (refresh.json + clients.json survived)"
else
  bad "post-restart refresh failed"; echo "$RTOK2"; echo "--- state dir ---"; ls -la "$STATE"
fi
M_POSTRESTART="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/mcp" \
  -H "Authorization: Bearer ${ACCESS3}" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d "$INIT_BODY")"
[ "$M_POSTRESTART" = "200" ] && ok "post-restart refreshed token works on /mcp" || bad "post-restart /mcp expected 200, got $M_POSTRESTART"

echo ""
echo "=== RESULT: ${PASS_N} passed, ${FAIL_N} failed ==="
[ "$FAIL_N" -eq 0 ]
