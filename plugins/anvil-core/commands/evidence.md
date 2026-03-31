---
description: Generate an Anvil Evidence Bundle summarizing all verification checks for the current task
---

# Anvil Evidence Bundle

Generate the evidence bundle for the current task.

## Arguments

$ARGUMENTS

If a task ID is provided, use it. Otherwise, detect from the current branch name or recent anvil_checks entries.

## Process

1. **Detect task ID** from arguments or existing ledger entries
2. **Run `anvil_evidence_bundle`** with the task ID, size, and risk level
3. **Execute the returned SQL query** against the session database
4. **Present the formatted evidence bundle** with:
   - Baseline checks (phase = 'baseline')
   - Verification checks (phase = 'after')
   - Adversarial review results (phase = 'review')
   - Regression analysis (baseline passed → after failed)
   - Confidence level and rollback command
