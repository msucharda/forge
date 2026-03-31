#!/usr/bin/env bash
# Anvil — Install / Update script
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/YOUR_USERNAME/anvil/main/install.sh | bash
#   OR: git clone ... && cd anvil && bash install.sh

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

REPO_URL="${ANVIL_REPO_URL:-https://github.com/YOUR_USERNAME/anvil.git}"
INSTALL_DIR="${HOME}/.copilot/extensions/anvil"
BACKUP_DIR="${HOME}/.copilot/extensions/.anvil-backup"
TMP_DIR=""

# Colors (disabled if not a terminal)
if [ -t 1 ]; then
    RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; BLUE=$'\033[0;34m'; BOLD=$'\033[1m'; NC=$'\033[0m'
else
    RED=''; GREEN=''; YELLOW=''; BLUE=''; BOLD=''; NC=''
fi

info()  { printf "${BLUE}▸${NC} %s\n" "$1"; }
ok()    { printf "${GREEN}✔${NC} %s\n" "$1"; }
warn()  { printf "${YELLOW}⚠${NC} %s\n" "$1"; }
error() { printf "${RED}✖${NC} %s\n" "$1" >&2; }
die()   { error "$1"; exit 1; }

cleanup() {
    if [ -n "${TMP_DIR}" ] && [ -d "${TMP_DIR}" ]; then
        rm -rf "${TMP_DIR}"
    fi
}
trap cleanup EXIT

# Portable checksum function (macOS has shasum, Linux has sha256sum)
file_hash() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d' ' -f1
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | cut -d' ' -f1
    else
        # Fallback: openssl (available on both platforms)
        openssl dgst -sha256 "$1" | awk '{print $NF}'
    fi
}

# ---------------------------------------------------------------------------
# Detect source: running from repo clone or curl pipe?
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
SOURCE_DIR=""

if [ -f "${SCRIPT_DIR}/extension/extension.mjs" ] && [ -d "${SCRIPT_DIR}/plugins" ]; then
    # Running from a local clone
    SOURCE_DIR="${SCRIPT_DIR}"
    info "Installing from local clone: ${SOURCE_DIR}"
else
    # Running from curl pipe — clone to temp
    command -v git >/dev/null 2>&1 || die "git is required but not installed"
    TMP_DIR="$(mktemp -d)"
    info "Cloning ${REPO_URL}..."
    git clone --depth 1 --quiet "${REPO_URL}" "${TMP_DIR}" || die "Failed to clone ${REPO_URL}"
    SOURCE_DIR="${TMP_DIR}"
    info "Cloned to temporary directory"
fi

# Verify source has required files
[ -f "${SOURCE_DIR}/extension/extension.mjs" ] || die "extension/extension.mjs not found in source"
[ -d "${SOURCE_DIR}/plugins" ] || die "plugins/ directory not found in source"
[ -f "${SOURCE_DIR}/plugin.json" ] || die "plugin.json not found in source"
[ -f "${SOURCE_DIR}/version.txt" ] || die "version.txt not found in source"

NEW_VERSION="$(cat "${SOURCE_DIR}/version.txt" | tr -d '[:space:]')"

# ---------------------------------------------------------------------------
# Check existing installation
# ---------------------------------------------------------------------------

IS_UPDATE=false
OLD_VERSION=""

if [ -d "${INSTALL_DIR}" ] && [ -f "${INSTALL_DIR}/extension.mjs" ]; then
    IS_UPDATE=true
    if [ -f "${INSTALL_DIR}/version.txt" ]; then
        OLD_VERSION="$(cat "${INSTALL_DIR}/version.txt" | tr -d '[:space:]')"
    fi

    if [ "${OLD_VERSION}" = "${NEW_VERSION}" ]; then
        ok "Anvil v${NEW_VERSION} is already installed and up to date"
        printf "  ${BOLD}Location${NC}: ${INSTALL_DIR}\n"
        exit 0
    fi

    info "Updating Anvil: v${OLD_VERSION:-unknown} → v${NEW_VERSION}"
else
    info "Installing Anvil v${NEW_VERSION}"
fi

# ---------------------------------------------------------------------------
# Backup user-modified agent files
# ---------------------------------------------------------------------------

if [ "${IS_UPDATE}" = true ] && [ -d "${INSTALL_DIR}/agents" ]; then
    info "Checking for user-modified agent files..."
    mkdir -p "${BACKUP_DIR}"

    for agent_file in "${INSTALL_DIR}/agents/"*.agent.md; do
        [ -f "${agent_file}" ] || continue
        base="$(basename "${agent_file}")"

        # Find matching source file in plugins/*/agents/
        source_file=""
        for plugin_dir in "${SOURCE_DIR}/plugins/"*/agents; do
            [ -d "${plugin_dir}" ] || continue
            if [ -f "${plugin_dir}/${base}" ]; then
                source_file="${plugin_dir}/${base}"
                break
            fi
        done

        if [ -n "${source_file}" ]; then
            installed_hash="$(file_hash "${agent_file}")"
            source_hash="$(file_hash "${source_file}")"
            if [ "${installed_hash}" != "${source_hash}" ]; then
                cp "${agent_file}" "${BACKUP_DIR}/${base}.bak"
                warn "Backed up modified agent: ${base} → ${BACKUP_DIR}/${base}.bak"
            fi
        else
            # User-created agent — back it up
            cp "${agent_file}" "${BACKUP_DIR}/${base}.bak"
            warn "Backed up custom agent: ${base} → ${BACKUP_DIR}/${base}.bak"
        fi
    done
