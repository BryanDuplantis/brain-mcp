# brain-mcp

Personal MCP server. Makes accumulated knowledge queryable by Claude across all
surfaces — iOS app, macOS app, claude.ai, and Claude Code.

Three tools: capture, search, recall. Claude is the interface. There is no dashboard.

---

## How It Works

```
Claude iOS / macOS / claude.ai
        ↓ Tailscale Funnel (public HTTPS)
        ↓ https://<pi-hostname>.<tailnet>.ts.net
Claude Code
        ↓ stdio (local, no network)
        ↓
   Raspberry Pi 5 (always-on)
   ├── MCP server (Streamable HTTP, port 3001)
   ├── ChromaDB   (Docker, port 8000)
   └── ~/brain/   (markdown + YAML frontmatter)
        ↑
   Voyage AI voyage-4 (embeddings)
```

Anything you tell Claude to capture is stored as markdown and embedded via Voyage AI
into ChromaDB. Any future Claude session — on any surface — can search or retrieve it.

---

## MVP Checklist

- [ ] `capture` tool — stores to `~/brain/`, queues Voyage embedding
- [ ] `search` tool — semantic search, returns `SearchResponse` with status field
- [ ] `recall` tool — full document retrieval by ID
- [ ] stdio transport working (Claude Code)
- [ ] Streamable HTTP transport working (remote Claude apps via Tailscale Funnel)
- [ ] Pi running ChromaDB 24/7 with persistent volume
- [ ] Tailscale Funnel stable with HTTPS
- [ ] Nightly rsync backup to Mac mini

---

## Setup

### Prerequisites

- Raspberry Pi 5 (8GB recommended)
- Mac mini M4 (development + bulk ingestion)
- Node.js 20+ on both machines
- Docker on the Pi (for ChromaDB)
- Tailscale account (free tier sufficient)
- Voyage AI account (free tier sufficient for personal use)
- Anthropic API key

---

### Step 1 — Tailscale Setup

Tailscale creates a private encrypted network between your devices. Tailscale Funnel
extends it by giving the Pi a public HTTPS endpoint — so Claude apps running from
Anthropic's infrastructure can reach it without VPN.

**Install on Mac mini:**
```bash
brew install tailscale
sudo tailscaled &
tailscale up
# Follow the auth URL, sign in with your Tailscale account
```

**Install on Raspberry Pi:**
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
# Follow the auth URL, sign in with the SAME Tailscale account
```

**Enable MagicDNS and HTTPS certificates** (required for Funnel):
1. Open Tailscale Admin Console → DNS
2. Enable MagicDNS
3. Under HTTPS Certificates → click Enable HTTPS

**Enable Funnel in ACL policy:**
1. Open Tailscale Admin Console → Access Controls
2. Add the `funnel` node attribute:
```json
{
  "nodeAttrs": [
    {
      "target": ["autogroup:member"],
      "attr": ["funnel"]
    }
  ]
}
```

**Verify both devices are connected:**
```bash
tailscale status
# Both mac-mini and raspberrypi should appear as Connected
```

**Get the Pi's Tailscale hostname** (used throughout this setup):
```bash
# Run on Pi
tailscale status --json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['Self']['DNSName'])"
# Example output: raspberrypi.tail-abc123.ts.net
```

**Enable Tailscale on Pi boot:**
```bash
sudo systemctl enable tailscaled
```

**iPhone/iPad:** Install the Tailscale app from the App Store, sign in. The iOS
Claude app connects through Funnel's public HTTPS URL — no VPN toggle needed.

---

### Step 2 — Raspberry Pi System Setup

SSH into your Pi:
```bash
ssh <user>@raspberrypi.local
# or: ssh <user>@<pi-tailscale-ip>
```

**Install Node.js 20+:**
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # v20+
```

**Install Docker:**
```bash
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER
newgrp docker
```

