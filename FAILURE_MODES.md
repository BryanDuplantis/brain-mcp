# FAILURE_MODES.md — brain-mcp

Companion to `CLAUDE.md`. Read alongside it at session start.

Named failure patterns for this system. When one appears, resolve it the documented
way. When a new pattern appears twice, add it here before the session ends.

---

## Integration Health Map

| Component | Degrades gracefully? | Likely broken if... |
|-----------|---------------------|---------------------|
| ChromaDB | ✅ search returns `index_unavailable` | Docker not running on Pi |
| Tailscale Funnel | ❌ remote access unavailable | Funnel not enabled or Pi offline |
| `~/brain/` filesystem | ❌ capture fails | Disk full, permissions wrong |
| Voyage AI API | ❌ embedding pipeline halted | `VOYAGE_API_KEY` unset or quota hit |
| Anthropic API | ❌ chat broken | FM-1 env collision in Claude Code |
| MCP stdio transport | ❌ Claude Code can't call tools | Server not built, wrong path in `.mcp.json` |
| MCP Streamable HTTP | ❌ remote Claude can't call tools | Funnel down or Pi offline |

---

## FM-1: ANTHROPIC_API_KEY env collision (Claude Code)

**Severity:** HIGH. Silent — API calls fail while appearing healthy.

**Symptom:** Anthropic API calls return auth errors despite `.env.local` being correct.

**Cause:** Claude Code injects empty `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL`
into the shell. These override `.env.local`. The empty values win.

**Resolution:**
```bash
unset ANTHROPIC_API_KEY && unset ANTHROPIC_BASE_URL
```
Run before starting the MCP server in every Claude Code session.

**Verification:** `echo $ANTHROPIC_API_KEY` returns empty. Restart server.

---

## FM-2: ChromaDB not running — search returns index_unavailable

**Severity:** MEDIUM. No crash. Search returns `{ status: 'index_unavailable' }`.
Capture still works — documents stored to `~/brain/`.

**Cause:** ChromaDB Docker container not running on the Pi.

**Resolution (on Pi):**
```bash
docker ps | grep chroma
docker start chroma   # if container exists but stopped
# or full restart:
docker run -d \
  --name chroma \
  -p 8000:8000 \
  -v chroma-data:/chroma/chroma \
  --restart unless-stopped \
  chromadb/chroma
```

**After restarting**, re-embed documents captured during the outage:
```bash
npm run ingest-bulk
```

**Verification:**
```bash
curl http://localhost:8000/api/v2/heartbeat
# Returns: {"nanosecond heartbeat": ...}
```

Note: endpoint is `/api/v2/heartbeat` — not `/api/v1/heartbeat`.

---

## FM-3: Tailscale Funnel down — remote Claude apps can't reach Pi

**Severity:** HIGH for remote access. Claude Code stdio still works.

**Symptom:** Tool calls from Claude iOS/macOS/claude.ai time out.
`https://<pi-hostname>.ts.net` unreachable.

**Cause:** Funnel not running on Pi, or Pi lost network/power.

**Resolution (on Pi):**
```bash
# Check Tailscale status
tailscale status

# Check if Funnel is active
tailscale funnel status

# Restart Funnel if needed
tailscale funnel --bg 3001

# If Tailscale daemon stopped
sudo systemctl restart tailscaled
tailscale status
```

**Verify public URL is accessible:**
```bash
curl https://<pi-hostname>.<tailnet>.ts.net/health
```

**Prevention:** Run Funnel with `--bg` flag so it persists. Verify Tailscale daemon
is enabled on boot: `sudo systemctl enable tailscaled`

---

## FM-4: Document stored but not embedded — silent RAG gap

**Severity:** MEDIUM. Document safe but won't appear in search.

**Symptom:** `capture()` returns `{ stored: true, embedded: false }`.
Document exists in `~/brain/` but `search()` never surfaces it.

**Cause:** ChromaDB unreachable at capture time, or Voyage AI API unavailable,
or FM-1 present at capture time.

**Resolution:**
```bash
npm run ingest-bulk
```

Scans `~/brain/` for documents with no ChromaDB entry and embeds them.
Safe to run multiple times (upsert semantics).

---

## FM-5a: MCP stdio not found by Claude Code

**Severity:** HIGH. Claude Code cannot call any tools.

**Symptom:** Tools don't appear, or calls return "tool not found."

**Cause:** `.mcp.json` path wrong, or server not built.