fi

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------

mkdir -p "${INSTALL_DIR}/agents" "${INSTALL_DIR}/skills" "${INSTALL_DIR}/commands" "${INSTALL_DIR}/plugins"

# Copy extension
cp "${SOURCE_DIR}/extension/extension.mjs" "${INSTALL_DIR}/extension.mjs"
ok "Installed extension.mjs"

# Copy plugin manifest (root-level for extension compatibility)
cp "${SOURCE_DIR}/plugin.json" "${INSTALL_DIR}/plugin.json"
ok "Installed plugin.json"

# Copy plugins directory (marketplace structure)
rm -rf "${INSTALL_DIR}/plugins"
cp -r "${SOURCE_DIR}/plugins" "${INSTALL_DIR}/plugins"
plugin_count=$(ls -d "${INSTALL_DIR}/plugins/"*/ 2>/dev/null | wc -l)
ok "Installed ${plugin_count} plugin(s)"

# Assemble agents from all plugins into agents/ (for extension compatibility)
rm -f "${INSTALL_DIR}/agents/"*.agent.md 2>/dev/null || true
for plugin_agents in "${SOURCE_DIR}/plugins/"*/agents; do
    [ -d "${plugin_agents}" ] || continue
    cp "${plugin_agents}/"*.agent.md "${INSTALL_DIR}/agents/" 2>/dev/null || true
done
agent_count=$(ls -1 "${INSTALL_DIR}/agents/"*.agent.md 2>/dev/null | wc -l)
ok "Assembled ${agent_count} agent(s) from plugins"

# Assemble skills from all plugins into skills/
rm -rf "${INSTALL_DIR}/skills"
mkdir -p "${INSTALL_DIR}/skills"
for plugin_skills in "${SOURCE_DIR}/plugins/"*/skills; do
    [ -d "${plugin_skills}" ] || continue
    cp -r "${plugin_skills}/"* "${INSTALL_DIR}/skills/" 2>/dev/null || true
done
skill_count=$(find "${INSTALL_DIR}/skills" -name "SKILL.md" 2>/dev/null | wc -l)
ok "Assembled ${skill_count} skill(s) from plugins"

# Assemble commands from all plugins into commands/
rm -rf "${INSTALL_DIR}/commands"
mkdir -p "${INSTALL_DIR}/commands"
for plugin_commands in "${SOURCE_DIR}/plugins/"*/commands; do
    [ -d "${plugin_commands}" ] || continue
    cp "${plugin_commands}/"*.md "${INSTALL_DIR}/commands/" 2>/dev/null || true
done
cmd_count=$(ls -1 "${INSTALL_DIR}/commands/"*.md 2>/dev/null | wc -l)
ok "Assembled ${cmd_count} command(s) from plugins"

# Restore user-created agents (agents that exist in backup but not in source)
if [ -d "${BACKUP_DIR}" ]; then
    for bak_file in "${BACKUP_DIR}/"*.agent.md.bak; do
        [ -f "${bak_file}" ] || continue
        original_name="$(basename "${bak_file}" .bak)"

        # Check if this agent exists in any plugin
        found=false
        for plugin_agents in "${SOURCE_DIR}/plugins/"*/agents; do
            if [ -f "${plugin_agents}/${original_name}" ]; then
                found=true
                break
            fi
        done

        if [ "${found}" = false ]; then
            cp "${bak_file}" "${INSTALL_DIR}/agents/${original_name}"
            ok "Restored custom agent: ${original_name}"
        fi
    done
fi

# Copy version
cp "${SOURCE_DIR}/version.txt" "${INSTALL_DIR}/version.txt"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

printf "\n"
if [ "${IS_UPDATE}" = true ]; then
    ok "${BOLD}Anvil updated to v${NEW_VERSION}${NC}"
else
    ok "${BOLD}Anvil v${NEW_VERSION} installed${NC}"
fi
printf "\n"
printf "  ${BOLD}Location${NC}:   ${INSTALL_DIR}\n"
printf "  ${BOLD}Plugins${NC}:    ${INSTALL_DIR}/plugins/\n"
printf "  ${BOLD}Agents${NC}:     ${INSTALL_DIR}/agents/\n"
printf "  ${BOLD}Skills${NC}:     ${INSTALL_DIR}/skills/\n"
printf "  ${BOLD}Commands${NC}:   ${INSTALL_DIR}/commands/\n"
printf "  ${BOLD}Extension${NC}:  ${INSTALL_DIR}/extension.mjs\n"
printf "\n"

if [ -d "${BACKUP_DIR}" ] && [ "$(ls -A "${BACKUP_DIR}" 2>/dev/null)" ]; then
    printf "  ${YELLOW}Backed-up files${NC}: ${BACKUP_DIR}/\n"
    printf "  Review and merge your customizations if needed.\n"
    printf "\n"
fi

printf "  ${BOLD}Next steps${NC}:\n"
printf "  1. Reload extensions in Copilot CLI:  ${BLUE}/clear${NC}\n"
printf "  2. Or restart the CLI\n"
printf "\n"
printf "  ${BOLD}Customize agents${NC}:\n"
printf "  Edit files in ${INSTALL_DIR}/agents/ — changes take effect on next /clear\n"
printf "  Add new agents: drop a .agent.md file in the agents/ directory\n"
printf "\n"
printf "  ${BOLD}Uninstall${NC}:\n"
printf "  rm -rf ${INSTALL_DIR}\n"
printf "\n"
