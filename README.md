# 🔥 Forge

*Where anvils are made.*

Forge ships **evidence-first coding agents** for [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli). Each agent — called an **anvil** — verifies its own output with adversarial multi-model review, tracks every check in a SQL ledger, and refuses to present results until the evidence passes.

## Anvils

| Anvil | What it does |
|-------|-------------|
| **anvil-code** | General-purpose coding with adversarial self-review |
| **anvil-bicep** | Azure Bicep IaC — AVM modules, linting, ARM validation |
| **anvil-arc-ops** | Azure Arc server operations with safety gates |
| **anvil-aks-ops** | AKS cluster operations with safety gates |
| **anvil-architect** | Azure architecture design with WAF compliance, cost estimation, and pre-mortem risk analysis |
| **anvil-sovereign** | EU data sovereignty classification — guides data classification (C1–C4), maps to Azure sovereign levels (L1–L3), identifies GDPR/DORA/NIS2 requirements. Run before anvil-architect for EU workloads |
| **anvil-diagnose** | Read-only Azure troubleshooting — traces root causes, never modifies resources |
| **anvil-audit** | Read-only Azure compliance scanner — network, identity, data, monitoring, cost, policy |

## Install

### Linux / macOS

```bash
git clone https://github.com/msucharda/forge.git
cd forge
make install
```

### Windows (PowerShell)

```powershell
git clone https://github.com/msucharda/forge.git
cd forge
.\install.ps1
```

This places:
- **Agents** in `~/.copilot/agents/` (discoverable via `/agent`)
- **Extension** (tools + guardrails) in `~/.copilot/extensions/anvil/`

Reload Copilot CLI with `/clear`, then pick an anvil with `/agent`.

## Update

```bash
cd forge && git pull && make install        # Linux/macOS
cd forge; git pull; .\install.ps1           # Windows
```

The installer detects existing files and backs up any agent files you've customized.

## Uninstall

```bash
make uninstall
```

## How it works

```
┌──────────────────────────────────────────────────────────────────────┐
│  Copilot CLI                                                         │
│                                                                      │
│  /agent     → discovers ~/.copilot/agents/*.agent.md                │
│  Extension  → loads ~/.copilot/extensions/anvil/extension.mjs       │
└──┬───────┬───────┬───────┬───────┬───────┬───────────────────────── ┘
   │       │       │       │       │       │
 ┌─▼─────┐┌▼─────┐┌▼─────┐┌▼─────┐┌▼─────┐┌▼────────┐
 │ code  ││bicep ││arc-  ││aks-  ││archi-││Extension │
 │       ││      ││ ops  ││ ops  ││ tect ││ Runtime  │
 │agent  ││agent ││agent ││agent ││agent ││          │
 │ .md   ││ .md  ││ .md  ││ .md  ││ .md  ││ Tools +  │
 └───────┘└──────┘└──────┘└──────┘└──────┘│Guardrails│
                                           └──────────┘
```

Every anvil follows the same discipline:

1. **Pre-flight** — check git state, auth, prerequisites
2. **Baseline** — capture current build/lint/test results
3. **Change** — implement the task
4. **Verify** — re-run checks, compare to baseline
5. **Evidence bundle** — produce a ledger diff the reviewer can audit

## Extension tools

| Tool | Purpose |
|------|---------|
| `anvil_git_check` | Pre-flight git hygiene |
| `anvil_verify` | Run a command, format output for the SQL ledger |
| `anvil_evidence_bundle` | Generate the evidence bundle query |
| `anvil_bicep_lint` | `az bicep lint` with structured output |
| `anvil_bicep_build` | Compile Bicep → ARM, report errors |
| `anvil_bicep_param_check` | Cross-check `.bicep` params vs `.bicepparam` files |
| `anvil_ops_check` | Pre-flight Azure auth + Arc CLI check |
| `anvil_ops_inventory` | List Arc-enabled servers |
| `anvil_ops_preview` | Dry-run preview for Arc operations |
| `anvil_aks_check` | Pre-flight kubectl, kubelogin, AKS check |
| `anvil_aks_inventory` | List AKS clusters and node pools |
| `anvil_aks_preview` | Preview AKS operations before execution |
| `anvil_architect_check` | Pre-flight for architecture design |
| `anvil_architect_cost` | Estimate monthly Azure costs |
| `anvil_architect_waf` | Check WAF compliance |
| `anvil_architect_inventory` | Query Azure for existing infrastructure inventory |
| `anvil_sovereign_check` | Pre-flight sovereignty classification check |
| `anvil_sovereign_validate` | Validate sovereignty profile YAML for consistency |
| `anvil_audit_scan` | Run Azure compliance checks by category (network/identity/data/monitoring/cost/policy) |

## Customization

Edit agents directly — changes take effect on next `/clear`:

```bash
$EDITOR ~/.copilot/agents/anvil-code.agent.md
```

### Create a new anvil

Drop a `.agent.md` file into `.github/agents/`:

```markdown
---
name: anvil-terraform
description: Evidence-first Terraform agent
---

# Terraform Agent

Behavioral instructions…
```

Then run `make install` (or `.\install.ps1`) to deploy it.

## Development

```bash
make lint          # Check extension syntax + agent frontmatter
make test          # Lint (no test suite yet)
make install       # Install from local clone
```

## License

MIT — see [LICENSE](LICENSE).
