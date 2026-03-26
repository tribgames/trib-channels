# Build Windows tray app as exe
# Run on Windows: powershell -ExecutionPolicy Bypass -File build-tray-windows.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Source = Join-Path $Root "tray\windows\Claude2BotLauncher.ps1"
$Output = Join-Path $Root "dist\Claude2BotLauncher.exe"

# Ensure ps2exe is installed
if (-not (Get-Module -ListAvailable -Name ps2exe)) {
    Write-Host "Installing ps2exe..."
    Install-Module ps2exe -Scope CurrentUser -Force
}

# Build
Write-Host "Building $Output..."
New-Item -ItemType Directory -Path (Join-Path $Root "dist") -Force | Out-Null

Invoke-ps2exe `
    -InputFile $Source `
    -OutputFile $Output `
    -NoConsole `
    -Title "Claude2Bot Launcher" `
    -Company "TribGames" `
    -Product "Claude2Bot" `
    -Version "1.0.0" `
    -Copyright "2026 TribGames"

# Copy resources
Copy-Item (Join-Path $Root "launcher.mjs") (Join-Path $Root "dist\launcher.mjs") -Force
Copy-Item (Join-Path $Root "launcher-wezterm.lua") (Join-Path $Root "dist\launcher-wezterm.lua") -Force
Copy-Item (Join-Path $Root "defaults\sleep-prompt.md") (Join-Path $Root "dist\sleep-prompt.md") -Force

Write-Host "Done: $Output"
