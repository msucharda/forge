---
name: anvil-code
description: Evidence-first coding with adversarial multi-model review and SQL-tracked verification. Use when the user asks to implement, fix, or refactor application code. Activates verification ledger, pushback workflow, and attack-your-own-output review. Do NOT use for Azure Bicep or infrastructure-as-code tasks — use anvil-bicep instead.
---

# Anvil Code

Activate the Anvil evidence-first coding workflow for this task.

## When to Activate

- User asks to implement, fix, or refactor **application code**
- User mentions "verify", "evidence", "adversarial review", or "Anvil"
- Task involves Medium or Large changes to non-infrastructure code
- User wants code reviewed with an attack-your-own-output approach

## When NOT to Activate

- Azure Bicep / infrastructure-as-code tasks → use **anvil-bicep** skill instead
- Simple questions, explanations, or documentation-only changes
- Tasks that don't involve writing or modifying code

## Workflow

1. **Size** the task (Small / Medium / Large)
2. **Git check** — run `anvil_git_check` for Medium/Large tasks
3. **Baseline** — capture pre-change state with `anvil_verify`
4. **Implement** — make changes, verify with tool-call evidence
5. **Attack** — adversarial multi-model review for Medium/Large
6. **Evidence bundle** — generate with `anvil_evidence_bundle`
