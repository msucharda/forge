# 🔨 Anvil

Evidence-first coding agents for [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli). Anvil verifies code before presenting it, attacks its own output with adversarial multi-model review, and tracks every verification step in a SQL ledger.

## Agents

| Agent | Description |
|-------|-------------|
| **anvil** | General-purpose coding agent. Evidence-first workflow with adversarial review, SQL-tracked verification, and automatic git hygiene. |
| **anvil-bicep** | Azure Bicep infrastructure agent. Specializes in AVM modules, Bicep linting, PSRule WAF compliance, and ARM deployment validation. |

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
├── extension.mjs          # Extension — tools, hooks, agent loader
├── version.txt            # Installed version
└── agents/                # Agent definitions (editable!)
    ├── anvil.agent.md
    └── anvil-bicep.agent.md
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

Drop a `.agent.md` file in the `agents/` directory. The extension auto-discovers and registers it:

```bash
cat > ~/.copilot/extensions/anvil/agents/anvil-terraform.agent.md << 'EOF'
---
name: anvil-terraform
description: Evidence-first Terraform agent with HCL validation and plan verification.
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
---

# Agent Title

Full behavioral instructions in markdown...
```

## Development

```bash
# Check extension syntax
make lint

# Run all checks
make test

# Install from local clone
make install
```

## How It Works

```
┌──────────────────────┐         ┌──────────────────────────────────┐
│  Copilot CLI         │ JSON-RPC│  Anvil Extension Process         │
│                      │◄───────►│                                  │
│  Routes tool calls   │  stdio  │  1. Reads agents/*.agent.md      │
│  Sends hook events   │         │  2. Registers customAgents       │
│  Manages lifecycle   │         │  3. Provides anvil_* tools       │
└──────────────────────┘         │  4. Enforces guardrails (hooks)  │
                                 └──────────────────────────────────┘
```

The extension is a single Node.js ES module that communicates with the Copilot CLI over JSON-RPC via stdio. It:

1. **Loads agents** from `agents/*.agent.md` at startup, parsing frontmatter for metadata
2. **Registers them** as `customAgents` via the SDK's `joinSession()` API
3. **Provides tools** the agents (and you) can call during sessions
4. **Enforces guardrails** via lifecycle hooks that intercept tool calls and prompts

## Contributing

1. Fork the repo
2. Add your agent file to `agents/`
3. If the agent needs custom tools, add them to `extension/extension.mjs` with a unique prefix
4. Run `make lint` to verify syntax
5. Submit a PR

## License

MIT — see [LICENSE](LICENSE).
