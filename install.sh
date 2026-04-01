#!/usr/bin/env bash
# Forge — Install / Update script
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/msucharda/forge/main/install.sh | bash
#   OR: git clone ... && cd forge && bash install.sh

set -euo pipefail

REPO_URL="${FORGE_REPO_URL:-https://github.com/msucharda/forge.git}"
INSTALL_DIR="${HOME}/.copilot/extensions/anvil"
AGENTS_DIR="${HOME}/.copilot/agents"
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

file_hash() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d' ' -f1
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | cut -d' ' -f1
    else
        openssl dgst -sha256 "$1" | awk '{print $NF}'
    fi
}

# ---------------------------------------------------------------------------
# Detect source: running from repo clone or curl pipe?
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
SOURCE_DIR=""

if [ -f "${SCRIPT_DIR}/extension/extension.mjs" ] && [ -d "${SCRIPT_DIR}/.github/agents" ]; then
    SOURCE_DIR="${SCRIPT_DIR}"
    info "Installing from local clone: ${SOURCE_DIR}"
else
    command -v git >/dev/null 2>&1 || die "git is required but not installed"
    TMP_DIR="$(mktemp -d)"
    info "Cloning ${REPO_URL}..."
    git clone --depth 1 --quiet "${REPO_URL}" "${TMP_DIR}" || die "Failed to clone ${REPO_URL}"
    SOURCE_DIR="${TMP_DIR}"
    info "Cloned to temporary directory"
fi

[ -f "${SOURCE_DIR}/extension/extension.mjs" ] || die "extension/extension.mjs not found in source"
[ -d "${SOURCE_DIR}/.github/agents" ] || die ".github/agents/ directory not found in source"
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
        ok "Forge v${NEW_VERSION} is already installed and up to date"
        printf "  ${BOLD}Location${NC}: ${INSTALL_DIR}\n"
        exit 0
    fi

    info "Updating Forge: v${OLD_VERSION:-unknown} → v${NEW_VERSION}"
else
    info "Installing Forge v${NEW_VERSION}"
fi

# ---------------------------------------------------------------------------
# Backup user-modified agent files
# ---------------------------------------------------------------------------

if [ "${IS_UPDATE}" = true ] && [ -d "${AGENTS_DIR}" ]; then
    info "Checking for user-modified agent files..."
    mkdir -p "${BACKUP_DIR}"

    for agent_file in "${AGENTS_DIR}/"anvil-*.agent.md; do
        [ -f "${agent_file}" ] || continue
        base="$(basename "${agent_file}")"

        if [ -f "${SOURCE_DIR}/.github/agents/${base}" ]; then
            installed_hash="$(file_hash "${agent_file}")"
            source_hash="$(file_hash "${SOURCE_DIR}/.github/agents/${base}")"
            if [ "${installed_hash}" != "${source_hash}" ]; then
                cp "${agent_file}" "${BACKUP_DIR}/${base}.bak"
                warn "Backed up modified agent: ${base} → ${BACKUP_DIR}/${base}.bak"
            fi
        else
            cp "${agent_file}" "${BACKUP_DIR}/${base}.bak"
            warn "Backed up custom agent: ${base} → ${BACKUP_DIR}/${base}.bak"
        fi
    done
fi

# ---------------------------------------------------------------------------
# Migrate: clean old plugin-based layout
# ---------------------------------------------------------------------------

if [ "${IS_UPDATE}" = true ]; then
    rm -rf "${INSTALL_DIR}/plugins" 2>/dev/null || true
    rm -rf "${INSTALL_DIR}/commands" 2>/dev/null || true
    rm -rf "${INSTALL_DIR}/agents" 2>/dev/null || true
    rm -rf "${INSTALL_DIR}/skills" 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------

mkdir -p "${INSTALL_DIR}" "${AGENTS_DIR}"

cp "${SOURCE_DIR}/extension/extension.mjs" "${INSTALL_DIR}/extension.mjs"
ok "Installed extension.mjs"

cp "${SOURCE_DIR}/plugin.json" "${INSTALL_DIR}/plugin.json"
ok "Installed plugin.json"

agent_sources=$(ls -1 "${SOURCE_DIR}/.github/agents/"*.agent.md 2>/dev/null | wc -l)
if [ "${agent_sources}" -eq 0 ]; then
    die "No agent files found in ${SOURCE_DIR}/.github/agents/"
fi
cp "${SOURCE_DIR}/.github/agents/"*.agent.md "${AGENTS_DIR}/"
agent_count=$(ls -1 "${AGENTS_DIR}/"anvil-*.agent.md 2>/dev/null | wc -l)
ok "Installed ${agent_count} agent(s) to ${AGENTS_DIR}/"

# Restore user-created agents
if [ -d "${BACKUP_DIR}" ]; then
    for bak_file in "${BACKUP_DIR}/"*.agent.md.bak; do
        [ -f "${bak_file}" ] || continue
        original_name="$(basename "${bak_file}" .bak)"
        if [ ! -f "${SOURCE_DIR}/.github/agents/${original_name}" ]; then
            cp "${bak_file}" "${AGENTS_DIR}/${original_name}"
            ok "Restored custom agent: ${original_name}"
        fi
    done
fi

cp "${SOURCE_DIR}/version.txt" "${INSTALL_DIR}/version.txt"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

printf "\n"
if [ "${IS_UPDATE}" = true ]; then
    ok "${BOLD}Forge updated to v${NEW_VERSION}${NC}"
else
    ok "${BOLD}Forge v${NEW_VERSION} installed${NC}"
fi
printf "\n"
printf "  ${BOLD}Extension${NC}:  ${INSTALL_DIR}/extension.mjs\n"
printf "  ${BOLD}Agents${NC}:     ${AGENTS_DIR}/\n"
printf "\n"

if [ -d "${BACKUP_DIR}" ] && [ "$(ls -A "${BACKUP_DIR}" 2>/dev/null)" ]; then
    printf "  ${YELLOW}Backed-up files${NC}: ${BACKUP_DIR}/\n"
    printf "  Review and merge your customizations if needed.\n"
    printf "\n"
fi

printf "  ${BOLD}Next steps${NC}:\n"
printf "  1. Reload in Copilot CLI:  ${BLUE}/clear${NC}\n"
printf "  2. Select an agent:        ${BLUE}/agent${NC}\n"
printf "\n"
printf "  ${BOLD}Customize agents${NC}:\n"
printf "  Edit files in ${AGENTS_DIR}/ — changes take effect on next /clear\n"
printf "\n"
printf "  ${BOLD}Uninstall${NC}:\n"
printf "  make uninstall   (or: rm -rf ${INSTALL_DIR} ${AGENTS_DIR}/anvil-*.agent.md)\n"
printf "\n"
