#!/bin/bash
# SessionStart reminder hook.
# Surfaces the paused security-audit context at the start of a new session.
# Remove this hook (and its entry in .claude/settings.json) once the audit
# work is resumed and no longer needs a reminder.
set -euo pipefail

input=$(cat)
source=$(printf '%s' "$input" | grep -o '"source"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')

# Only nag at the start of a fresh/cleared/resumed session — not on compaction.
case "${source:-startup}" in
  startup|clear|resume) ;;
  *) exit 0 ;;
esac

read -r -d '' MSG <<'EOF' || true
REMINDER FOR THE USER (surface this to them now, then continue normally):

You paused the agentic-stack security audit to pick it up this morning.

State: branch claude/security-audit-agentic-stack-mdlRz. Full findings are in
SECURITY_AUDIT.md. The repo-level audit is done; these items are still open:

  1. Verify MCP_SECRET is set on the Pi — OPEN mode = no auth on a public
     Funnel endpoint (auth fails open when the env var is unset).
  2. Enable GitHub secret scanning + push protection on the repo
     (GHAS reported "Advanced Security not enabled").
  3. Run the host-level sections (1, 3.3-3.4, 4.2-4.4) directly on the
     Mac mini and Pi — they cannot run from a cloud session.

Offer to draft the copy-paste host command block. When the user no longer
wants this reminder, remove .claude/hooks/session-start.sh and its entry in
.claude/settings.json.
EOF

# Emit the reminder as SessionStart additional context (JSON-escaped).
esc=$(printf '%s' "$MSG" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null) || \
  esc=$(printf '%s' "$MSG" | sed ':a;N;$!ba;s/\\/\\\\/g;s/"/\\"/g;s/\n/\\n/g' | sed 's/^/"/;s/$/"/')

printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":%s}}\n' "$esc"
