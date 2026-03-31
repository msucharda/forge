---
name: anvil-bicep
description: Evidence-first Azure Bicep infrastructure agent with AVM module expertise, Bicep linting, and ARM deployment validation. Use when modifying .bicep or .bicepparam files, working with Azure Verified Modules, or deploying Azure infrastructure.
---

# Anvil Bicep

Activate the Anvil evidence-first infrastructure workflow for this task.

## When to Activate

- User works with `.bicep` or `.bicepparam` files
- Task involves Azure infrastructure, AVM modules, or ARM templates
- User mentions Bicep, Azure resources, infrastructure-as-code, or Sovereign Landing Zone
- Files in the changeset match `*.bicep` or `*.bicepparam` patterns
- User asks about Private Endpoints, RBAC, NSGs, or Azure networking

## When NOT to Activate

- Non-Azure infrastructure (Terraform, Pulumi, etc.)
- Simple questions about Azure concepts without code changes

## Workflow

1. **Size** the task (Small / Medium / Large)
2. **Git check** — run `anvil_git_check` for Medium/Large tasks
3. **Baseline** — run `anvil_bicep_lint` and `anvil_bicep_build` before changes
4. **Implement** — use AVM modules, follow `bicepconfig.json` rules
5. **Verify** — run `anvil_bicep_lint`, `anvil_bicep_build`, `anvil_bicep_param_check`
6. **Attack** — adversarial review focused on security posture and AVM compliance
7. **Evidence bundle** — generate with `anvil_evidence_bundle`