**Resolution:**
```bash
# Rebuild
npm run build
ls dist/server.js   # confirm entry point exists

# Check project-scoped config
cat .mcp.json
```

`.mcp.json` in project root should contain:
```json
{
  "mcpServers": {
    "brain-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["dist/server.js"],
      "env": {
        "BRAIN_DATA_DIR": "/Users/bryan/brain",
        "CHROMA_URL": "http://<pi-tailscale-ip>:8000",
        "VOYAGE_API_KEY": "<your-key>"
      }
    }
  }
}
```

Or add via CLI (user-scoped, available across all projects):
```bash
claude mcp add --transport stdio brain-mcp -- node /absolute/path/to/brain-mcp/dist/server.js
```

**Verification:** Run `/mcp` in Claude Code to list connected servers.

---

## FM-5b: MCP Streamable HTTP not reachable by remote Claude apps

**Severity:** HIGH for remote surfaces. Claude iOS/macOS/claude.ai can't call tools.

**Symptom:** Remote connector shows disconnected or times out.

**Cause:** Tailscale Funnel not active, server not running on Pi,
or connector URL incorrect in Claude app settings.

**Resolution:**
1. Verify Pi MCP server is running: `sudo systemctl status brain-mcp`
2. Verify Funnel is active: `tailscale funnel status`
3. Test the endpoint: `curl https://<pi-hostname>.ts.net/health`
4. Verify connector URL in Claude settings matches exactly

**Add remote connector via Claude Code CLI:**
```bash
claude mcp add --transport http brain-mcp-remote \
  https://<pi-hostname>.<tailnet>.ts.net/mcp \
  --header "Authorization: Bearer <MCP_SECRET>"
```

**Note:** Claude Code config uses `claude mcp add` or `.mcp.json`.
Do NOT use `claude_desktop_config.json` — that is Claude Desktop, not Claude Code.

---

## FM-6: Pi disk full — captures silently fail

**Severity:** HIGH. Data loss if not caught.

**Symptom:** `capture()` returns `{ stored: false }` or filesystem error.

**Cause:** `~/brain/` or Docker volume partition is full.

**Resolution:**
```bash
df -h ~/brain
du -sh ~/brain/*
docker system df    # check Docker volume usage
```

ChromaDB Docker volume is usually the largest consumer after heavy ingestion.

---

## FM-7: `~/brain/` permissions wrong after Pi reboot

**Severity:** MEDIUM. Writes fail, reads may work.

**Symptom:** `capture()` fails with permission denied.

**Cause:** MCP server systemd service started as wrong user.

**Resolution:**
```bash
ls -la ~/brain
chown -R bryan:bryan ~/brain
chmod -R 755 ~/brain
```

Ensure `brain-mcp.service` has `User=bryan` set correctly.

---

## FM-8: Voyage AI quota exhausted — embedding pipeline halts

**Severity:** MEDIUM. New captures store but don't embed until quota resets.

**Symptom:** All captures return `{ stored: true, embedded: false }`.
Existing search results still work — only new documents are affected.

**Cause:** Voyage AI API monthly quota exhausted, or `VOYAGE_API_KEY` unset.

**Resolution:**
1. Check Voyage AI dashboard for quota status
2. If `VOYAGE_API_KEY` is unset, add it to `.env.local`
3. Run `npm run ingest-bulk` after quota resets to backfill unembedded docs

---

## FM-9: search() returning empty vs index unavailable

**Severity:** MEDIUM. Debugging trap — empty results look the same as broken index.

**Symptom:** `search()` returns no results. Ambiguous: real empty or broken Chroma?

**Resolution:** `search()` always returns `SearchResponse` with a `status` field:
- `{ status: 'ok', results: [] }` — index healthy, genuinely no matches
- `{ status: 'index_unavailable', results: [], message: '...' }` — Chroma unreachable

Never use empty array as the only signal. Check `status` first.

If `index_unavailable`: follow FM-2 resolution.
If `ok` with empty results: the content hasn't been ingested, or the query
doesn't semantically match anything. Try broader terms.

---

## FM-10: Pi failure — ~/brain/ data loss

**Severity:** CRITICAL. SD cards and SSDs fail. No backup = permanent data loss.

**Symptom:** Pi won't boot, or `~/brain/` is corrupted or missing.

