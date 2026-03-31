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
                ].join("\n"),
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
            }
            if (input.toolName === "bash" && input.toolResult?.resultType !== "failure") {
                const cmd = String(input.toolArgs?.command || "");
                if (/az\s+connectedmachine\s+(extension\s+(create|delete|update)|upgrade-extension|run-command\s+create|install-patches)/.test(cmd)) {
                    return {
                        additionalContext: "Arc operation executed. Verify the result with anvil_ops_inventory or az connectedmachine show/extension show.",
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
    ],
});

await session.log("🔨 Anvil extension loaded — tools and guardrails active");
