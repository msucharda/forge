#!/usr/bin/env bash
# Anvil guardrails — pre-tool-use hook
# Blocks dangerous commands and warns on push to main/master.
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

# Block recursive delete from root
if echo "$COMMAND" | grep -qE '\brm\s+.*-[^ ]*r[^ ]*f|\brm\s+.*-[^ ]*f[^ ]*r|\brm\s+--recursive\b.*--force\b|\brm\s+--force\b.*--recursive\b'; then
    if echo "$COMMAND" | grep -qE '\s/(\s|$|"|'"'"')'; then
        echo "🔨 Anvil: recursive delete from root is blocked." >&2
        exit 1
    fi
fi

# Warn on direct push to main/master
if echo "$COMMAND" | grep -qiE 'git\s+push\s.*(main|master)\b|git\s+push\s+origin\s+(main|master)\b'; then
    echo "🔨 Anvil: you're pushing directly to main/master. Are you sure?" >&2
    exit 2
fi

exit 0