**Start ChromaDB with persistent volume:**
```bash
docker run -d \
  --name chroma \
  -p 8000:8000 \
  -v chroma-data:/chroma/chroma \
  --restart unless-stopped \
  chromadb/chroma

# Verify (note: v2 endpoint)
curl http://localhost:8000/api/v2/heartbeat
# Returns: {"nanosecond heartbeat": ...}
```

**Create the brain directory:**
```bash
mkdir -p ~/brain ~/brain/inbox
```

---

### Step 3 — Voyage AI Setup

Voyage AI is Anthropic's recommended embedding provider.
Anthropic does not offer its own embedding model.

1. Sign up at [voyageai.com](https://www.voyageai.com)
2. Create an API key in the dashboard
3. Add to `.env.local` as `VOYAGE_API_KEY`

Model used: `voyage-4` (current general-purpose model as of 2026).

---

### Step 4 — Clone and Configure

**On both Mac mini and Pi:**
```bash
git clone https://github.com/BryanDuplantis/brain-mcp.git
cd brain-mcp
npm install
```

**Create `.env.local`:**
```bash
cp .env.example .env.local
```

Edit `.env.local`:
```bash
# Anthropic (required for chat operations)
ANTHROPIC_API_KEY=your-anthropic-key
ANTHROPIC_PRIMARY_MODEL=claude-sonnet-4-6

# Voyage AI (required for embeddings)
VOYAGE_API_KEY=your-voyage-key

# Brain data directory
BRAIN_DATA_DIR=/home/<user>/brain     # Pi
# BRAIN_DATA_DIR=/Users/<user>/brain  # Mac (local dev)

# ChromaDB
CHROMA_URL=http://localhost:8000
RAG_TOPK=6

# MCP HTTP server
MCP_PORT=3001
MCP_SECRET=generate-a-long-random-string-here
```

**Build:**
```bash
npm run build
```

---

### Step 5 — Enable Tailscale Funnel on Pi

Once the MCP server is built and `.env.local` is configured:

```bash
# Start MCP server as background service (Step 6 below)
# Then expose it via Funnel:
tailscale funnel --bg 3001
```

**Verify Funnel is active:**
```bash
tailscale funnel status
# Shows: https://raspberrypi.tail-abc123.ts.net → proxy http://127.0.0.1:3001
```

**Test the public endpoint:**
```bash
curl https://raspberrypi.tail-abc123.ts.net/health
# Should return: {"status":"ok"}
```

This is the URL you'll add to Claude app connector settings.

---

### Step 6 — Run as Service on Pi

```bash
sudo nano /etc/systemd/system/brain-mcp.service
```

```ini
[Unit]
Description=brain-mcp MCP Server
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=<user>
WorkingDirectory=/home/<user>/brain-mcp
EnvironmentFile=/home/<user>/brain-mcp/.env.local
ExecStart=/usr/bin/node dist/server.js --transport http
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable brain-mcp
sudo systemctl start brain-mcp
sudo systemctl status brain-mcp
```

---

### Step 7 — Connect Claude Code (stdio)

**Option A — Project-scoped** (checked into repo, available to anyone with the repo):

Create `.mcp.json` in the repo root:
```json
{
  "mcpServers": {
    "brain-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["dist/server.js"],
      "env": {
        "BRAIN_DATA_DIR": "/Users/<user>/brain",
        "CHROMA_URL": "http://<pi-tailscale-ip>:8000",
        "VOYAGE_API_KEY": "<your-voyage-key>",
        "ANTHROPIC_PRIMARY_MODEL": "claude-sonnet-4-6"
      }
    }
  }
}
```

**Option B — User-scoped** (available across all your projects):
```bash
claude mcp add --transport stdio brain-mcp \
  --env BRAIN_DATA_DIR=/Users/<user>/brain \
  --env CHROMA_URL=http://<pi-tailscale-ip>:8000 \
  --env VOYAGE_API_KEY=<your-key> \
  -- node /absolute/path/to/brain-mcp/dist/server.js
```

**Verify tools are connected:**
```bash
# In Claude Code
/mcp
# brain-mcp should appear as Connected with 3 tools
```

---

### Step 8 — Connect Remote Claude Apps

In Claude settings → Connectors → Add custom connector:

```
URL:   https://<pi-hostname>.<tailnet>.ts.net/mcp
Token: <your MCP_SECRET value>
```

Or via Claude Code CLI (user-scoped):
```bash
claude mcp add --transport http brain-mcp-remote \
  https://<pi-hostname>.<tailnet>.ts.net/mcp \
  --header "Authorization: Bearer <MCP_SECRET>"
```

---

### Step 9 — End-to-End Verification

Run this sequence from Claude Code, then repeat from the Claude iOS or macOS app:

```
1. capture("Setup complete. brain-mcp v1 running on Pi via Tailscale Funnel.", "note", undefined, ["setup", "brain-mcp"])

2. search("brain-mcp setup")
   → should return the document from step 1 with status: 'ok'

3. recall("<id from step 1>")
   → should return full document content
```

All three must work from both transports before declaring setup complete.

---

### Step 10 — Backup Setup

```bash
# Add to Pi crontab (crontab -e)
# Nightly rsync to Mac mini at 2 AM
0 2 * * * rsync -av --delete ~/brain/ <user>@mac-mini.local:/Users/<user>/brain-backup/
```

Test the backup manually after setup:
```bash
rsync -av ~/brain/ <user>@mac-mini.local:/Users/<user>/brain-backup/
```

Run a restore drill monthly: confirm files on Mac mini are current and intact.

---

## Usage

### Capturing

Tell Claude naturally:
- "Save this idea to my brain"
- "Capture this decision"
- "Add this to my knowledge base as a session note"
- "Note: the Pi's Tailscale IP is 100.64.x.x"

### Searching

- "Search my brain for anything about MCP architecture"
- "What have I previously captured about compound engineering?"
- "Find my notes on the feed intelligence dashboard"

### Retrieving

- "Recall brain document 2026-05-12-note-brain-mcp-setup"

---

## Bulk Ingestion

For importing existing notes or session transcripts from Cowork or Claude Code:

```bash
# Place .md or .txt files in ~/brain/inbox/
npm run ingest-bulk
```

Reads all files in `~/brain/inbox/`, chunks, embeds via Voyage AI, upserts to ChromaDB.
Safe to run multiple times. Move files out of `inbox/` after ingestion.

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | — | Anthropic API key |
| `ANTHROPIC_PRIMARY_MODEL` | No | `claude-sonnet-4-6` | Claude model |
| `VOYAGE_API_KEY` | Yes | — | Voyage AI key (embeddings) |
| `BRAIN_DATA_DIR` | No | `~/brain` | Path to brain data directory |
| `CHROMA_URL` | No | `http://localhost:8000` | ChromaDB endpoint |
| `RAG_TOPK` | No | `6` | Chunks to retrieve per search |
| `MCP_PORT` | No | `3001` | HTTP server port |
| `MCP_SECRET` | Yes (prod) | — | Bearer token for HTTP auth |

---

## Scripts

| Script | What it does |
|--------|-------------|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run dev` | Run with ts-node, watch mode |
| `npm test` | Run Vitest test suite |
| `npm run ingest-bulk` | Bulk ingest files from `~/brain/inbox/` |

---

## Troubleshooting

See `FAILURE_MODES.md` for named failure patterns and resolutions.

Quick checks:
```bash
# ChromaDB running? (v2 endpoint)
curl http://localhost:8000/api/v2/heartbeat

# Tailscale Funnel active?
tailscale funnel status

# MCP service running on Pi?
sudo systemctl status brain-mcp

# Anthropic env collision? (should be empty in Claude Code)
echo $ANTHROPIC_API_KEY

# Claude Code tools connected?
/mcp
```
