# 🔨 Anvil

Evidence-first coding agents for [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli). Anvil verifies code before presenting it, attacks its own output with adversarial multi-model review, and tracks every verification step in a SQL ledger.

This repository is a **marketplace** — install individual agent plugins or everything at once.

## Plugins

| Plugin | Description | Install |
|--------|-------------|---------|
| **anvil-core** | Shared commands (`/verify`, `/evidence`) and guardrails | Recommended for all users |
| **anvil-code** | General-purpose coding agent with adversarial review | Install if you write application code |
| **anvil-bicep** | Azure Bicep infrastructure agent with AVM modules | Install if you work with Azure Bicep |
| **anvil-arc-ops** | Azure Arc operations agent with safety gates | Install if you manage Arc-enabled servers |
| **anvil-aks-ops** | AKS operations agent with safety gates | Install if you manage AKS clusters |
| **anvil-architect** | Azure architecture design agent with WAF compliance | Install if you design Azure solutions |

## Install

### Option A: Install everything (extension + all plugins)

```bash
git clone https://github.com/msucharda/anvil.git
cd anvil
make install
```

This installs:
- **Agents** to `~/.copilot/agents/` (discoverable via `/agent`)
- **Extension** (tools & hooks) to `~/.copilot/extensions/anvil/`

### Option B: Install individual plugins via marketplace

Point Copilot CLI at this repository as a marketplace source, then install individual plugins:

```bash
# Install just the Bicep agent
copilot plugin install msucharda/anvil --plugin anvil-bicep

# Install just the general coding agent
copilot plugin install msucharda/anvil --plugin anvil-code
```

After installing, reload in Copilot CLI:
```
/clear
```

## Update

Re-run the install command — the script detects existing installations and updates in place. User-modified agent files are backed up automatically.

```bash
cd anvil && git pull && make install
```

## Uninstall

```bash
make uninstall
```

Or manually:
```bash
rm -rf ~/.copilot/extensions/anvil
rm -f ~/.copilot/agents/anvil-*.agent.md
```

## Architecture

Anvil uses custom agents and an extension runtime installed to Copilot CLI discovery paths:

| Concern | System | Install Location |
|---------|--------|------------------|
| **Agents** | Custom agents (`.agent.md`) | `~/.copilot/agents/` → `/agent` |
| **Runtime Tools** | Extension SDK (`extension.mjs`) | `~/.copilot/extensions/anvil/` |
| **Commands** | Extension commands | `~/.copilot/extensions/anvil/commands/` |

```
┌──────────────────────────────────────────────────────────────────┐
│  Copilot CLI                                                      │
│                                                                    │
│  /agent     → discovers ~/.copilot/agents/*.agent.md              │
│  Extension  → loads ~/.copilot/extensions/anvil/extension.mjs     │
└────────┬──────────────┬──────────────┬──────────────┬─────────────┘
         │              │              │              │
   ┌─────▼──────┐ ┌─────▼──────┐ ┌─────▼──────┐ ┌────▼─────┐ ┌────▼─────┐
   │ anvil-core │ │ anvil-code │ │anvil-bicep │ │anvil-arc-│ │anvil-aks-│ │Extension│
   │            │ │            │ │            │ │  ops     │ │  ops     │ │         │
   │ /verify    │ │ agent.md   │ │ agent.md   │ │ agent.md │ │ agent.md │ │ Tools:  │
   │ /evidence  │ │            │ │            │ │ ops-     │ │ aks-     │ │ git_*   │
   │ guardrails │ │            │ │            │ │ guardrail│ │ guardrail│ │ bicep_* │
   └────────────┘ └────────────┘ └────────────┘ └──────────┘ └──────────┘ │ ops_*   │
                                                                           │ aks_*   │
                  ┌──────────────┐                                         │ arch_*  │
                  │anvil-        │                                         └─────────┘
                  │ architect    │
                  │ agent.md     │
                  └──────────────┘
```

## What Gets Installed

```
~/.copilot/
├── agents/                          ← Copilot CLI agent discovery (/agent)
│   ├── anvil-code.agent.md
│   ├── anvil-bicep.agent.md
│   ├── anvil-arc-ops.agent.md
│   ├── anvil-aks-ops.agent.md
│   └── anvil-architect.agent.md
└── extensions/
    └── anvil/
        ├── extension.mjs            ← Runtime — tools and hooks
        ├── plugin.json              ← Extension metadata
        ├── version.txt              ← Installed version
        ├── commands/                ← Slash commands
        │   ├── verify.md
        │   └── evidence.md
        └── plugins/                 ← Source packages (for reference)
            ├── anvil-core/
            ├── anvil-code/
            └── anvil-bicep/
```

## Extension Tools

The extension registers these tools, available in every Copilot CLI session:

| Tool | Description |
|------|-------------|
| `anvil_git_check` | Pre-flight git hygiene: dirty state, branch check, worktree detection |
| `anvil_verify` | Run any command and format output for the `anvil_checks` SQL ledger |
| `anvil_evidence_bundle` | Generate the Evidence Bundle query and formatting template |
| `anvil_bicep_lint` | Run `az bicep lint` with structured output |
| `anvil_bicep_build` | Compile Bicep to ARM template, report errors |
| `anvil_bicep_param_check` | Cross-reference `.bicep` params vs `.bicepparam` files |
| `anvil_ops_check` | Pre-flight Azure auth, subscription, and Arc CLI check |
| `anvil_ops_inventory` | List Arc-enabled servers with filtering |
| `anvil_ops_preview` | Dry-run preview for Arc operations |
| `anvil_aks_check` | Pre-flight Azure auth, kubectl, kubelogin, and AKS prerequisites |
| `anvil_aks_inventory` | List AKS clusters and node pools with health status |
| `anvil_aks_preview` | Preview impact of AKS operations before execution |
| `anvil_architect_check` | Pre-flight check for architecture design tasks |
| `anvil_architect_cost` | Estimate monthly cost for a set of Azure services |
| `anvil_architect_waf` | Check WAF compliance for selected Azure services |

## Commands

| Command | Description |
|---------|-------------|
| `/verify` | Run Anvil verification checks on current changes |
| `/evidence` | Generate an evidence bundle for the current task |

## Customization

### Edit Agent Behavior

Agent files live in `~/.copilot/agents/`. Edit them directly — changes take effect on next `/clear`:

```bash
$EDITOR ~/.copilot/agents/anvil-code.agent.md
```

### Add a New Plugin

Create a new directory under `plugins/` with a `plugin.json` and agent file:

```bash
mkdir -p plugins/anvil-terraform/agents
```

Add the plugin to `marketplace.json` and run `make install`.

### Agent File Format

```markdown
---
name: agent-name          # Required: unique identifier
description: One-liner    # Required: shown in agent listings
                          # model: omit to inherit the caller's model
---

# Agent Title

Full behavioral instructions in markdown...
```

## Development

```bash
# Check extension syntax, plugin.json, marketplace.json, and all plugin files
make lint

# Check only plugin files
make lint-plugins

# Run all checks
make test

# Install from local clone
make install
```

## Contributing

1. Fork the repo
2. Create your plugin in `plugins/your-plugin-name/`
3. Add a `plugin.json` and agent file
4. Add the plugin to `.github/plugin/marketplace.json`
5. If the agent needs custom tools, add them to `extension/extension.mjs` with a unique prefix
6. Run `make lint` to verify syntax
7. Submit a PR

## License

MIT — see [LICENSE](LICENSE).