**Resolution (restore):**
1. Replace failed storage
2. Reinstall OS + dependencies (see README Pi setup)
3. Restore `~/brain/` from backup: `rsync -av backup-host:/backup/brain/ ~/brain/`
4. Start ChromaDB: `docker run -d --name chroma ...`
5. Re-embed from restored files: `npm run ingest-bulk`

ChromaDB is re-ingestable from `~/brain/` — it is not the source of truth.
`~/brain/` markdown files are the source of truth.

**Prevention — nightly rsync to Mac mini:**
```bash
# Add to crontab on Pi (crontab -e)
0 2 * * * rsync -av --delete ~/brain/ bryan@mac-mini.local:/Users/bryan/brain-backup/
```

Run restore drill monthly: confirm backup files exist and are current.

---

## FM-11: Shared-types drift between brain-mcp and brain-enricher — stale process trap, doubled

**Severity:** HIGH. Silent — both processes appear healthy while parsing the same file two ways.

**Symptom:** A change to `src/shared/types.ts` (the `EnrichmentStatus` enum, `Enrichment` interface, or `BrainDocument` shape) lands. brain-mcp's MCP server keeps serving the old shape from its child-process module cache (per global §8 stale-MCP-process trap). brain-enricher's worker either picks up the new shape (if restarted) or also serves stale (if not). End state: one writer, one reader, two different shape contracts in memory. New captures land malformed from one perspective and well-formed from the other; `find` results disagree with what `enricher` wrote.

