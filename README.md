# 🔨 Anvil

Evidence-first coding agents for [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli). Anvil verifies code before presenting it, attacks its own output with adversarial multi-model review, and tracks every verification step in a SQL ledger.

This repository is a **marketplace** — install individual agent plugins or everything at once.

## Plugins

| Plugin | Description | Install |
|--------|-------------|---------|
| **anvil-core** | Shared commands (`/verify`, `/evidence`) and guardrails | Recommended for all users |
| **anvil-code** | General-purpose coding agent with adversarial review | Install if you write application code |
| **anvil-bicep** | Azure Bicep infrastructure agent with AVM modules | Install if you work with Azure Bicep |

## Install

### Option A: Install everything (extension + all plugins)

```bash
git clone https://github.com/msucharda/anvil.git
cd anvil
make install
```

This installs the extension runtime (tools and guardrails) plus all plugins to `~/.copilot/extensions/anvil/`.

### Option B: Install individual plugins via marketplace

Point Copilot CLI at this repository as a marketplace source, then install individual plugins:

```bash
# Install just the Bicep agent
copilot plugin install msucharda/anvil --plugin anvil-bicep

# Install just the general coding agent
copilot plugin install msucharda/anvil --plugin anvil-code
```

After installing, reload extensions in Copilot CLI:
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
rm -rf ~/.copilot/extensions/anvil
```

Or from the repo:
```bash
make uninstall
```

## Architecture

Anvil uses **two complementary systems**:

| Concern | System | Location |
|---------|--------|----------|
| **Agents & Routing** | Plugin system (marketplace) | `plugins/` |
| **Runtime Tools** | Extension SDK (`extension.mjs`) | `extension/` |

```
┌──────────────────────────────────────────────────────────────────┐
│  Copilot CLI                                                      │
│                                                                    │
│  Reads marketplace.json → discovers plugins                       │
│  Reads plugin.json → discovers agents, skills, commands           │
│  Connects to extension.mjs → gets tools and hooks                 │
└────────┬──────────────┬──────────────┬──────────────┬─────────────┘
         │              │              │              │
   ┌─────▼──────┐ ┌─────▼──────┐ ┌─────▼──────┐ ┌────▼─────┐
   │ anvil-core │ │ anvil-code │ │anvil-bicep │ │Extension │
   │            │ │            │ │            │ │          │
   │ /verify    │ │ agent      │ │ agent      │ │ Tools:   │
   │ /evidence  │ │ skill      │ │ skill      │ │ git_check│
   │ guardrails │ │            │ │            │ │ verify   │
   └────────────┘ └────────────┘ └────────────┘ │ bicep_*  │
                                                └──────────┘
```

## What Gets Installed

```
~/.copilot/extensions/anvil/
├── plugin.json             # Root manifest
├── extension.mjs           # Runtime — tools and hooks
├── version.txt             # Installed version
├── plugins/                # Marketplace plugins (source of truth)
│   ├── anvil-core/
│   │   ├── plugin.json
│   │   ├── hooks.json
│   │   └── commands/
│   │       ├── verify.md
│   │       └── evidence.md
│   ├── anvil-code/
│   │   ├── plugin.json
│   │   ├── agents/
│   │   │   └── anvil-code.agent.md
│   │   └── skills/
│   │       └── anvil-code/SKILL.md
│   └── anvil-bicep/
│       ├── plugin.json
│       ├── agents/
│       │   └── anvil-bicep.agent.md
│       └── skills/
│           └── anvil-bicep/SKILL.md
├── agents/                 # Assembled from plugins (for extension compat)
├── skills/                 # Assembled from plugins
└── commands/               # Assembled from plugins
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

## Commands

| Command | Description |
|---------|-------------|
| `/verify` | Run Anvil verification checks on current changes |
| `/evidence` | Generate an evidence bundle for the current task |

## Customization

### Edit Agent Behavior

Agent files live in `~/.copilot/extensions/anvil/plugins/*/agents/`. Edit them directly — changes take effect on next `/clear`:

```bash
$EDITOR ~/.copilot/extensions/anvil/plugins/anvil-code/agents/anvil-code.agent.md
```

### Add a New Plugin

Create a new directory under `plugins/` with a `plugin.json`, agent file, and skill:

```bash
mkdir -p plugins/anvil-terraform/agents plugins/anvil-terraform/skills/anvil-terraform
```

Add the plugin to `marketplace.json` and run `make install`.

### Agent File Format

```markdown
---
name: agent-name          # Required: unique identifier
description: One-liner    # Required: shown in agent listings
model: sonnet             # Optional: model for sub-agent dispatch
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
3. Add a `plugin.json`, agent file, and routing skill
4. Add the plugin to `.github/plugin/marketplace.json`
5. If the agent needs custom tools, add them to `extension/extension.mjs` with a unique prefix
6. Run `make lint` to verify syntax
7. Submit a PR

## License

MIT — see [LICENSE](LICENSE).
