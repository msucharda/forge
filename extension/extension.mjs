// Anvil — Evidence-first coding agents for GitHub Copilot CLI
// https://github.com/YOUR_USERNAME/anvil

import { execFile } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { joinSession } from "@github/copilot-sdk/extension";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = join(__dirname, "agents");

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

const DANGEROUS_CMD_RE = /\brm\s+.*-[^\s]*r[^\s]*f|rm\s+.*-[^\s]*f[^\s]*r|\brm\s+--recursive\b.*--force\b|\brm\s+--force\b.*--recursive\b/i;

function isDangerousCommand(cmd) {
    if (DANGEROUS_CMD_RE.test(cmd) && /\s\/(?:\s|$|"|')/.test(cmd)) return "recursive delete from root";
    return null;
}

// ---------------------------------------------------------------------------
// Agent discovery — reads agent names from agents/ and plugins/*/agents/
// (Agent registration is handled by plugin.json, not the extension SDK)
// ---------------------------------------------------------------------------

function discoverAgentNames() {
    const names = [];
    // Legacy: agents/ directory (extension-based install)
    if (existsSync(AGENTS_DIR)) {
        names.push(...readdirSync(AGENTS_DIR)
            .filter((f) => f.endsWith(".agent.md"))
            .map((f) => f.replace(".agent.md", "")));
    }
    // Marketplace: plugins/*/agents/ directories
    const pluginsDir = join(__dirname, "plugins");
    if (existsSync(pluginsDir)) {
        for (const plugin of readdirSync(pluginsDir)) {
            const agentsPath = join(pluginsDir, plugin, "agents");
            if (existsSync(agentsPath)) {
                names.push(...readdirSync(agentsPath)
                    .filter((f) => f.endsWith(".agent.md"))
                    .map((f) => f.replace(".agent.md", "")));
            }
        }
    }
    return [...new Set(names)];
}

const agentNames = discoverAgentNames();

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

const session = await joinSession({
    hooks: {
        onSessionStart: async (input) => {
            const names = agentNames.length > 0
                ? agentNames.map((n) => `\`${n}\``).join(", ")
                : "(none found)";
            return {
                additionalContext: [
                    `🔨 Anvil extension active. Loaded agents: ${names}.`,
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
                ].join("\n"),
            };
        },

        onPreToolUse: async (input) => {
            if (input.toolName === "bash") {
                const cmd = String(input.toolArgs?.command || "");
                const danger = isDangerousCommand(cmd);
                if (danger) {
                    return {
                        permissionDecision: "deny",
                        permissionDecisionReason: `🔨 Anvil: ${danger} is blocked.`,
                    };
                }
                // Warn on direct push to main/master
                if (/git\s+push\s.*\b(main|master)\b/i.test(cmd) || /git\s+push\s+origin\s+(main|master)\b/i.test(cmd)) {
                    return {
                        permissionDecision: "ask",
                        permissionDecisionReason: "🔨 Anvil: you're pushing directly to main/master. Are you sure?",
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
                // Apply same guardrails as onPreToolUse
                const danger = isDangerousCommand(args.command);
                if (danger) {
                    return JSON.stringify({
                        error: `🔨 Anvil blocked: ${danger} is not allowed via anvil_verify.`,
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
    ],
});

// Log loaded agents
if (agentNames.length > 0) {
    await session.log(`🔨 Anvil loaded: ${agentNames.join(", ")}`);
} else {
    await session.log("🔨 Anvil extension loaded (no agent files found in agents/)", { level: "warning" });
}
