# Security Audit Report — Agentic Stack

**Date:** 2026-05-20
**Stack:** Mac mini M4 + Raspberry Pi 5 (brain-mcp) + GitHub
**Triggered by:** GitHub incident cluster (May 2026) — secrets in repos, CI/CD
token exposure, disabled platform protections.

---

## Critical scope note — read first

This audit was executed from an **isolated, ephemeral Claude Code (web) cloud
container**, not from the Mac mini or the Pi. In this container:

- `whoami` = `root`, host = `vm`, `$HOME` = `/root` (empty).
- The **only** artifact present is a fresh clone of the `brain-mcp` repo.
- There is **no** Mac mini home directory, **no** `~/.aws`, **no** `~/.ssh`,
  **no** real shell history, **no** Pi, **no** Tailscale, **no** `gh` CLI.

Therefore every host-level check (Section 1, 3.3–3.4, 4.2–4.4) **could not be
executed against its real target** and is marked `NEEDS REVIEW — run on host`.
Those sections must be run directly on the Mac mini and Pi. What *was* fully
auditable is the **`brain-mcp` repository and its GitHub-side protections**.

No secret values are reproduced anywhere in this report. None were found.

---

## Results by section

| Check | Result | Finding |
|-------|--------|---------|
| 1.1 Home-dir credential file scan | NEEDS REVIEW — run on host | Mac mini fs not reachable; container `$HOME` empty. |
| 1.2 Permissions on known cred files | NEEDS REVIEW — run on host | No `~/.aws`/`~/.ssh`/`~/.config` in container. |
| 1.3 Credentials in shell history | NEEDS REVIEW — run on host | No real shell history in container. |
| 1.4 `.env` drift into repos | PASS (repo) / NEEDS REVIEW (host) | No `.env` tracked in brain-mcp; `.env*` is gitignored. Other repos not reachable. |
| 2.1 Git history for committed secret files | **PASS** | Full `--all` history scan: zero credential-named files ever committed. |
| 2.2 `.gitignore` coverage | **FIXED** (was NEEDS REVIEW) | Originally covered only `.env*`. Added `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*secret*`, `*token*`, `*credentials*`, `*.apikey`. |
| 2.3 GitHub secret scanning status | **FAIL / NEEDS REVIEW** | GHAS-backed scanning reports **"Advanced Security not enabled"** for the repo. Mirrors the CISA disabled-scanning pattern. See actions. |
| 2.4 Verified secret scan (trufflehog-style) | **PASS (in scope)** | Regex pass over all tracked files + manual review of credential-handling code: zero secret values. Other local repos not reachable. |
| 3.1 `pull_request_target` usage | **PASS** | No `.github/workflows/` exist — no `pull_request_target`, so the Grafana fork vector is absent. |
| 3.2 Secrets to fork workflows | **N/A** | No workflows. |
| 3.3 Pi cron scripts for inline creds | NEEDS REVIEW — run on host | `~/bin/*.sh` not reachable from container. |
| 3.4 `wrapper-template.sh` handling | NEEDS REVIEW — run on host | Not present in repo; lives on Pi. |
| 4.1 GitHub secret scanning active | **FAIL / NEEDS REVIEW** | Same as 2.3 — platform secret scanning not confirmed active. |
| 4.2 SSH key hygiene | NEEDS REVIEW — run on host | No `~/.ssh` in container. |
| 4.3 Tailscale ACL drift | NEEDS REVIEW — run on host | Tailscale not reachable from container. |
| 4.4 Exposed ports on Pi | NEEDS REVIEW — run on host | `ss` against Pi not possible. Code default `CHROMA_URL=http://localhost:8000` is correct, but the **actual Docker bind address** must be verified on the Pi (Docker can publish to `0.0.0.0`). |
| 5.1 Secrets in `CLAUDE.md` | **PASS** | No secret values; `MCP_SECRET` appears only as a concept/placeholder. |
| 5.2 MCP config exposed creds | **PASS** | `.mcp.json` keeps `VOYAGE_API_KEY` empty; no inline credentials. |
| 5.3 Secrets in context files | **PASS** | No secret values in any tracked `.md`/`.txt`/`.yaml`. |

