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

# ---------------------------------------------------------------------------
# Detect source: running from repo clone or curl pipe?
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
SOURCE_DIR=""

if [ -f "${SCRIPT_DIR}/extension/extension.mjs" ] && [ -d "${SCRIPT_DIR}/agents" ]; then
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
[ -d "${SOURCE_DIR}/agents" ] || die "agents/ directory not found in source"
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
        basename="$(basename "${agent_file}")"
        source_file="${SOURCE_DIR}/agents/${basename}"

        if [ -f "${source_file}" ]; then
            # Compare checksums — if user modified the file, back it up
            installed_hash="$(sha256sum "${agent_file}" | cut -d' ' -f1)"
            source_hash="$(sha256sum "${source_file}" | cut -d' ' -f1)"

            if [ "${installed_hash}" != "${source_hash}" ]; then
                # Check if the installed file matches the OLD source (not modified by user)
                # If we can't tell, assume user modified it and back up
                cp "${agent_file}" "${BACKUP_DIR}/${basename}.bak"
                warn "Backed up modified agent: ${basename} → ${BACKUP_DIR}/${basename}.bak"
            fi
        else
            # Agent file exists locally but not in source — user-created agent
            cp "${agent_file}" "${BACKUP_DIR}/${basename}.bak"
            warn "Backed up custom agent: ${basename} → ${BACKUP_DIR}/${basename}.bak"
        fi
    done
fi

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------

mkdir -p "${INSTALL_DIR}/agents"

# Copy extension
cp "${SOURCE_DIR}/extension/extension.mjs" "${INSTALL_DIR}/extension.mjs"
ok "Installed extension.mjs"

# Copy agent files
cp "${SOURCE_DIR}/agents/"*.agent.md "${INSTALL_DIR}/agents/" 2>/dev/null || true
agent_count=$(ls -1 "${INSTALL_DIR}/agents/"*.agent.md 2>/dev/null | wc -l)
ok "Installed ${agent_count} agent file(s)"

# Restore user-created agents (agents that exist in backup but not in source)
if [ -d "${BACKUP_DIR}" ]; then
    for bak_file in "${BACKUP_DIR}/"*.agent.md.bak; do
        [ -f "${bak_file}" ] || continue
        original_name="$(basename "${bak_file}" .bak)"
        source_file="${SOURCE_DIR}/agents/${original_name}"

        if [ ! -f "${source_file}" ]; then
            # This was a user-created agent — restore it
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
printf "  ${BOLD}Location${NC}:  ${INSTALL_DIR}\n"
printf "  ${BOLD}Agents${NC}:    ${INSTALL_DIR}/agents/\n"
printf "  ${BOLD}Extension${NC}: ${INSTALL_DIR}/extension.mjs\n"
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
