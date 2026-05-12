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

## Adding New Failure Modes

When a pattern appears for the second time:

1. Name it `FM-N` (next in sequence)
2. Document: Severity / Symptom / Cause / Resolution
3. Add to Integration Health Map if it involves an external dependency
4. Commit: `docs: add FM-N [brief description]`
