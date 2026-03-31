#!/usr/bin/env bash
# Anvil Ops guardrails — pre-tool-use hook for Azure Arc operations
# Blocks destructive commands that should never be executed by an agent.
#
# Exit codes:
#   0 = allow
#   1 = deny (blocks the tool call)
#   2 = ask  (prompts user for confirmation)

set -euo pipefail

TOOL_NAME="${COPILOT_TOOL_NAME:-}"
TOOL_ARGS="${COPILOT_TOOL_ARGS:-}"

# Only inspect bash/shell tool calls
if [ "$TOOL_NAME" != "bash" ]; then
    exit 0
fi

COMMAND="${TOOL_ARGS}"

# ── BLOCK: Always deny ─────────────────────────────────────────────────
# Warn on deletion of Arc servers (requires explicit confirmation)
if echo "$COMMAND" | grep -qE 'az\s+connectedmachine\s+delete'; then
    echo "🔨 Anvil Ops: 'az connectedmachine delete' removes Azure management plane access. Confirm this is intended." >&2
    exit 2
fi

# Never allow run-command with --run-as-user (privilege escalation)
if echo "$COMMAND" | grep -qE 'connectedmachine\s+run-command\s+create' && echo "$COMMAND" | grep -qE '\-\-run-as-user'; then
    echo "🔨 Anvil Ops: run-command with --run-as-user is blocked. Privilege escalation requires manual execution with PIM." >&2
    exit 1
fi

# Never allow async execution (fire-and-forget with no visibility)
if echo "$COMMAND" | grep -qE 'connectedmachine\s+run-command\s+create' && echo "$COMMAND" | grep -qE '\-\-async-execution'; then
    echo "🔨 Anvil Ops: --async-execution is blocked. All run-commands must wait for results." >&2
    exit 1
fi

# Block deletion of private endpoint connections
if echo "$COMMAND" | grep -qE 'connectedmachine\s+private-endpoint-connection\s+delete'; then
    echo "🔨 Anvil Ops: private endpoint deletion is blocked. Network isolation changes require manual execution." >&2
    exit 1
fi

# ── WARN: Potentially destructive operations ───────────────────────────
# Extension delete — warn (removes monitoring/security agents)
if echo "$COMMAND" | grep -qE 'connectedmachine\s+extension\s+delete'; then
    echo "🔨 Anvil Ops: extension delete removes monitoring/security agents. Confirm this is intended." >&2
    exit 2
fi

# Run-command create — warn (arbitrary command execution on remote servers)
if echo "$COMMAND" | grep -qE 'connectedmachine\s+run-command\s+create'; then
    echo "🔨 Anvil Ops: run-command executes code on remote servers. Verify the script content." >&2
    exit 2
fi

# ── ALLOW: Everything else ─────────────────────────────────────────────
exit 0