---

## Code-level review (bonus — `src/server.ts`, `src/rag/*`)

This was reachable and is the highest-value part of what *could* be audited.

- **Bearer auth** (`server.ts:71-91`): constant-time compare via
  `crypto.timingSafeEqual`, length-guarded by a short-circuiting `&&` so it
  never throws on mismatched lengths. Token read from `MCP_SECRET` env. **Good.**
- **OPEN mode** (`server.ts:73-79`, `119-124`): when `MCP_SECRET` is unset the
  server serves `/mcp` with **no authentication**, relying only on Funnel URL
  obscurity. This is documented in `CLAUDE.md`, but it means an *unset env var
  silently disables all auth* — fail-open. **NEEDS REVIEW: confirm `MCP_SECRET`
  is actually set on the Pi**, because the Funnel endpoint is public HTTPS.
- **Origin check** (`server.ts:93-110`): only enforced when
  `MCP_ALLOWED_ORIGINS` is set, and **requests with no `Origin` header bypass
  it** (intentional for non-browser MCP clients). Defensible; the real perimeter
  is `MCP_SECRET`.
- **DNS-rebinding protection:** `StreamableHTTPServerTransport` is created
  without `enableDnsRebindingProtection`/`allowedHosts`. Partially substituted
  by the custom Origin middleware. Minor hardening opportunity.
- **Key handling** (`embed.ts`, `store.ts`): API keys/URLs read from
  `process.env` only; errors log `.message`, never key material. **Good.**

---

## Summary

```
FAILS:
- [2.3 / 4.1] GitHub secret scanning not enabled on brain-mcp (GHAS reports
  "Advanced Security not enabled"). Mirrors the CISA disabled-scanning pattern.

NEEDS REVIEW:
- [server.ts] Confirm MCP_SECRET is set on the Pi — OPEN mode = no auth on a
  public Funnel endpoint (fail-open on an unset env var).
- [4.4] Verify ChromaDB Docker bind address on the Pi is localhost/Tailscale,
  not 0.0.0.0.
- [Sections 1, 3.3-3.4, 4.2-4.3] Host-level checks (Mac mini fs, shell history,
  SSH keys, Pi cron scripts, Tailscale ACLs) — NOT runnable from the cloud
  session; must be executed on the actual hosts.

PASSES: 8 reachable checks (2.1, 2.4, 3.1, 5.1, 5.2, 5.3, plus code-level Bearer
auth and key-handling). 1 fixed (2.2).

IMMEDIATE ACTIONS:
1. Verify MCP_SECRET is set in the Pi's environment. If unset, the brain is
   readable/writable by anyone who learns the Funnel URL. Set it now.
2. Enable GitHub secret scanning + push protection (repo Settings -> Code
   security). If the repo is private, enable Secret Protection / GHAS.
3. (Done in this branch) Expanded .gitignore to cover *.pem, *.key, *secret*,
   *token*, *credentials*.
4. Run host sections (1, 3.3-3.4, 4.2-4.4) directly on the Mac mini and Pi.

STRUCTURAL GAPS:
- No CI at all -> no automated secret scan on push. With platform scanning also
  off, a future accidental commit has no safety net. Add a pre-commit / CI
  secret scan (gitleaks or trufflehog).
- Auth is fail-open: an unset MCP_SECRET silently disables authentication.
  Consider failing closed (require MCP_SECRET unless an explicit --open flag is
  passed).
- This audit presumes host access; an isolated Claude Code web session can only
  cover the repo. Host-level checks need a runner on the Mac mini / Pi (or a
  local Claude Code session there).
```
