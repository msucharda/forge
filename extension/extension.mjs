// Anvil — Evidence-first coding agents for GitHub Copilot CLI
// https://github.com/msucharda/anvil

import { execFile } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { joinSession } from "@github/copilot-sdk/extension";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shell(cmd, args = [], opts = {}) {
    return new Promise((resolve) => {
        execFile(cmd, args, { maxBuffer: 2 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
            if (err) {
                const code = typeof err.code === "number" ? err.code : 1;
                resolve({ ok: false, code, stdout: stdout?.trim() ?? "", stderr: stderr?.trim() ?? err.message });
            } else {
                resolve({ ok: true, code: 0, stdout: stdout.trim(), stderr: stderr?.trim() ?? "" });
            }
        });
    });
}

function sqlEscape(s) {
    return String(s).replace(/'/g, "''");
}

function isDangerousCommand(cmd) {
    // Check for recursive + force rm targeting root
    const hasRecursive = /\brm\b.*(?:-[^\s-]*r|-R|--recursive)/i.test(cmd);
    const hasForce = /\brm\b.*(?:-[^\s-]*f|--force)/i.test(cmd);
    if (hasRecursive && hasForce && /(?:\s|"|')\/(?:\s|$|"|'|\*)/.test(cmd)) return "recursive delete from root";
    return null;
}

// Centralized command validation — called before every internal shell() call and onPreToolUse
function validateCommand(cmd) {
    const danger = isDangerousCommand(cmd);
    if (danger) return { reason: danger, decision: "deny" };
    // Arc destructive operations (defense-in-depth — shell hooks are primary)
    if (/az\s+connectedmachine\s+delete\b/.test(cmd)) return { reason: "connectedmachine delete removes Azure management plane access", decision: "ask" };
    if (/connectedmachine\s+extension\s+delete\b/.test(cmd)) return { reason: "extension delete removes monitoring/security agents", decision: "ask" };
    if (/connectedmachine\s+run-command\s+create\b/.test(cmd) && /--run-as-user\b/.test(cmd)) return { reason: "run-command with --run-as-user is blocked", decision: "deny" };
    if (/connectedmachine\s+run-command\s+create\b/.test(cmd) && /--async-execution\b/.test(cmd)) return { reason: "--async-execution is blocked", decision: "deny" };
    if (/connectedmachine\s+run-command\s+create\b/.test(cmd)) return { reason: "run-command executes code on remote servers", decision: "ask" };
    if (/connectedmachine\s+private-endpoint-connection\s+delete\b/.test(cmd)) return { reason: "private endpoint deletion is blocked", decision: "deny" };
    // AKS destructive operations (defense-in-depth — shell hooks are primary)
    if (/az\s+aks\s+delete\b/.test(cmd)) return { reason: "az aks delete destroys the entire cluster", decision: "deny" };
    if (/az\s+aks\s+rotate-certs\b/.test(cmd)) return { reason: "rotate-certs regenerates all cluster certificates and causes downtime", decision: "deny" };
    if (/kubectl\s+delete\b/.test(cmd) && /\b(namespace|ns)\b/.test(cmd)) return { reason: "kubectl delete namespace destroys an entire namespace", decision: "deny" };
    if (/kubectl\s+apply\s+(--filename|-f)\s+https?:\/\//.test(cmd)) return { reason: "applying manifests from remote URLs is blocked — download and review first", decision: "deny" };
    if (/az\s+aks\s+(delete|stop)\b/.test(cmd) && /(\s--yes|\s-y)(\s|$)/.test(cmd)) return { reason: "auto-confirm flag with destructive az aks command is blocked", decision: "deny" };
    if (/az\s+aks\s+stop\b/.test(cmd)) return { reason: "az aks stop takes the entire cluster offline", decision: "ask" };
    if (/az\s+aks\s+nodepool\s+delete\b/.test(cmd)) return { reason: "nodepool delete evicts all pods and destroys nodes", decision: "ask" };
    if (/az\s+aks\s+nodepool\s+scale\b/.test(cmd)) return { reason: /--node-count[=\s]+0\b/.test(cmd) ? "scaling to 0 nodes evicts all workloads" : "nodepool scale changes node count", decision: "ask" };
    if (/az\s+aks\s+upgrade\b/.test(cmd)) return { reason: /--control-plane-only\b/.test(cmd) ? "control-plane-only upgrade" : "full cluster upgrade cordons and drains all nodes", decision: "ask" };
    if (/az\s+aks\s+nodepool\s+upgrade\b/.test(cmd)) return { reason: "nodepool upgrade cordons and drains nodes", decision: "ask" };
    if (/az\s+aks\s+disable-addons\b/.test(cmd)) return { reason: "disabling addons removes cluster components", decision: "ask" };
    if (/az\s+aks\s+get-credentials\b/.test(cmd) && /--admin\b/.test(cmd)) return { reason: "admin credentials bypass Azure AD RBAC", decision: "ask" };
    if (/kubectl\s+delete\b/.test(cmd)) return { reason: "kubectl delete removes cluster resources", decision: "ask" };
    if (/kubectl\s+drain\b/.test(cmd)) return { reason: "kubectl drain evicts all pods from a node", decision: "ask" };
    if (/kubectl\s+scale\b/.test(cmd) && /--replicas[=\s]+0\b/.test(cmd)) return { reason: "kubectl scale --replicas=0 shuts down the workload entirely", decision: "ask" };
    if (/kubectl\s+exec\b/.test(cmd)) return { reason: "kubectl exec runs commands inside containers", decision: "ask" };
    if (/kubectl\s+edit\b/.test(cmd)) return { reason: "kubectl edit modifies live cluster resources", decision: "ask" };
    // Git push to main/master
    if (/git\s+push\s.*\b(main|master)\b/i.test(cmd)) return { reason: "push to main/master — use a feature branch", decision: "ask" };
    return null;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

const session = await joinSession({
    hooks: {
        onSessionStart: async (input) => {
            return {
                additionalContext: [
                    "🔨 Anvil extension active.",
                    "The anvil_checks SQL table schema is available for verification tracking.",
                    "Use anvil_git_check before starting Medium/Large tasks.",
                ].join("\n"),
            };
        },

        onUserPromptSubmitted: async (input) => {
            const prompt = String(input.userPrompt || "").toLowerCase();
            const readOnlyHint = (prompt.includes("diagnose") || prompt.includes("diagnosis") || prompt.includes("audit") || prompt.includes("compliance scan"))
                ? "\n⚠️ Diagnose/Audit agents are READ-ONLY. Do not execute any mutating Azure commands (create/update/delete). Only use read/list/show/get commands."
                : "";
            return {
                additionalContext: [
                    "Anvil extension is active. Custom tools available:",
                    "- anvil_git_check: pre-flight git hygiene",
                    "- anvil_verify: run a command and format for ledger INSERT",
                    "- anvil_bicep_lint: Bicep lint with structured output",
                    "- anvil_bicep_build: Bicep build (compile to ARM) with structured output",
                    "- anvil_bicep_param_check: cross-reference params vs .bicepparam files",
                    "- anvil_ops_check: pre-flight Azure auth, subscription, and Arc CLI check",
                    "- anvil_ops_inventory: list Arc-enabled servers with filtering",
                    "- anvil_ops_preview: dry-run preview for Arc operations",
                    "- anvil_aks_check: pre-flight Azure auth, kubectl, kubelogin, and AKS prerequisites",
                    "- anvil_aks_inventory: list AKS clusters and node pools with health status",
                    "- anvil_aks_preview: preview impact of AKS operations before execution",
                    "- anvil_architect_check: pre-flight check for architecture design tasks",
                    "- anvil_architect_cost: estimate monthly cost for a set of Azure services",
                    "- anvil_architect_waf: check WAF compliance for selected Azure services",
                    "- anvil_architect_inventory: query Azure for existing infrastructure inventory",
                    "- anvil_audit_scan: run Azure compliance checks by category (network/identity/data/monitoring/cost/policy)",
                    readOnlyHint,
                ].filter(Boolean).join("\n"),
            };
        },

        onPreToolUse: async (input) => {
            if (input.toolName === "bash") {
                const cmd = String(input.toolArgs?.command || "");
                const blocked = validateCommand(cmd);
                if (blocked) {
                    return {
                        permissionDecision: blocked.decision,
                        permissionDecisionReason: `🔨 Anvil: ${blocked.reason}.`,
                    };
                }
            }
        },

        onPostToolUse: async (input) => {
            if ((input.toolName === "edit" || input.toolName === "create") && input.toolResult?.resultType !== "failure") {
                const path = String(input.toolArgs?.path || "");
                if (path.endsWith(".bicep") || path.endsWith(".bicepparam")) {
                    return {
                        additionalContext: "Bicep file modified. Run anvil_bicep_lint and anvil_bicep_build to verify before presenting.",
                    };
                }
                if (/(^|\/)docs\/(adr|architecture)\//.test(path)) {
                    return {
                        additionalContext: "Architecture document modified. Validate Mermaid diagram syntax and WAF alignment before presenting.",
                    };
                }
            }
            if (input.toolName === "bash" && input.toolResult?.resultType !== "failure") {
                const cmd = String(input.toolArgs?.command || "");
                if (/az\s+connectedmachine\s+(extension\s+(create|delete|update)|upgrade-extension|run-command\s+create|install-patches)/.test(cmd)) {
                    return {
                        additionalContext: "Arc operation executed. Verify the result with anvil_ops_inventory or az connectedmachine show/extension show.",
                    };
                }
                if (/az\s+aks\s+(nodepool\s+(scale|upgrade|add|delete|update|stop|start)|upgrade|update|stop|start|enable-addons|disable-addons)\b/.test(cmd)) {
                    return {
                        additionalContext: "AKS operation executed. Verify the result with anvil_aks_inventory, az aks show, or kubectl get nodes.",
                    };
                }
                if (/kubectl\s+(apply|delete|scale|drain|cordon|uncordon|rollout|taint)\b/.test(cmd)) {
                    return {
                        additionalContext: "kubectl operation executed. Verify with kubectl get to confirm the expected state.",
                    };
                }
            }
        },
    },

    tools: [
        // ---------------------------------------------------------------
        // Shared Anvil tools
        // ---------------------------------------------------------------
        {
            name: "anvil_git_check",
            description: "Pre-flight git hygiene check: dirty state, current branch, worktree detection. Run before starting any Medium/Large Anvil task.",
            parameters: {
                type: "object",
                properties: {
                    task_id: { type: "string", description: "Task ID slug (e.g., fix-login-crash)" },
                },
                required: ["task_id"],
            },
            handler: async (args) => {
                const [status, branch, toplevel, gitDir, gitCommonDir] = await Promise.all([
                    shell("git", ["status", "--porcelain"]),
                    shell("git", ["rev-parse", "--abbrev-ref", "HEAD"]),
                    shell("git", ["rev-parse", "--show-toplevel"]),
                    shell("git", ["rev-parse", "--git-dir"]),
                    shell("git", ["rev-parse", "--git-common-dir"]),
                ]);

                const cwd = process.cwd();
                const isWorktree = gitDir.ok && gitCommonDir.ok && gitDir.stdout !== gitCommonDir.stdout;
                const report = {
                    dirty: status.ok && status.stdout.length > 0,
                    dirty_files: status.ok ? status.stdout.split("\n").filter(Boolean).length : 0,
                    dirty_output: status.ok ? status.stdout : "unknown",
                    branch: branch.ok ? branch.stdout : "unknown",
                    is_main_branch: branch.ok && ["main", "master"].includes(branch.stdout),
                    toplevel: toplevel.ok ? toplevel.stdout : "unknown",
                    cwd,
                    is_worktree: isWorktree,
                    suggested_branch: `anvil/${args.task_id}`,
                };

                const warnings = [];
                if (report.dirty) warnings.push(`⚠️ ${report.dirty_files} uncommitted file(s)`);
                if (report.is_main_branch) warnings.push(`⚠️ On ${report.branch} — consider creating a feature branch`);
                if (report.is_worktree) warnings.push("ℹ️ Running in a git worktree");
                if (warnings.length === 0) warnings.push("✅ Git state is clean");

                return JSON.stringify({ ...report, warnings }, null, 2);
            },
        },
        {
            name: "anvil_verify",
            description: "Run a verification command and return structured output ready for anvil_checks ledger INSERT. Wraps any shell command with exit code capture and output truncation.",
            parameters: {
                type: "object",
                properties: {
                    command: { type: "string", description: "Shell command to run (e.g., 'npm test', 'az bicep lint --file main.bicep')" },
                    check_name: { type: "string", description: "Name for the check (e.g., 'build', 'lint', 'test-suite')" },
                    task_id: { type: "string", description: "Task ID for the ledger" },
                    phase: { type: "string", enum: ["baseline", "after"], description: "Verification phase" },
                },
                required: ["command", "check_name", "task_id", "phase"],
            },
            handler: async (args) => {
                // Centralized guardrails — covers rm, Arc destructive ops, git push
                const blocked = validateCommand(args.command);
                if (blocked) {
                    return JSON.stringify({
                        error: `🔨 Anvil blocked: ${blocked.reason} is not allowed via anvil_verify.`,
                        passed: 0,
                    }, null, 2);
                }

                const result = await shell("bash", ["-c", args.command]);
                const output = (result.stdout || result.stderr || "").slice(0, 500);
                const passed = result.ok ? 1 : 0;
                const exitCode = typeof result.code === "number" ? result.code : (result.ok ? 0 : 1);

                return JSON.stringify({
                    check_name: args.check_name,
                    task_id: args.task_id,
                    phase: args.phase,
                    tool: "anvil_verify",
                    command: args.command,
                    exit_code: exitCode,
                    output_snippet: output,
                    passed,
                    sql: `INSERT INTO anvil_checks (task_id, phase, check_name, tool, command, exit_code, output_snippet, passed) VALUES ('${sqlEscape(args.task_id)}', '${sqlEscape(args.phase)}', '${sqlEscape(args.check_name)}', 'anvil_verify', '${sqlEscape(args.command)}', ${exitCode}, '${sqlEscape(output)}', ${passed});`,
                }, null, 2);
            },
        },
        {
            name: "anvil_evidence_bundle",
            description: "Generate the SQL query to produce the Anvil Evidence Bundle. Returns the query and formatting template — run the query with the sql tool, then present the results.",
            parameters: {
                type: "object",
                properties: {
                    task_id: { type: "string", description: "Task ID" },
                    size: { type: "string", enum: ["Small", "Medium", "Large"], description: "Task size" },
                    risk: { type: "string", enum: ["green", "yellow", "red"], description: "Risk level" },
                    files_changed: { type: "string", description: "Comma-separated list of changed files" },
                },
                required: ["task_id", "size", "risk"],
            },
            handler: async (args) => {
                const emoji = { green: "🟢", yellow: "🟡", red: "🔴" }[args.risk] || "🟡";
                const safeTaskId = sqlEscape(args.task_id);
                return [
                    `Run this SQL to generate the evidence bundle:`,
                    ``,
                    `\`\`\`sql`,
                    `SELECT phase, check_name, tool, command, exit_code, passed, output_snippet`,
                    `FROM anvil_checks WHERE task_id = '${safeTaskId}' ORDER BY phase, id;`,
                    `\`\`\``,
                    ``,
                    `Then present as:`,
                    ``,
                    `## 🔨 Anvil Evidence Bundle`,
                    `**Task**: ${args.task_id} | **Size**: ${args.size} | **Risk**: ${emoji}`,
                    args.files_changed ? `**Files**: ${args.files_changed}` : "",
                    ``,
                    `### Baseline (phase = 'baseline')`,
                    `| Check | Result | Command | Detail |`,
                    `|-------|--------|---------|--------|`,
                    ``,
                    `### Verification (phase = 'after')`,
                    `| Check | Result | Command | Detail |`,
                    `|-------|--------|---------|--------|`,
                    ``,
                    `### Adversarial Review (phase = 'review')`,
                    `| Model | Verdict | Findings |`,
                    `|-------|---------|----------|`,
                    ``,
                    `### Regressions`,
                    `Checks that went from passed=1 (baseline) to passed=0 (after). If none: "None detected."`,
                    ``,
                    `**Confidence**: High / Medium / Low`,
                    `**Rollback**: \`git checkout HEAD -- {files}\``,
                ].filter(Boolean).join("\n");
            },
        },

        // ---------------------------------------------------------------
        // Bicep-specific tools
        // ---------------------------------------------------------------
        {
            name: "anvil_bicep_lint",
            description: "Run 'az bicep lint' on a Bicep file and return structured results for the verification ledger.",
            parameters: {
                type: "object",
                properties: {
                    file: { type: "string", description: "Path to the .bicep file (default: infra/main.bicep)" },
                },
            },
            handler: async (args) => {
                const file = args.file || "infra/main.bicep";
                const result = await shell("az", ["bicep", "lint", "--file", file]);
                return JSON.stringify({
                    check: "bicep-lint",
                    file,
                    passed: result.ok,
                    exit_code: result.code,
                    output: (result.stdout || result.stderr || "").slice(0, 1000),
                }, null, 2);
            },
        },
        {
            name: "anvil_bicep_build",
            description: "Run 'az bicep build' to compile a Bicep file to ARM template. Catches syntax errors, type mismatches, and missing parameters.",
            parameters: {
                type: "object",
                properties: {
                    file: { type: "string", description: "Path to the .bicep file (default: infra/main.bicep)" },
                },
            },
            handler: async (args) => {
                const file = args.file || "infra/main.bicep";
                const result = await shell("az", ["bicep", "build", "--file", file, "--stdout"], { maxBuffer: 5 * 1024 * 1024 });
                return JSON.stringify({
                    check: "bicep-build",
                    file,
                    passed: result.ok,
                    exit_code: result.code,
                    // Don't return full ARM template — just success/failure + errors
                    output: result.ok
                        ? `Build succeeded (${result.stdout.length} bytes ARM template)`
                        : (result.stderr || result.stdout || "").slice(0, 1000),
                }, null, 2);
            },
        },
        {
            name: "anvil_bicep_param_check",
            description: "Cross-reference parameter declarations in a .bicep file against .bicepparam files. Finds parameters missing from any environment file.",
            parameters: {
                type: "object",
                properties: {
                    bicep_file: { type: "string", description: "Path to the .bicep file (default: infra/main.bicep)" },
                    param_glob: { type: "string", description: "Glob pattern for .bicepparam files (default: infra/main.*.bicepparam)" },
                },
            },
            handler: async (args) => {
                const bicepFile = args.bicep_file || "infra/main.bicep";
                const paramPattern = args.param_glob || "infra/main.*.bicepparam";

                // Find param files using Node fs (no shell injection)
                const paramDir = dirname(paramPattern);
                const globSuffix = basename(paramPattern);
                let paramFiles = [];
                try {
                    const dir = existsSync(paramDir) ? readdirSync(paramDir) : [];
                    // Convert simple glob pattern to regex (supports * wildcard)
                    const regexStr = "^" + globSuffix.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$";
                    const re = new RegExp(regexStr);
                    paramFiles = dir.filter((f) => re.test(f)).map((f) => join(paramDir, f));
                } catch {
                    paramFiles = [];
                }

                if (paramFiles.length === 0) {
                    return JSON.stringify({ error: `No .bicepparam files found matching ${paramPattern}` });
                }

                if (!existsSync(bicepFile)) {
                    return JSON.stringify({ error: `Bicep file not found: ${bicepFile}` });
                }
                const bicepContent = readFileSync(bicepFile, "utf-8");
                // Only collect params WITHOUT default values (those are required)
                const requiredParams = [];
                const allParams = [];
                for (const line of bicepContent.split("\n")) {
                    const match = line.match(/^param\s+(\w+)/);
                    if (match) {
                        allParams.push(match[1]);
                        // Param has a default if the line contains '=' after the type
                        if (!/=/.test(line.replace(/^param\s+\w+\s+\w+/, ""))) {
                            requiredParams.push(match[1]);
                        }
                    }
                }

                // Check each param file
                const results = {};
                for (const pf of paramFiles) {
                    const pfContent = readFileSync(pf, "utf-8");
                    const definedParams = [];
                    for (const line of pfContent.split("\n")) {
                        const match = line.match(/^param\s+(\w+)/);
                        if (match) definedParams.push(match[1]);
                    }
                    const missing = requiredParams.filter((p) => !definedParams.includes(p));
                    const extra = definedParams.filter((p) => !allParams.includes(p));
                    results[pf] = { missing, extra, ok: missing.length === 0 && extra.length === 0 };
                }

                return JSON.stringify({
                    bicep_file: bicepFile,
                    declared_params: allParams,
                    required_params: requiredParams,
                    param_files: results,
                    all_ok: Object.values(results).every((r) => r.ok),
                }, null, 2);
            },
        },

        // ---------------------------------------------------------------
        // Ops-specific tools (Azure Arc)
        // ---------------------------------------------------------------
        {
            name: "anvil_ops_check",
            description: "Pre-flight check for Azure Arc operations: verify Azure auth, active subscription, and connectedmachine CLI extension. Run before starting any Arc operations task.",
            parameters: {
                type: "object",
                properties: {
                    task_id: { type: "string", description: "Task ID slug (e.g., upgrade-mde-prod)" },
                },
                required: ["task_id"],
            },
            handler: async (args) => {
                const [account, ext] = await Promise.all([
                    shell("az", ["account", "show", "--query", "{name:name, id:id, tenantId:tenantId}", "-o", "json"]),
                    shell("az", ["extension", "show", "--name", "connectedmachine", "--query", "version", "-o", "tsv"]),
                ]);

                let subscription = null;
                if (account.ok) {
                    try { subscription = JSON.parse(account.stdout); }
                    catch { subscription = { error: "Failed to parse az output", raw: (account.stdout || "").slice(0, 200) }; }
                }

                const report = {
                    authenticated: account.ok,
                    subscription,
                    connectedmachine_cli: ext.ok ? ext.stdout : "not installed",
                    task_id: args.task_id,
                };

                const warnings = [];
                if (!account.ok) warnings.push("❌ Not authenticated — run 'az login' first");
                if (!ext.ok) warnings.push("⚠️ connectedmachine CLI extension not installed — run 'az extension add --name connectedmachine'");
                if (warnings.length === 0) warnings.push("✅ Azure auth and Arc CLI ready");

                return JSON.stringify({ ...report, warnings }, null, 2);
            },
        },
        {
            name: "anvil_ops_inventory",
            description: "List Azure Arc-enabled servers with optional filtering by resource group and status. Returns server name, status, OS type, and last status change.",
            parameters: {
                type: "object",
                properties: {
                    resource_group: { type: "string", description: "Azure resource group name (optional — lists all if omitted)" },
                    status_filter: { type: "string", enum: ["Connected", "Disconnected", "Error", "all"], description: "Filter by connection status (default: all)" },
                },
            },
            handler: async (args) => {
                const azArgs = ["connectedmachine", "list"];
                if (args.resource_group) {
                    azArgs.push("--resource-group", args.resource_group);
                }
                azArgs.push("--query", "[].{name:name, status:status, osType:osType, lastStatusChange:lastStatusChange, resourceGroup:resourceGroup}");
                azArgs.push("-o", "json");

                const result = await shell("az", azArgs);
                if (!result.ok) {
                    return JSON.stringify({ error: result.stderr || "Failed to list servers", exit_code: result.code });
                }

                let servers;
                try { servers = JSON.parse(result.stdout || "[]"); }
                catch { return JSON.stringify({ error: "Failed to parse az output", raw: (result.stdout || "").slice(0, 500) }); }
                if (args.status_filter && args.status_filter !== "all") {
                    servers = servers.filter(s => s.status === args.status_filter);
                }

                return JSON.stringify({
                    total: servers.length,
                    filter: args.status_filter || "all",
                    resource_group: args.resource_group || "(all)",
                    servers,
                }, null, 2);
            },
        },
        {
            name: "anvil_ops_preview",
            description: "Dry-run preview for Azure Arc operations. Shows what an operation would do without executing it. Wraps az commands with --what-if or equivalent preview flags.",
            parameters: {
                type: "object",
                properties: {
                    command: { type: "string", description: "The az connectedmachine command to preview (will be modified to add preview/what-if flags)" },
                    task_id: { type: "string", description: "Task ID for the ledger" },
                },
                required: ["command", "task_id"],
            },
            handler: async (args) => {
                const cmd = args.command;

                // Validate: must be an az connectedmachine command
                if (!/^\s*az\s+connectedmachine\b/.test(cmd)) {
                    return JSON.stringify({ error: "anvil_ops_preview only accepts 'az connectedmachine' commands." });
                }

                // Centralized guardrails
                const blocked = validateCommand(cmd);
                if (blocked) {
                    return JSON.stringify({ error: `🔨 Anvil blocked: ${blocked.reason}`, passed: 0 });
                }

                // Parse command into args array (split on whitespace, respecting quotes and --flag=value)
                function parseArgs(cmdStr) {
                    const args = [];
                    const re = /(?:'([^']*)'|"([^"]*)"|(\S+))/g;
                    let m;
                    while ((m = re.exec(cmdStr)) !== null) {
                        const token = m[1] ?? m[2] ?? m[3];
                        // Handle --flag="value with spaces" by stripping surrounding quotes from =value
                        const eqMatch = token.match(/^(--\w[\w-]*)=(?:"([^"]*)"|'([^']*)'|(.*))$/);
                        if (eqMatch) {
                            args.push(`${eqMatch[1]}=${eqMatch[2] ?? eqMatch[3] ?? eqMatch[4]}`);
                        } else {
                            args.push(token);
                        }
                    }
                    // Strip leading "az" — execFile will call az directly
                    if (args[0] === "az") args.shift();
                    return args;
                }

                // For patch operations, redirect to assess-patches
                if (/install-patches/.test(cmd)) {
                    const assessCmd = cmd.replace(/install-patches/, "assess-patches").replace(/--reboot-setting\s+\S+/, "");
                    const azArgs = parseArgs(assessCmd);
                    const result = await shell("az", azArgs);
                    const output = (result.stdout || result.stderr || "").slice(0, 1000);
                    return JSON.stringify({
                        preview_type: "assess-patches",
                        original_command: cmd,
                        preview_command: assessCmd,
                        exit_code: result.code,
                        output,
                        sql: `INSERT INTO anvil_checks (task_id, phase, check_name, tool, command, exit_code, output_snippet, passed) VALUES ('${sqlEscape(args.task_id)}', 'baseline', 'ops-preview', 'anvil_ops_preview', '${sqlEscape(assessCmd)}', ${result.code}, '${sqlEscape(output)}', ${result.ok ? 1 : 0});`,
                    }, null, 2);
                }

                // For extension operations, show current state as preview
                if (/extension\s+(create|delete|update)/.test(cmd)) {
                    const showCmd = cmd
                        .replace(/extension\s+(create|delete|update)/, "extension show")
                        .replace(/--publisher(?:=|\s+)(?:'[^']*'|"[^"]*"|\S+)/g, "")
                        .replace(/--type(?:=|\s+)(?:'[^']*'|"[^"]*"|\S+)/g, "")
                        .replace(/--settings(?:=|\s+)(?:'[^']*'|"[^"]*"|\S+)/g, "");
                    const azArgs = parseArgs(showCmd);
                    const result = await shell("az", azArgs);
                    const output = (result.stdout || result.stderr || "").slice(0, 1000);
                    return JSON.stringify({
                        preview_type: "current-state",
                        original_command: cmd,
                        preview_command: showCmd,
                        exit_code: result.code,
                        output,
                        note: "Showing current extension state. The original command will modify this.",
                    }, null, 2);
                }

                // Default: show target resource current state
                return JSON.stringify({
                    preview_type: "unsupported",
                    note: "No preview available for this command. Review the command manually before execution.",
                    original_command: cmd,
                }, null, 2);
            },
        },

        // ---------------------------------------------------------------
        // AKS-specific tools (Azure Kubernetes Service)
        // ---------------------------------------------------------------
        {
            name: "anvil_aks_check",
            description: "Pre-flight check for AKS operations: verify Azure auth, kubectl, kubelogin, aks-preview extension, and current kubeconfig context. Run before starting any AKS operations task.",
            parameters: {
                type: "object",
                properties: {
                    task_id: { type: "string", description: "Task ID slug (e.g., upgrade-aks-prod)" },
                },
                required: ["task_id"],
            },
            handler: async (args) => {
                const [account, kubectl, kubelogin, aksExt, context] = await Promise.all([
                    shell("az", ["account", "show", "--query", "{name:name, id:id, tenantId:tenantId}", "-o", "json"]),
                    shell("kubectl", ["version", "--client", "-o", "json"]),
                    shell("kubelogin", ["--version"]),
                    shell("az", ["extension", "show", "--name", "aks-preview", "--query", "version", "-o", "tsv"]),
                    shell("kubectl", ["config", "current-context"]),
                ]);

                let subscription = null;
                if (account.ok) {
                    try { subscription = JSON.parse(account.stdout); }
                    catch { subscription = { error: "Failed to parse az output", raw: (account.stdout || "").slice(0, 200) }; }
                }

                let kubectlVersion = null;
                if (kubectl.ok) {
                    try { kubectlVersion = JSON.parse(kubectl.stdout)?.clientVersion?.gitVersion || kubectl.stdout; }
                    catch { kubectlVersion = kubectl.stdout; }
                }

                const report = {
                    authenticated: account.ok,
                    subscription,
                    kubectl: kubectlVersion || "not installed",
                    kubelogin: kubelogin.ok ? kubelogin.stdout.split("\n")[0] : "not installed",
                    aks_preview_ext: aksExt.ok ? aksExt.stdout : "not installed",
                    kube_context: context.ok ? context.stdout : "none",
                    task_id: args.task_id,
                };

                const warnings = [];
                if (!account.ok) warnings.push("❌ Not authenticated — run 'az login' first");
                if (!kubectl.ok) warnings.push("❌ kubectl not installed");
                if (!kubelogin.ok) warnings.push("⚠️ kubelogin not installed — AAD auth will not work");
                if (!aksExt.ok) warnings.push("ℹ️ aks-preview CLI extension not installed (optional)");
                if (!context.ok) warnings.push("⚠️ No kubeconfig context set — run 'az aks get-credentials' first");
                if (warnings.length === 0) warnings.push("✅ Azure auth, kubectl, and AKS tooling ready");

                return JSON.stringify({ ...report, warnings }, null, 2);
            },
        },
        {
            name: "anvil_aks_inventory",
            description: "List AKS clusters and node pools with health status. Provide cluster and resource_group for a single cluster detail, or omit for a list of all clusters.",
            parameters: {
                type: "object",
                properties: {
                    resource_group: { type: "string", description: "Azure resource group name (optional — lists all if omitted)" },
                    cluster: { type: "string", description: "AKS cluster name (optional — requires resource_group)" },
                    include_nodepools: { type: "boolean", description: "Include node pool details (default: true)" },
                },
            },
            handler: async (args) => {
                const includeNodepools = args.include_nodepools !== false;

                // Single cluster detail mode
                if (args.cluster && args.resource_group) {
                    const calls = [
                        shell("az", ["aks", "show", "--name", args.cluster, "--resource-group", args.resource_group,
                            "--query", "{name:name, resourceGroup:resourceGroup, kubernetesVersion:kubernetesVersion, provisioningState:provisioningState, powerState:powerState.code, fqdn:fqdn, nodeResourceGroup:nodeResourceGroup, location:location}",
                            "-o", "json"]),
                    ];
                    if (includeNodepools) {
                        calls.push(shell("az", ["aks", "nodepool", "list", "--cluster-name", args.cluster, "--resource-group", args.resource_group,
                            "--query", "[].{name:name, vmSize:vmSize, count:count, mode:mode, provisioningState:provisioningState, powerState:powerState.code, orchestratorVersion:currentOrchestratorVersion, osType:osType, minCount:minCount, maxCount:maxCount, enableAutoScaling:enableAutoScaling}",
                            "-o", "json"]));
                    }
                    const results = await Promise.all(calls);
                    const clusterResult = results[0];
                    if (!clusterResult.ok) {
                        return JSON.stringify({ error: clusterResult.stderr || "Failed to get cluster", exit_code: clusterResult.code });
                    }
                    let cluster;
                    try { cluster = JSON.parse(clusterResult.stdout); }
                    catch { return JSON.stringify({ error: "Failed to parse cluster output", raw: (clusterResult.stdout || "").slice(0, 500) }); }

                    let nodepools = null;
                    if (includeNodepools && results[1]) {
                        if (results[1].ok) {
                            try { nodepools = JSON.parse(results[1].stdout || "[]"); }
                            catch { nodepools = { error: "Failed to parse nodepool output" }; }
                        } else {
                            nodepools = { error: results[1].stderr || "Failed to list node pools" };
                        }
                    }

                    return JSON.stringify({ cluster, nodepools }, null, 2);
                }

                // List mode
                const azArgs = ["aks", "list"];
                if (args.resource_group) {
                    azArgs.push("--resource-group", args.resource_group);
                }
                azArgs.push("--query", "[].{name:name, resourceGroup:resourceGroup, kubernetesVersion:kubernetesVersion, provisioningState:provisioningState, powerState:powerState.code, location:location}");
                azArgs.push("-o", "json");

                const result = await shell("az", azArgs);
                if (!result.ok) {
                    return JSON.stringify({ error: result.stderr || "Failed to list clusters", exit_code: result.code });
                }

                let clusters;
                try { clusters = JSON.parse(result.stdout || "[]"); }
                catch { return JSON.stringify({ error: "Failed to parse az output", raw: (result.stdout || "").slice(0, 500) }); }

                return JSON.stringify({
                    total: clusters.length,
                    resource_group: args.resource_group || "(all)",
                    clusters,
                }, null, 2);
            },
        },
        {
            name: "anvil_aks_preview",
            description: "Preview impact of AKS operations before execution. Validates the command, checks guardrails, and gathers current state to show what would change.",
            parameters: {
                type: "object",
                properties: {
                    command: { type: "string", description: "The az aks or kubectl command to preview" },
                    task_id: { type: "string", description: "Task ID for the ledger" },
                    cluster: { type: "string", description: "AKS cluster name (optional — helps gather context)" },
                    resource_group: { type: "string", description: "Azure resource group (optional)" },
                },
                required: ["command", "task_id"],
            },
            handler: async (args) => {
                const cmd = args.command;

                // Validate: must be an az aks or kubectl command
                if (!/^\s*(az\s+aks|kubectl)\b/.test(cmd)) {
                    return JSON.stringify({ error: "anvil_aks_preview only accepts 'az aks' or 'kubectl' commands." });
                }

                // Centralized guardrails
                const blocked = validateCommand(cmd);
                if (blocked && blocked.decision === "deny") {
                    return JSON.stringify({ error: `🔨 Anvil blocked: ${blocked.reason}`, passed: 0 });
                }

                const rg = args.resource_group;
                const cluster = args.cluster;

                // Upgrade preview: show available upgrades + current version
                if (/az\s+aks\s+(upgrade|nodepool\s+upgrade)\b/.test(cmd) && rg && cluster) {
                    const [upgrades, show] = await Promise.all([
                        shell("az", ["aks", "get-upgrades", "--name", cluster, "--resource-group", rg, "-o", "json"]),
                        shell("az", ["aks", "show", "--name", cluster, "--resource-group", rg,
                            "--query", "{name:name, kubernetesVersion:kubernetesVersion, provisioningState:provisioningState, powerState:powerState.code}",
                            "-o", "json"]),
                    ]);
                    const output = JSON.stringify({
                        available_upgrades: upgrades.ok ? (upgrades.stdout || "").slice(0, 1500) : upgrades.stderr,
                        current_state: show.ok ? (show.stdout || "").slice(0, 500) : show.stderr,
                    });
                    return JSON.stringify({
                        preview_type: "upgrade",
                        original_command: cmd,
                        guardrail: blocked ? `⚠️ ${blocked.reason} (decision: ${blocked.decision})` : "✅ passed",
                        output,
                        sql: `INSERT INTO anvil_checks (task_id, phase, check_name, tool, command, exit_code, output_snippet, passed) VALUES ('${sqlEscape(args.task_id)}', 'baseline', 'aks-preview', 'anvil_aks_preview', '${sqlEscape(cmd)}', 0, '${sqlEscape(output.slice(0, 500))}', 1);`,
                    }, null, 2);
                }

                // Scale preview: show current node pool state
                if (/az\s+aks\s+nodepool\s+scale\b/.test(cmd) && rg && cluster) {
                    const pools = await shell("az", ["aks", "nodepool", "list", "--cluster-name", cluster, "--resource-group", rg,
                        "--query", "[].{name:name, count:count, vmSize:vmSize, minCount:minCount, maxCount:maxCount, enableAutoScaling:enableAutoScaling, powerState:powerState.code}",
                        "-o", "json"]);
                    const output = pools.ok ? (pools.stdout || "").slice(0, 1500) : pools.stderr;
                    return JSON.stringify({
                        preview_type: "scale",
                        original_command: cmd,
                        guardrail: blocked ? `⚠️ ${blocked.reason} (decision: ${blocked.decision})` : "✅ passed",
                        current_nodepools: output,
                        sql: `INSERT INTO anvil_checks (task_id, phase, check_name, tool, command, exit_code, output_snippet, passed) VALUES ('${sqlEscape(args.task_id)}', 'baseline', 'aks-preview', 'anvil_aks_preview', '${sqlEscape(cmd)}', 0, '${sqlEscape(String(output).slice(0, 500))}', 1);`,
                    }, null, 2);
                }

                // Default: show cluster state
                if (rg && cluster) {
                    const show = await shell("az", ["aks", "show", "--name", cluster, "--resource-group", rg, "-o", "json"]);
                    const output = show.ok ? (show.stdout || "").slice(0, 1500) : show.stderr;
                    return JSON.stringify({
                        preview_type: "current-state",
                        original_command: cmd,
                        guardrail: blocked ? `⚠️ ${blocked.reason} (decision: ${blocked.decision})` : "✅ passed",
                        output,
                        sql: `INSERT INTO anvil_checks (task_id, phase, check_name, tool, command, exit_code, output_snippet, passed) VALUES ('${sqlEscape(args.task_id)}', 'baseline', 'aks-preview', 'anvil_aks_preview', '${sqlEscape(cmd)}', 0, '${sqlEscape(String(output).slice(0, 500))}', 1);`,
                    }, null, 2);
                }

                return JSON.stringify({
                    preview_type: "no-context",
                    original_command: cmd,
                    guardrail: blocked ? `⚠️ ${blocked.reason} (decision: ${blocked.decision})` : "✅ passed",
                    note: "Provide cluster and resource_group for a detailed preview.",
                }, null, 2);
            },
        },

        // ---------------------------------------------------------------
        // Architect-specific tools (Azure Architecture Design)
        // ---------------------------------------------------------------
        {
            name: "anvil_architect_check",
            description: "Pre-flight check for architecture design: verify Azure auth, existing infrastructure files, copilot-instructions.md, and ADR directory. Run before starting any architecture design task.",
            parameters: {
                type: "object",
                properties: {
                    task_id: { type: "string", description: "Task ID slug (e.g., design-data-platform)" },
                },
                required: ["task_id"],
            },
            handler: async (args) => {
                const [account, bicepFiles, tfFiles, copilotInstructions, adrDir, archDir] = await Promise.all([
                    shell("az", ["account", "show", "--query", "{name:name, id:id, tenantId:tenantId}", "-o", "json"]),
                    shell("bash", ["-c", "find . -name '*.bicep' -not -path './.git/*' 2>/dev/null | head -20"]),
                    shell("bash", ["-c", "find . -name '*.tf' -not -path './.git/*' 2>/dev/null | head -20"]),
                    shell("bash", ["-c", "test -f .github/copilot-instructions.md && echo 'found' || echo 'not found'"]),
                    shell("bash", ["-c", "ls docs/adr/ 2>/dev/null | head -20 || echo 'NOT_FOUND'"]),
                    shell("bash", ["-c", "ls docs/architecture/ 2>/dev/null | head -20 || echo 'NOT_FOUND'"]),
                ]);

                let subscription = null;
                if (account.ok) {
                    try { subscription = JSON.parse(account.stdout); }
                    catch { subscription = { error: "Failed to parse az output", raw: (account.stdout || "").slice(0, 200) }; }
                }

                const bicepList = bicepFiles.ok ? bicepFiles.stdout.split("\n").filter(Boolean) : [];
                const tfList = tfFiles.ok ? tfFiles.stdout.split("\n").filter(Boolean) : [];
                const hasInstructions = copilotInstructions.ok && copilotInstructions.stdout.trim() === "found";
                const hasAdrs = adrDir.ok && adrDir.stdout.trim() !== "NOT_FOUND" && adrDir.stdout.trim().length > 0;
                const hasArchDocs = archDir.ok && archDir.stdout.trim() !== "NOT_FOUND" && archDir.stdout.trim().length > 0;

                const report = {
                    authenticated: account.ok,
                    subscription,
                    existing_infra: {
                        bicep_files: bicepList.length,
                        terraform_files: tfList.length,
                        files: [...bicepList, ...tfList].slice(0, 10),
                    },
                    copilot_instructions: hasInstructions,
                    existing_adrs: hasAdrs ? adrDir.stdout.trim().split("\n").filter(Boolean) : [],
                    existing_arch_docs: hasArchDocs ? archDir.stdout.trim().split("\n").filter(Boolean) : [],
                    task_id: args.task_id,
                };

                const warnings = [];
                if (!account.ok) warnings.push("⚠️ Not authenticated to Azure — cost estimation and WAF queries will be limited");
                if (!hasInstructions) warnings.push("ℹ️ No .github/copilot-instructions.md — platform context unavailable");
                if (bicepList.length === 0 && tfList.length === 0) warnings.push("ℹ️ No existing infrastructure files found");
                if (bicepList.length > 0) warnings.push(`✅ Found ${bicepList.length} Bicep file(s)`);
                if (tfList.length > 0) warnings.push(`✅ Found ${tfList.length} Terraform file(s)`);
                if (hasAdrs) warnings.push(`✅ Found existing ADRs in docs/adr/`);
                if (warnings.length === 0) warnings.push("✅ Ready for architecture design");

                return JSON.stringify({ ...report, warnings }, null, 2);
            },
        },
        {
            name: "anvil_architect_cost",
            description: "Format and sum cost estimates for a set of Azure services. This is a calculator — it sums caller-provided estimates into a structured table. For verified pricing, use AzureMCPServer-pricing to look up actual retail prices before calling this tool.",
            parameters: {
                type: "object",
                properties: {
                    services: {
                        type: "string",
                        description: "JSON array of services: [{\"service\": \"Container Apps\", \"sku\": \"Consumption\", \"region\": \"swedencentral\", \"quantity\": 3, \"estimated_monthly\": 45}]. Use AzureMCPServer-pricing to get actual prices before populating estimated_monthly.",
                    },
                    task_id: { type: "string", description: "Task ID for the ledger" },
                },
                required: ["services", "task_id"],
            },
            handler: async (args) => {
                let services;
                try {
                    services = JSON.parse(args.services);
                } catch {
                    return JSON.stringify({ error: "Invalid JSON in services parameter" });
                }

                if (!Array.isArray(services) || services.length === 0) {
                    return JSON.stringify({ error: "services must be a non-empty JSON array" });
                }

                let totalMonthly = 0;
                const rows = [];
                for (const svc of services) {
                    const monthly = Number(svc.estimated_monthly) || 0;
                    totalMonthly += monthly * (Number(svc.quantity) || 1);
                    rows.push({
                        service: svc.service || "Unknown",
                        sku: svc.sku || "N/A",
                        region: svc.region || "N/A",
                        quantity: svc.quantity || 1,
                        monthly_per_unit: monthly,
                        monthly_total: monthly * (Number(svc.quantity) || 1),
                    });
                }

                return JSON.stringify({
                    task_id: args.task_id,
                    cost_summary: {
                        services: rows,
                        total_monthly: totalMonthly,
                        total_annual: totalMonthly * 12,
                        currency: "USD",
                        disclaimer: "This is a calculator — values are caller-provided estimates. Verify with AzureMCPServer-pricing for evidence-based costs. Actual costs may differ with EA/CSP agreements, reserved instances, or consumption patterns.",
                    },
                    note: "Do NOT INSERT this as a passed verification check. Use AzureMCPServer-pricing to verify costs first, then INSERT with evidence.",
                }, null, 2);
            },
        },
        {
            name: "anvil_architect_waf",
            description: "Check Well-Architected Framework compliance for selected Azure services. Returns a summary of which services have WAF guidance available and key recommendations.",
            parameters: {
                type: "object",
                properties: {
                    services: {
                        type: "string",
                        description: "Comma-separated list of Azure service names (e.g., 'container-apps,postgresql,key-vault')",
                    },
                    task_id: { type: "string", description: "Task ID for the ledger" },
                },
                required: ["services", "task_id"],
            },
            handler: async (args) => {
                const serviceList = args.services.split(",").map((s) => s.trim()).filter(Boolean);

                if (serviceList.length === 0) {
                    return JSON.stringify({ error: "No services provided" });
                }

                return JSON.stringify({
                    services: serviceList,
                    service_count: serviceList.length,
                    instruction: "Call wellarchitectedframework_serviceguide_get for EACH service listed below. After getting real WAF guidance, INSERT results into the verification ledger. Do NOT INSERT a passed check until actual WAF data is retrieved.",
                    example_sql: `-- INSERT AFTER calling wellarchitectedframework_serviceguide_get:\nINSERT INTO anvil_checks (task_id, phase, check_name, tool, command, exit_code, output_snippet, passed) VALUES ('${sqlEscape(args.task_id)}', 'after', 'waf-{service_name}', 'wellarchitectedframework_serviceguide_get', 'WAF check for {service_name}', 0, '{summary_of_guidance}', 1);`,
                }, null, 2);
            },
        },
        // ---------------------------------------------------------------
        // Architect inventory tool
        // ---------------------------------------------------------------
        {
            name: "anvil_architect_inventory",
            description: "Query Azure for existing infrastructure: resource groups, VNets, subnets, DNS zones, databases, compute, and Key Vaults. Returns structured inventory for architecture design context.",
            parameters: {
                type: "object",
                properties: {
                    resource_group: { type: "string", description: "Scope to a specific resource group (optional — queries subscription if omitted)" },
                    task_id: { type: "string", description: "Task ID for the ledger" },
                },
                required: ["task_id"],
            },
            handler: async (args) => {
                const rgArgs = args.resource_group ? ["--resource-group", args.resource_group] : [];
                const rgLabel = args.resource_group || "(subscription)";

                const [resources, vnets, keyvaults, databases] = await Promise.all([
                    shell("az", ["resource", "list", ...rgArgs,
                        "--query", "[].{name:name, type:type, location:location, resourceGroup:resourceGroup}",
                        "-o", "json"]),
                    shell("az", ["network", "vnet", "list", ...rgArgs,
                        "--query", "[].{name:name, addressSpace:addressSpace.addressPrefixes, subnets:subnets[].{name:name, prefix:addressPrefix}, resourceGroup:resourceGroup, location:location}",
                        "-o", "json"]),
                    shell("az", ["keyvault", "list", ...rgArgs,
                        "--query", "[].{name:name, resourceGroup:resourceGroup, location:location, enablePurgeProtection:properties.enablePurgeProtection}",
                        "-o", "json"]),
                    shell("az", ["resource", "list", ...rgArgs,
                        "--query", "[?contains(type,'Microsoft.DBforPostgreSQL') || contains(type,'Microsoft.Sql') || contains(type,'Microsoft.DocumentDB')].{name:name, type:type, location:location, resourceGroup:resourceGroup}",
                        "-o", "json"]),
                ]);

                const parse = (result) => {
                    if (!result.ok) return { error: result.stderr || "query failed" };
                    try { return JSON.parse(result.stdout || "[]"); }
                    catch { return { error: "parse failed" }; }
                };

                const inventory = {
                    scope: rgLabel,
                    task_id: args.task_id,
                    resources: parse(resources),
                    vnets: parse(vnets),
                    keyvaults: parse(keyvaults),
                    databases: parse(databases),
                    resource_count: Array.isArray(parse(resources)) ? parse(resources).length : 0,
                };

                const snippet = JSON.stringify(inventory).slice(0, 500);
                inventory.sql = `INSERT INTO anvil_checks (task_id, phase, check_name, tool, command, exit_code, output_snippet, passed) VALUES ('${sqlEscape(args.task_id)}', 'baseline', 'research-inventory', 'anvil_architect_inventory', 'az resource/vnet/keyvault/db list (scope: ${sqlEscape(rgLabel)})', 0, '${sqlEscape(snippet)}', 1);`;

                return JSON.stringify(inventory, null, 2);
            },
        },

        // ---------------------------------------------------------------
        // Audit scan tool (read-only compliance checks)
        // ---------------------------------------------------------------
        {
            name: "anvil_audit_scan",
            description: "Run Azure compliance checks for a specific category (network, identity, data, monitoring, cost, policy). Returns structured findings for the audit report. Read-only — never modifies resources.",
            parameters: {
                type: "object",
                properties: {
                    category: { type: "string", enum: ["network", "identity", "data", "monitoring", "cost", "policy"], description: "Audit category to scan" },
                    resource_group: { type: "string", description: "Scope to a resource group (optional — scans subscription if omitted)" },
                    task_id: { type: "string", description: "Task ID for the ledger" },
                },
                required: ["category", "task_id"],
            },
            handler: async (args) => {
                const rgArgs = args.resource_group ? ["--resource-group", args.resource_group] : [];
                const rgLabel = args.resource_group || "(subscription)";
                const findings = [];

                const runCheck = async (name, azArgs, assessFn) => {
                    const result = await shell("az", azArgs);
                    if (!result.ok) {
                        findings.push({ check: name, severity: "info", finding: `Query failed: ${(result.stderr || "").slice(0, 200)}` });
                        return;
                    }
                    let data;
                    try { data = JSON.parse(result.stdout || "[]"); } catch { return; }
                    if (Array.isArray(data)) assessFn(data);
                };

                switch (args.category) {
                    case "network":
                        await runCheck("public-ips", ["network", "public-ip", "list", ...rgArgs, "-o", "json"], (ips) => {
                            for (const ip of ips) {
                                findings.push({ check: "public-ip", severity: "high", resource: ip.name, finding: `Public IP exists: ${ip.ipAddress || "unassigned"}`, resourceGroup: ip.resourceGroup });
                            }
                        });
                        await runCheck("nsg-rules", ["network", "nsg", "list", ...rgArgs, "--query", "[].{name:name, rules:securityRules[?access=='Allow' && direction=='Inbound' && sourceAddressPrefix=='*'].{name:name, destPort:destinationPortRange, priority:priority}, resourceGroup:resourceGroup}", "-o", "json"], (nsgs) => {
                            for (const nsg of nsgs) {
                                if (nsg.rules && nsg.rules.length > 0) {
                                    for (const rule of nsg.rules) {
                                        findings.push({ check: "nsg-open-rule", severity: rule.destPort === "*" ? "critical" : "high", resource: `${nsg.name}/${rule.name}`, finding: `Inbound rule allows * source to port ${rule.destPort}`, resourceGroup: nsg.resourceGroup });
                                    }
                                }
                            }
                        });
                        break;

                    case "identity":
                        await runCheck("broad-rbac", ["role", "assignment", "list", ...rgArgs, "--query", "[?roleDefinitionName=='Owner' || roleDefinitionName=='Contributor'].{principal:principalName, role:roleDefinitionName, scope:scope, principalType:principalType}", "-o", "json"], (assignments) => {
                            for (const a of assignments) {
                                if (a.scope && !a.scope.includes("/resourceGroups/")) {
                                    findings.push({ check: "broad-rbac", severity: "high", resource: a.principal, finding: `${a.role} at subscription scope (${a.principalType})` });
                                }
                            }
                        });
                        break;

                    case "data":
                        await runCheck("storage-security", ["storage", "account", "list", ...rgArgs, "--query", "[].{name:name, allowBlobPublicAccess:allowBlobPublicAccess, httpsOnly:enableHttpsTrafficOnly, minimumTlsVersion:minimumTlsVersion, resourceGroup:resourceGroup}", "-o", "json"], (accounts) => {
                            for (const a of accounts) {
                                if (a.allowBlobPublicAccess) findings.push({ check: "public-blob", severity: "critical", resource: a.name, finding: "Blob public access enabled", resourceGroup: a.resourceGroup });
                                if (!a.httpsOnly) findings.push({ check: "no-https", severity: "high", resource: a.name, finding: "HTTPS-only not enforced", resourceGroup: a.resourceGroup });
                                if (a.minimumTlsVersion !== "TLS1_2") findings.push({ check: "old-tls", severity: "medium", resource: a.name, finding: `TLS version: ${a.minimumTlsVersion || "not set"}`, resourceGroup: a.resourceGroup });
                            }
                        });
                        break;

                    case "monitoring":
                        await runCheck("resources-without-diag", ["resource", "list", ...rgArgs, "--query", "[?type!='Microsoft.Network/networkSecurityGroups' && type!='Microsoft.Network/publicIPAddresses'].{name:name, type:type, id:id}", "-o", "json"], (resources) => {
                            // Note: full diagnostic settings check requires per-resource query — just report resource count
                            findings.push({ check: "resource-count", severity: "info", finding: `${resources.length} resources found — use 'az monitor diagnostic-settings list --resource {id}' per resource to verify diagnostic settings` });
                        });
                        break;

                    case "cost":
                        await runCheck("unattached-disks", ["disk", "list", ...rgArgs, "--query", "[?diskState=='Unattached'].{name:name, sizeGb:diskSizeGb, sku:sku.name, resourceGroup:resourceGroup}", "-o", "json"], (disks) => {
                            for (const d of disks) {
                                findings.push({ check: "orphan-disk", severity: "medium", resource: d.name, finding: `Unattached ${d.sku} disk (${d.sizeGb} GB)`, resourceGroup: d.resourceGroup });
                            }
                        });
                        await runCheck("stopped-vms", ["vm", "list", ...rgArgs, "-d", "--query", "[?powerState!='VM running'].{name:name, powerState:powerState, vmSize:hardwareProfile.vmSize, resourceGroup:resourceGroup}", "-o", "json"], (vms) => {
                            for (const vm of vms) {
                                if (vm.powerState !== "VM deallocated") {
                                    findings.push({ check: "stopped-vm-billed", severity: "high", resource: vm.name, finding: `VM ${vm.powerState} but not deallocated — still billed for compute (${vm.vmSize})`, resourceGroup: vm.resourceGroup });
                                }
                            }
                        });
                        break;

                    case "policy":
                        await runCheck("policy-compliance", ["policy", "state", "summarize", ...rgArgs, "--query", "value[?results.nonCompliantResources > `0`].{policy:policyDefinitionName, nonCompliant:results.nonCompliantResources}", "-o", "json"], (policies) => {
                            for (const p of policies) {
                                findings.push({ check: "non-compliant", severity: "high", resource: p.policy, finding: `${p.nonCompliant} non-compliant resource(s)` });
                            }
                        });
                        break;
                }

                const critical = findings.filter(f => f.severity === "critical").length;
                const high = findings.filter(f => f.severity === "high").length;
                const medium = findings.filter(f => f.severity === "medium").length;
                const low = findings.filter(f => f.severity === "low").length;
                const snippet = `${args.category}: ${critical} critical, ${high} high, ${medium} medium, ${low} low (${findings.length} total)`;

                return JSON.stringify({
                    category: args.category,
                    scope: rgLabel,
                    task_id: args.task_id,
                    summary: { critical, high, medium, low, total: findings.length },
                    findings,
                    sql: `INSERT INTO anvil_checks (task_id, phase, check_name, tool, command, exit_code, output_snippet, passed) VALUES ('${sqlEscape(args.task_id)}', 'after', 'audit-${sqlEscape(args.category)}', 'anvil_audit_scan', 'audit ${sqlEscape(args.category)} (scope: ${sqlEscape(rgLabel)})', 0, '${sqlEscape(snippet)}', ${critical === 0 ? 1 : 0});`,
                }, null, 2);
            },
        },
    ],
});

await session.log("🔨 Anvil extension loaded — tools and guardrails active");