**Cause:** Two long-running Node processes (`brain-mcp` MCP server + `brain-enricher` worker), each with its own `dist/` and its own module cache. `npm run build` updates files on disk; neither running process re-reads them. The path-dep arrangement (`brain-enricher`'s `package.json` declares `"brain-mcp": "file:../brain-mcp"`) catches drift at COMPILE time, not at runtime.

**Resolution — explicit restart sequence after any commit touching `src/shared/`:**

The brain-mcp server on the Pi runs as a **SYSTEM-scope** systemd unit (`brain-mcp.service`,
NOT `--user`) — verified via F12 probe 2026-05-27. brain-enricher is **user-scope** (matches
discord-trigger-router precedent). The two scopes need different restart commands; mixing
them up silently no-ops.

Pi-side directory layout (locked 2026-05-27 F12 probe — flat under home, NOT `~/Projects/`):
- `~/brain-mcp/` (system-scope service)
- `~/brain-enricher/` (user-scope service, planned)
- `~/discord-trigger-router/` (user-scope service, existing precedent)

```bash
# 1. Rebuild both repos on Mac
cd ~/Projects/brain-mcp && npm run build
cd ~/Projects/brain-enricher && npm run build

# 2. Deploy fresh dist to Pi (both repos rsync flat under home)
rsync -av --delete ~/Projects/brain-mcp/dist/         brydup@<pi-ip>:~/brain-mcp/dist/
rsync -av --delete ~/Projects/brain-enricher/dist/    brydup@<pi-ip>:~/brain-enricher/dist/

# 3. Restart brain-mcp on Pi — SYSTEM scope, sudo required
ssh -o ConnectTimeout=10 brydup@<pi-ip> 'sudo systemctl restart brain-mcp.service'

# 4. Restart brain-enricher on Pi — USER scope, no sudo
ssh -o ConnectTimeout=10 brydup@<pi-ip> 'systemctl --user restart brain-enricher.service'

# 5. Force Mac-side MCP client reconnect (stdio child-process module cache):
#    - Claude Code: `/mcp` reconnect for brain-mcp
#    - iOS / claude.ai: toggle the brain-mcp connector off/on

# 6. Verify both sides see the new shape:
#    - A capture from Claude Code shows the new frontmatter shape in `cat ~/brain/<id>.md`
#    - `journalctl --user -u brain-enricher.service` shows worker tick referencing the new enum value
#    - `sudo journalctl -u brain-mcp.service --since "5 min ago"` shows clean restart (no errors)
```

**Why both server-side restart AND client reconnect:** brain-mcp serves two transports.
The Pi-side HTTP server (iOS/claude.ai) holds OLD code in its long-running Node process
until `sudo systemctl restart brain-mcp.service` reloads. The Mac-side stdio child (Claude
Code) holds OLD code until `/mcp` reconnect respawns the child. Skipping either side
leaves that surface serving stale.

**Prevention:** Pre-commit check on any change touching `src/shared/`: `cd ../brain-enricher && npm run build` must pass locally before the brain-mcp commit lands. CI on brain-enricher must run after every brain-mcp commit that touches `src/shared/`.

**Detection — if you suspect drift:** in a Claude Code session, capture a fresh watchlist entry. Read the file. If the frontmatter shape doesn't match what `src/shared/types.ts` says today, brain-mcp is serving stale. If the file lands fine but brain-enricher's worker logs reference an older status value (e.g. `enriched` instead of the current `v1`), brain-enricher is serving stale.

---

## FM-12: CLAUDE.md inheritance discipline — duplicate-context is how designed-vs-deployed gaps start

**Severity:** MEDIUM. Documentation drift; load-bearing rules silently diverge across repos.

**Symptom:** A rule documented in two places (e.g., global `~/.claude/CLAUDE.md` AND a project's `CLAUDE.md`) gets updated in one and not the other. Future sessions read whichever copy fires first and act on the stale version.

**Cause:** Copy-paste-then-edit pattern across project CLAUDE.md files. Each copy is right at the moment of duplication and slowly diverges.

**Resolution — inheritance via reference, not duplication:**

Project CLAUDE.md files MUST start with an explicit inheritance header naming every file they inherit from, by absolute path. Example for `~/Projects/brain-enricher/CLAUDE.md`:

```markdown
# CLAUDE.md — brain-enricher

Inherits from:
- ~/.claude/CLAUDE.md  (global engineering standards, failure modes, rituals)
- ~/Projects/brain-mcp/CLAUDE.md  (shared-types contract, BRAIN_ROOT, atomic writes, Voyage AI, MCP boundaries)

This file adds only enricher-specific context. Do not duplicate rules from the inherited files; reference them by section anchor if you need to invoke one.
```

Local content scope: only what's specific to this project that isn't already covered by an inherited file. Worker lifecycle, polling cadence, retry policy, Anthropic rate-limit posture — these are local. Atomic writes, BRAIN_ROOT, MCP boundaries — these are inherited; do not restate.

**Why absolute paths and not relative:** the inheritance is a fixture on this machine. If brain-mcp ever moves, both imports break together — which is the right failure mode (a single visible breakage, not silent semantic drift).

**Detection:** When you edit a rule in a CLAUDE.md, grep for similar text across all CLAUDE.md files in `~/Projects` and `~/.claude`. Any duplicate is a violation; replace with a reference.

---

## FM-13: Continuation-agent ephemerality — load-bearing decisions sourced from disappeared agents are unreproducible

**Severity:** MEDIUM. Silent — the agent is gone when you go to verify the decision.

**Symptom:** A prior session ran an architect-review or other subagent. That agent returned an ID (e.g., `a3ff76d4d459ca81d`) for follow-up via `SendMessage`. A later session tries to query the same agent and gets "agent not found" — or worse, gets a new agent with the same name but no history of the prior conversation, leading to subtly wrong "yes that's still correct" answers.

**Cause:** Continuation agent IDs are session-ephemeral. Persistence is scoped to the session lifetime; `/clear` or a new session makes the agent unreachable. The prior agent's reasoning state was never durable.

**Resolution — never source a load-bearing decision from a continuation agent:**

1. Every meaningful subagent output (architect-review, code-explorer, plan-review) MUST land as a file at session close. Reviews go to `~/Projects/<project>/reviews/`. Plans go to the same directory.
2. The file IS the durable artifact. The agent ID is convenience-only, valid for follow-up clarifications within the spawning session.
3. If a later session needs to revisit a prior decision, the workflow is: re-read the artifact → spawn a FRESH subagent with the artifact + the new question → never assume the prior agent is reachable.
4. Documentation that names an agent ID for follow-up (e.g., "agent `<id>` available for clarifications") must also name the durable artifact's path, so the next reader has a working fallback.

**Detection:** Memory entries or plan documents that reference "ask the prior agent if X" without a paired file path are red flags. Same for "the continuation agent confirmed Y" without the corresponding artifact citation. Both reduce to "trust me, this happened once."

**Prevention:** Always pair an agent-ID reference with the durable artifact: "Continuation: agent `<id>` (this session only) — durable artifact: `<path>`."

---

## Adding New Failure Modes

When a pattern appears for the second time:

1. Name it `FM-N` (next in sequence)
2. Document: Severity / Symptom / Cause / Resolution
3. Add to Integration Health Map if it involves an external dependency
4. Commit: `docs: add FM-N [brief description]`
