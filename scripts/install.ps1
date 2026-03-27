# Claude2Bot — Windows one-click installer (tray app + Claude Code plugin)
# Usage: irm https://github.com/claude2bot/claude2bot/releases/latest/download/install.ps1 | iex

$ErrorActionPreference = "Stop"
$Repo = "claude2bot/claude2bot"
$RepoUrl = "https://github.com/$Repo.git"
$CloneDir = Join-Path $env:USERPROFILE ".claude2bot"
$InstallDir = Join-Path $env:LOCALAPPDATA "Claude2Bot"
$ClaudeHome = Join-Path $env:USERPROFILE ".claude"
$SettingsFile = Join-Path $ClaudeHome "settings.json"

Write-Host "=== Claude2Bot Installer ===" -ForegroundColor Cyan
Write-Host ""

# --- 1. Tray App ---
Write-Host "[1/4] Downloading tray app..."

$Release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest"
$Asset = $Release.assets | Where-Object { $_.name -like "*Claude2BotLauncher-windows*" } | Select-Object -First 1

if ($Asset) {
    $TmpZip = Join-Path $env:TEMP "claude2bot-launcher.zip"
    Invoke-WebRequest $Asset.browser_download_url -OutFile $TmpZip
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Expand-Archive -Path $TmpZip -DestinationPath $InstallDir -Force
    Remove-Item $TmpZip
    Write-Host "  OK Tray app installed to $InstallDir" -ForegroundColor Green

    # Create Start Menu shortcut (start.bat)
    $StartBat = Join-Path $InstallDir "start.bat"
    if (Test-Path $StartBat) {
        $WshShell = New-Object -ComObject WScript.Shell
        $Shortcut = $WshShell.CreateShortcut((Join-Path ([Environment]::GetFolderPath("StartMenu")) "Claude2Bot Launcher.lnk"))
        $Shortcut.TargetPath = $StartBat
        $Shortcut.WorkingDirectory = $InstallDir
        $Shortcut.Save()
        Write-Host "  OK Start Menu shortcut created" -ForegroundColor Green
    }
} else {
    Write-Host "  WARN Tray app not found in release, skipping..." -ForegroundColor Yellow
}

# --- 2. Clone/Update Repository ---
Write-Host "[2/4] Setting up plugin repository..."

if (Test-Path (Join-Path $CloneDir ".git")) {
    Push-Location $CloneDir
    git pull --quiet
    Pop-Location
    Write-Host "  OK Repository updated ($CloneDir)" -ForegroundColor Green
} else {
    if (Test-Path $CloneDir) { Remove-Item $CloneDir -Recurse -Force }
    git clone --quiet $RepoUrl $CloneDir
    Write-Host "  OK Repository cloned to $CloneDir" -ForegroundColor Green
}

# --- 3. Register Marketplace ---
Write-Host "[3/4] Registering plugin marketplace..."

if (-not (Test-Path $ClaudeHome)) { New-Item -ItemType Directory -Path $ClaudeHome -Force | Out-Null }
if (-not (Test-Path $SettingsFile)) { '{}' | Out-File $SettingsFile -Encoding utf8 }

$Settings = Get-Content $SettingsFile -Raw | ConvertFrom-Json

if (-not $Settings.extraKnownMarketplaces) {
    $Settings | Add-Member -NotePropertyName "extraKnownMarketplaces" -NotePropertyValue ([PSCustomObject]@{}) -Force
}
$Settings.extraKnownMarketplaces | Add-Member -NotePropertyName "claude2bot" -NotePropertyValue ([PSCustomObject]@{
    source = [PSCustomObject]@{
        source = "directory"
        path = $CloneDir
    }
}) -Force

if (-not $Settings.enabledPlugins) {
    $Settings | Add-Member -NotePropertyName "enabledPlugins" -NotePropertyValue ([PSCustomObject]@{}) -Force
}
$Settings.enabledPlugins | Add-Member -NotePropertyName "claude2bot@claude2bot" -NotePropertyValue $true -Force

$Settings | ConvertTo-Json -Depth 10 | Out-File $SettingsFile -Encoding utf8
Write-Host "  OK Marketplace registered in settings.json" -ForegroundColor Green

# --- 4. Install Plugin ---
Write-Host "[4/4] Installing Claude Code plugin..."

$ClaudeCli = Get-Command claude -ErrorAction SilentlyContinue
if ($ClaudeCli) {
    try {
        claude plugin install claude2bot@claude2bot 2>$null
        Write-Host "  OK Plugin installed" -ForegroundColor Green
    } catch {
        Write-Host "  OK Plugin already installed or registered via settings" -ForegroundColor Green
    }
} else {
    Write-Host "  WARN Claude Code CLI not found — plugin will activate on next session" -ForegroundColor Yellow
}

# --- Done ---
Write-Host ""
Write-Host "=== Installation Complete ===" -ForegroundColor Cyan
Write-Host "  Tray app: $InstallDir"
Write-Host "  Plugin:   claude2bot@claude2bot"
Write-Host "  Config:   ~/.claude/plugins/data/claude2bot-claude2bot/config.json"
Write-Host ""
Write-Host "Next: Edit config.json with your Discord token, then launch start.bat."

if ($Asset) {
    $StartBat = Join-Path $InstallDir "start.bat"
    if (Test-Path $StartBat) {
        Write-Host "Launching tray app..."
        Start-Process $StartBat -WorkingDirectory $InstallDir
    }
}
