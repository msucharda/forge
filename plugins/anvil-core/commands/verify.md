---
description: Run Anvil verification on current changes — captures build, lint, and test results in the SQL ledger
---

# Anvil Verify

Run Anvil verification checks on the current changes.

## Arguments

$ARGUMENTS

If a task ID is provided, use it. Otherwise, generate a task ID slug from the current context (branch name or recent changes).

## Process

1. **Detect task context** — determine task ID from arguments, branch name, or prompt
2. **Create verification ledger** if not already present:
   ```sql
   CREATE TABLE IF NOT EXISTS anvil_checks (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       task_id TEXT NOT NULL,
       phase TEXT NOT NULL,
       check_name TEXT NOT NULL,
       tool TEXT NOT NULL,
       command TEXT,
       exit_code INTEGER,
       output_snippet TEXT,
       passed INTEGER NOT NULL DEFAULT 0
   );
   ```
3. **Run baseline checks** (phase = 'baseline') using `anvil_verify`:
   - Build command (detect from project: `npm run build`, `dotnet build`, `go build`, etc.)
   - Lint command (detect from project)
   - Test command (detect from project)
   - For Bicep projects: `anvil_bicep_lint` and `anvil_bicep_build`
4. **Report results** — show pass/fail summary table
