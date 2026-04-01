# Forge — Install / Update script for Windows PowerShell
# Usage:
#   git clone https://github.com/msucharda/forge.git
#   cd forge
#   .\install.ps1

#Requires -Version 6.0
$ErrorActionPreference = 'Stop'

$RepoUrl   = if ($env:FORGE_REPO_URL) { $env:FORGE_REPO_URL } else { 'https://github.com/msucharda/forge.git' }
$InstallDir = Join-Path $HOME '.copilot' 'extensions' 'anvil'
$AgentsDir  = Join-Path $HOME '.copilot' 'agents'
$BackupDir  = Join-Path $HOME '.copilot' 'extensions' '.anvil-backup'
$TmpDir     = $null

function Write-Info  { param($Msg) Write-Host "▸ $Msg" -ForegroundColor Blue }
function Write-Ok    { param($Msg) Write-Host "✔ $Msg" -ForegroundColor Green }
function Write-Warn  { param($Msg) Write-Host "⚠ $Msg" -ForegroundColor Yellow }
function Write-Err   { param($Msg) Write-Host "✖ $Msg" -ForegroundColor Red }
function Stop-WithError { param($Msg) Write-Err $Msg; exit 1 }

try {
    # -----------------------------------------------------------------------
    # Detect source: local clone or need to clone?
    # -----------------------------------------------------------------------
    $ScriptDir = $PSScriptRoot
    $SourceDir = $null

    if ((Test-Path (Join-Path $ScriptDir 'extension' 'extension.mjs')) -and
        (Test-Path (Join-Path $ScriptDir '.github' 'agents'))) {
        $SourceDir = $ScriptDir
        Write-Info "Installing from local clone: $SourceDir"
    } else {
        if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
            Stop-WithError 'git is required but not installed'
        }
        $TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "forge-install-$(Get-Random)"
        Write-Info "Cloning $RepoUrl..."
        git clone --depth 1 --quiet $RepoUrl $TmpDir
        if ($LASTEXITCODE -ne 0) { Stop-WithError "Failed to clone $RepoUrl" }
        $SourceDir = $TmpDir
        Write-Info 'Cloned to temporary directory'
    }

    # Verify source
    $requiredFiles = @(
        (Join-Path $SourceDir 'extension' 'extension.mjs'),
        (Join-Path $SourceDir 'plugin.json'),
        (Join-Path $SourceDir 'version.txt')
    )
    foreach ($f in $requiredFiles) {
        if (-not (Test-Path $f)) { Stop-WithError "$f not found in source" }
    }
    if (-not (Test-Path (Join-Path $SourceDir '.github' 'agents'))) {
        Stop-WithError '.github/agents/ directory not found in source'
    }

    $NewVersion = (Get-Content (Join-Path $SourceDir 'version.txt') -Raw).Trim()

    # -----------------------------------------------------------------------
    # Check existing installation
    # -----------------------------------------------------------------------
    $IsUpdate = $false
    $OldVersion = ''

    if ((Test-Path $InstallDir) -and (Test-Path (Join-Path $InstallDir 'extension.mjs'))) {
        $IsUpdate = $true
        $versionFile = Join-Path $InstallDir 'version.txt'
        if (Test-Path $versionFile) {
            $OldVersion = (Get-Content $versionFile -Raw).Trim()
        }

        if ($OldVersion -eq $NewVersion) {
            Write-Ok "Forge v$NewVersion is already installed and up to date"
            Write-Host "  Location: $InstallDir"
            exit 0
        }

        $displayVersion = if ($OldVersion) { $OldVersion } else { 'unknown' }
        Write-Info "Updating Forge: v$displayVersion → v$NewVersion"
    } else {
        Write-Info "Installing Forge v$NewVersion"
    }

    # -----------------------------------------------------------------------
    # Backup user-modified agent files
    # -----------------------------------------------------------------------
    if ($IsUpdate -and (Test-Path $AgentsDir)) {
        Write-Info 'Checking for user-modified agent files...'
        New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null

        Get-ChildItem (Join-Path $AgentsDir 'anvil-*.agent.md') -ErrorAction SilentlyContinue | ForEach-Object {
            $base = $_.Name
            $sourceAgent = Join-Path $SourceDir '.github' 'agents' $base

            if (Test-Path $sourceAgent) {
                $installedHash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash
                $sourceHash    = (Get-FileHash $sourceAgent -Algorithm SHA256).Hash
                if ($installedHash -ne $sourceHash) {
                    Copy-Item $_.FullName (Join-Path $BackupDir "$base.bak")
                    Write-Warn "Backed up modified agent: $base"
                }
            } else {
                Copy-Item $_.FullName (Join-Path $BackupDir "$base.bak")
                Write-Warn "Backed up custom agent: $base"
            }
        }
    }

    # -----------------------------------------------------------------------
    # Migrate: clean old plugin-based layout
    # -----------------------------------------------------------------------
    if ($IsUpdate) {
        foreach ($old in @('plugins', 'commands', 'agents', 'skills')) {
            $oldPath = Join-Path $InstallDir $old
            if (Test-Path $oldPath) { Remove-Item $oldPath -Recurse -Force }
        }
    }

    # -----------------------------------------------------------------------
    # Install
    # -----------------------------------------------------------------------
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    New-Item -ItemType Directory -Path $AgentsDir  -Force | Out-Null

    Copy-Item (Join-Path $SourceDir 'extension' 'extension.mjs') (Join-Path $InstallDir 'extension.mjs') -Force
    Write-Ok 'Installed extension.mjs'

    Copy-Item (Join-Path $SourceDir 'plugin.json') (Join-Path $InstallDir 'plugin.json') -Force
    Write-Ok 'Installed plugin.json'

    $agentFiles = Get-ChildItem (Join-Path $SourceDir '.github' 'agents' '*.agent.md') -ErrorAction SilentlyContinue
    foreach ($af in $agentFiles) {
        Copy-Item $af.FullName (Join-Path $AgentsDir $af.Name) -Force
    }
    $agentCount = @($agentFiles).Count
    Write-Ok "Installed $agentCount agent(s) to $AgentsDir"

    # Restore user-created agents
    if (Test-Path $BackupDir) {
        Get-ChildItem (Join-Path $BackupDir '*.agent.md.bak') -ErrorAction SilentlyContinue | ForEach-Object {
            $originalName = $_.Name -replace '\.bak$', ''
            if (-not (Test-Path (Join-Path $SourceDir '.github' 'agents' $originalName))) {
                Copy-Item $_.FullName (Join-Path $AgentsDir $originalName)
                Write-Ok "Restored custom agent: $originalName"
            }
        }
    }

    Copy-Item (Join-Path $SourceDir 'version.txt') (Join-Path $InstallDir 'version.txt') -Force

    # -----------------------------------------------------------------------
    # Summary
    # -----------------------------------------------------------------------
    Write-Host ''
    if ($IsUpdate) {
        Write-Ok "Forge updated to v$NewVersion"
    } else {
        Write-Ok "Forge v$NewVersion installed"
    }
    Write-Host ''
    Write-Host "  Extension:  $InstallDir\extension.mjs"
    Write-Host "  Agents:     $AgentsDir\"
    Write-Host ''

    if ((Test-Path $BackupDir) -and (Get-ChildItem $BackupDir -ErrorAction SilentlyContinue)) {
        Write-Warn "Backed-up files: $BackupDir"
        Write-Host '  Review and merge your customizations if needed.'
        Write-Host ''
    }

    Write-Host '  Next steps:'
    Write-Host '  1. Reload in Copilot CLI:  /clear'
    Write-Host '  2. Select an agent:        /agent'
    Write-Host ''
    Write-Host "  Customize agents:"
    Write-Host "  Edit files in $AgentsDir\ — changes take effect on next /clear"
    Write-Host ''
    Write-Host '  Uninstall:'
    Write-Host "  Remove-Item -Recurse $InstallDir; Remove-Item $AgentsDir\anvil-*.agent.md"
    Write-Host ''

} finally {
    if ($TmpDir -and (Test-Path $TmpDir)) {
        Remove-Item $TmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
