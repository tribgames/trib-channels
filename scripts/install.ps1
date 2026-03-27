# Claude2Bot — Windows one-click installer (tray app + Claude Code plugin)
# Usage: irm https://github.com/claude2bot/claude2bot/releases/latest/download/install.ps1 | iex

$ErrorActionPreference = "Stop"
$Repo = "claude2bot/claude2bot"
$InstallDir = Join-Path $env:LOCALAPPDATA "Claude2Bot"

Write-Host "=== Claude2Bot Installer ===" -ForegroundColor Cyan
Write-Host ""

# --- 1. Dependencies ---
Write-Host "[1/4] Checking dependencies..."

# Node.js
if (Get-Command node -ErrorAction SilentlyContinue) {
    Write-Host "  OK Node.js $(node -v)" -ForegroundColor Green
} elseif (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host "  Installing Node.js..."
    winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
    Write-Host "  OK Node.js installed" -ForegroundColor Green
} else {
    Write-Host "  WARN Node.js not found. Install from https://nodejs.org/" -ForegroundColor Yellow
}

# WezTerm
if (Get-Command wezterm -ErrorAction SilentlyContinue) {
    Write-Host "  OK WezTerm" -ForegroundColor Green
} elseif (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host "  Installing WezTerm..."
    winget install wez.wezterm -e --accept-package-agreements --accept-source-agreements
    Write-Host "  OK WezTerm installed" -ForegroundColor Green
} else {
    Write-Host "  WARN WezTerm not found. Install from https://wezfurlong.org/wezterm/" -ForegroundColor Yellow
}

# --- 2. Tray App ---
Write-Host "[2/4] Downloading tray app..."

$Release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest"
$Asset = $Release.assets | Where-Object { $_.name -like "*Claude2BotLauncher-windows*" } | Select-Object -First 1

if ($Asset) {
    $TmpZip = Join-Path $env:TEMP "claude2bot-launcher.zip"
    Invoke-WebRequest $Asset.browser_download_url -OutFile $TmpZip
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Expand-Archive -Path $TmpZip -DestinationPath $InstallDir -Force
    Remove-Item $TmpZip
    Write-Host "  OK Tray app installed to $InstallDir" -ForegroundColor Green

    # Create Start Menu shortcut
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

# --- 3. Register Marketplace + Install Plugin ---
Write-Host "[3/4] Installing Claude Code plugin..."

$ClaudeCli = Get-Command claude -ErrorAction SilentlyContinue
if ($ClaudeCli) {
    try {
        claude plugin marketplace add claude2bot/claude2bot 2>$null
        Write-Host "  OK Marketplace registered" -ForegroundColor Green
    } catch {
        Write-Host "  OK Marketplace already registered" -ForegroundColor Green
    }

    try {
        claude plugin install claude2bot@claude2bot 2>$null
        Write-Host "  OK Plugin installed" -ForegroundColor Green
    } catch {
        Write-Host "  OK Plugin already installed" -ForegroundColor Green
    }
} else {
    Write-Host "  WARN Claude Code CLI not found — install manually:" -ForegroundColor Yellow
    Write-Host "    claude plugin marketplace add claude2bot/claude2bot"
    Write-Host "    claude plugin install claude2bot@claude2bot"
}

# --- 4. Setup Config ---
Write-Host "[4/4] Checking configuration..."

$ClaudeHome = Join-Path $env:USERPROFILE ".claude"
$ConfigDir = Join-Path $ClaudeHome "plugins\data\claude2bot-claude2bot"
$ConfigFile = Join-Path $ConfigDir "config.json"

if (-not (Test-Path $ConfigFile)) {
    New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
    @{
        backend = "discord"
        discord = @{ token = "YOUR_DISCORD_BOT_TOKEN" }
        channelsConfig = @{
            main = "general"
            channels = @{
                general = @{ id = "YOUR_CHANNEL_ID"; mode = "interactive" }
            }
        }
    } | ConvertTo-Json -Depth 5 | Out-File $ConfigFile -Encoding utf8
    Write-Host "  Config template created at $ConfigFile" -ForegroundColor Yellow
    Write-Host "  >> Edit config.json with your Discord token and channel ID" -ForegroundColor Yellow
} else {
    Write-Host "  OK Config already exists" -ForegroundColor Green
}

# --- Done ---
Write-Host ""
Write-Host "=== Installation Complete ===" -ForegroundColor Cyan
Write-Host "  Tray app: $InstallDir"
Write-Host "  Plugin:   claude2bot@claude2bot"
Write-Host "  Config:   $ConfigFile"
Write-Host ""

if ($Asset) {
    $StartBat = Join-Path $InstallDir "start.bat"
    if (Test-Path $StartBat) {
        Write-Host "Launching tray app..."
        Start-Process $StartBat -WorkingDirectory $InstallDir
    }
}
