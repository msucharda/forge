#!/usr/bin/env bash
# Anvil AKS guardrails — pre-tool-use hook for Azure Kubernetes Service operations
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
# az aks delete — destroys entire cluster
if echo "$COMMAND" | grep -qE 'az\s+aks\s+delete'; then
    echo "🔨 Anvil AKS: 'az aks delete' destroys the entire cluster. This is blocked." >&2
    exit 1
fi

# az aks rotate-certs — regenerates all cluster certificates, causes downtime
if echo "$COMMAND" | grep -qE 'az\s+aks\s+rotate-certs'; then
    echo "🔨 Anvil AKS: 'az aks rotate-certs' regenerates all cluster certificates and causes downtime. This is blocked." >&2
    exit 1
fi

# kubectl delete namespace/ns — destroys entire namespace and all resources within
if echo "$COMMAND" | grep -qE 'kubectl\s+delete\s' && echo "$COMMAND" | grep -qE '\b(namespace|ns)\b'; then
    echo "🔨 Anvil AKS: 'kubectl delete namespace' destroys an entire namespace and all its resources. This is blocked." >&2
    exit 1
fi

# kubectl apply -f/-filename with remote URL — remote manifests cannot be verified
if echo "$COMMAND" | grep -qE 'kubectl\s+apply\s+(--filename|-f)\s+https?://'; then
    echo "🔨 Anvil AKS: applying remote manifests (http/https) is blocked. Download and review the manifest first." >&2
    exit 1
fi

# --yes / -y with destructive az aks commands (delete, stop)
if echo "$COMMAND" | grep -qE 'az\s+aks\s+(delete|stop)' && echo "$COMMAND" | grep -qE '(\s--yes|\s-y)(\s|$)'; then
    echo "🔨 Anvil AKS: auto-confirm flag (--yes/-y) with destructive 'az aks' commands is blocked." >&2
    exit 1
fi

# ── WARN: Potentially destructive operations ───────────────────────────
# az aks stop — takes cluster offline
if echo "$COMMAND" | grep -qE 'az\s+aks\s+stop'; then
    echo "🔨 Anvil AKS: 'az aks stop' takes the cluster offline. Confirm this is intended." >&2
    exit 2
fi

# az aks nodepool delete — evicts pods and destroys nodes
if echo "$COMMAND" | grep -qE 'az\s+aks\s+nodepool\s+delete'; then
    echo "🔨 Anvil AKS: 'az aks nodepool delete' evicts all pods and destroys nodes. Confirm this is intended." >&2
    exit 2
fi

# az aks nodepool scale — scaling operations; flag --node-count 0 specifically
if echo "$COMMAND" | grep -qE 'az\s+aks\s+nodepool\s+scale'; then
    if echo "$COMMAND" | grep -qE '\-\-node-count[= ]0(\s|$)'; then
        echo "🔨 Anvil AKS: 'az aks nodepool scale --node-count 0' removes all nodes from the pool. Confirm this is intended." >&2
    else
        echo "🔨 Anvil AKS: 'az aks nodepool scale' changes node count. Confirm this is intended." >&2
    fi
    exit 2
fi

# az aks upgrade — differentiate full cluster vs control-plane-only
if echo "$COMMAND" | grep -qE 'az\s+aks\s+upgrade'; then
    if echo "$COMMAND" | grep -qE '\-\-control-plane-only'; then
        echo "🔨 Anvil AKS: 'az aks upgrade --control-plane-only' upgrades the control plane. Confirm this is intended." >&2
    else
        echo "🔨 Anvil AKS: 'az aks upgrade' upgrades the entire cluster (control plane + all node pools). Confirm this is intended." >&2
    fi
    exit 2
fi

# az aks nodepool upgrade — cordons and drains nodes
if echo "$COMMAND" | grep -qE 'az\s+aks\s+nodepool\s+upgrade'; then
    echo "🔨 Anvil AKS: 'az aks nodepool upgrade' cordons and drains nodes during upgrade. Confirm this is intended." >&2
    exit 2
fi

# kubectl delete (any resource) — removes resources from the cluster
if echo "$COMMAND" | grep -qE 'kubectl\s+delete\s'; then
    echo "🔨 Anvil AKS: 'kubectl delete' removes resources from the cluster. Confirm this is intended." >&2
    exit 2
fi

# kubectl drain — evicts all pods from a node
if echo "$COMMAND" | grep -qE 'kubectl\s+drain\s'; then
    echo "🔨 Anvil AKS: 'kubectl drain' evicts all pods from the target node. Confirm this is intended." >&2
    exit 2
fi

# kubectl scale with --replicas=0 or --replicas 0 — workload shutdown
if echo "$COMMAND" | grep -qE 'kubectl\s+scale\s' && echo "$COMMAND" | grep -qE '\-\-replicas[= ]0(\s|$)'; then
    echo "🔨 Anvil AKS: 'kubectl scale --replicas=0' shuts down the workload entirely. Confirm this is intended." >&2
    exit 2
fi

# az aks disable-addons — removes cluster components
if echo "$COMMAND" | grep -qE 'az\s+aks\s+disable-addons'; then
    echo "🔨 Anvil AKS: 'az aks disable-addons' removes cluster components. Confirm this is intended." >&2
    exit 2
fi

# az aks get-credentials --admin — grants cluster-admin access
if echo "$COMMAND" | grep -qE 'az\s+aks\s+get-credentials' && echo "$COMMAND" | grep -qE '\-\-admin'; then
    echo "🔨 Anvil AKS: 'az aks get-credentials --admin' grants cluster-admin access. Confirm this is intended." >&2
    exit 2
fi

# kubectl exec — runs commands inside containers
if echo "$COMMAND" | grep -qE 'kubectl\s+exec\s'; then
    echo "🔨 Anvil AKS: 'kubectl exec' runs commands inside containers. Confirm this is intended." >&2
    exit 2
fi

# kubectl edit — modifies live cluster resources
if echo "$COMMAND" | grep -qE 'kubectl\s+edit\s'; then
    echo "🔨 Anvil AKS: 'kubectl edit' modifies live cluster resources. Confirm this is intended." >&2
    exit 2
fi

# ── ALLOW: Everything else ─────────────────────────────────────────────
exit 0
