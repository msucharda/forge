# 🔨 Anvil

Evidence-first coding agents for [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli). Anvil verifies code before presenting it, attacks its own output with adversarial multi-model review, and tracks every verification step in a SQL ledger.

## Agents

| Agent | Description |
|-------|-------------|
| **anvil** | General-purpose coding agent. Evidence-first workflow with adversarial review, SQL-tracked verification, and automatic git hygiene. |
| **anvil-bicep** | Azure Bicep infrastructure agent. Specializes in AVM modules, Bicep linting, PSRule WAF compliance, and ARM deployment validation. |

## Skills

Skills tell the main model **when to activate** each agent automatically based on user intent:

| Skill | Triggers On |
|-------|-------------|
| **anvil-code** | Code implementation, fixes, refactors — any non-infrastructure coding task |
| **anvil-bicep** | `.bicep` / `.bicepparam` files, AVM modules, Azure infrastructure changes |

## Commands

| Command | Description |
|---------|-------------|
| `/verify` | Run Anvil verification checks on current changes |
| `/evidence` | Generate an evidence bundle for the current task |

## Install

**One-liner** (requires `git`):

```bash
curl -fsSL https://raw.githubusercontent.com/YOUR_USERNAME/anvil/main/install.sh | bash
```

**Or clone and install:**

```bash
git clone https://github.com/YOUR_USERNAME/anvil.git
cd anvil
make install
```

After installing, reload extensions in Copilot CLI:
```
/clear
```

## Update

Re-run the install command — the script detects existing installations and updates in place. User-modified agent files are backed up automatically.

```bash
curl -fsSL https://raw.githubusercontent.com/YOUR_USERNAME/anvil/main/install.sh | bash
```

Or from a local clone:
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

## What Gets Installed

```
~/.copilot/extensions/anvil/
├── plugin.json            # Plugin manifest — declares agents, skills, commands
├── extension.mjs          # Extension — tools and hooks
├── version.txt            # Installed version
├── agents/                # Agent definitions (editable!)
│   ├── anvil.agent.md
│   └── anvil-bicep.agent.md
├── skills/                # Routing skills — auto-activate agents by intent
│   ├── anvil-code/
│   │   └── SKILL.md
│   └── anvil-bicep/
│       └── SKILL.md
└── commands/              # Slash commands
    ├── verify.md
    └── evidence.md
```

## Architecture

Anvil uses **two complementary systems**:

| Concern | System | Files |
|---------|--------|-------|
| **Routing** (which agent handles the task) | Plugin system (`plugin.json`) | `agents/`, `skills/`, `commands/` |
| **Runtime** (tools, guardrails, hooks) | Extension SDK (`extension.mjs`) | `extension.mjs` |

```
┌──────────────────────────────────────────────────────────────────┐
│  Copilot CLI Main Model                                          │
│                                                                  │
│  Reads plugin.json → discovers skills, commands, agents          │
│  Connects to extension.mjs → gets tools and hooks                │
└────────┬──────────────┬──────────────┬──────────────┬────────────┘
         │              │              │              │
   ┌─────▼─────┐  ┌─────▼─────┐  ┌────▼────┐  ┌─────▼──────┐
   │  Skills   │  │ Commands  │  │ Agents  │  │ Extension  │
   │           │  │           │  │         │  │            │
   │ anvil-    │  │ /verify   │  │ anvil   │  │ Tools:     │
   │  code     │  │ /evidence │  │ anvil-  │  │  git_check │
   │ anvil-    │  │           │  │  bicep  │  │  verify    │
   │  bicep    │  │           │  │         │  │  bicep_*   │
   └───────────┘  └───────────┘  └─────────┘  │ Hooks:     │
                                              │  guardrails│
                                              └────────────┘
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

## Extension Hooks

| Hook | Behavior |
|------|----------|
| Session start | Logs extension status, injects verification context |
| User prompt | Injects available tool reminders |
| Pre-tool | Blocks `rm -rf /`, warns on `git push` to main/master |
| Post-tool | Reminds to verify after Bicep file edits |

## Customization

### Edit Agent Behavior

Agent files live in `~/.copilot/extensions/anvil/agents/`. Edit them directly — changes take effect on next `/clear`:

```bash
# Open the general Anvil agent
$EDITOR ~/.copilot/extensions/anvil/agents/anvil.agent.md
```

### Add a New Agent

Drop a `.agent.md` file in the `agents/` directory and add a corresponding skill in `skills/`:

```bash
cat > ~/.copilot/extensions/anvil/agents/anvil-terraform.agent.md << 'EOF'
---
name: anvil-terraform
description: Evidence-first Terraform agent with HCL validation and plan verification.
model: sonnet
---

# Anvil Terraform

You are Anvil Terraform. You verify infrastructure code before presenting it...
EOF
```

Reload with `/clear` — the new agent appears automatically.

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
# Check extension syntax, plugin.json, and frontmatter
make lint

# Run all checks
make test

# Install from local clone
make install
```

## Contributing

1. Fork the repo
2. Add your agent file to `agents/` and a routing skill in `skills/`
3. If the agent needs custom tools, add them to `extension/extension.mjs` with a unique prefix
4. Run `make lint` to verify syntax
5. Submit a PR

## License

MIT — see [LICENSE](LICENSE).
