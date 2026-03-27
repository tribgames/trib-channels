# Build Windows tray app as exe
# Run on Windows: powershell -ExecutionPolicy Bypass -File build-tray-windows.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$PluginDir = Join-Path $Root "external_plugins\claude2bot"
$Source = Join-Path $Root "tray\windows\Claude2BotLauncher.ps1"
$Output = Join-Path $Root "dist\Claude2BotLauncher.exe"

if (-not (Get-Module -ListAvailable -Name ps2exe)) {
    Write-Host "Installing ps2exe..."
    Install-Module ps2exe -Scope CurrentUser -Force
}

Write-Host "Building $Output..."
New-Item -ItemType Directory -Path (Join-Path $Root "dist") -Force | Out-Null

$IconFile = Join-Path $Root "tray\windows\icon.ico"
$Version = (Get-Content (Join-Path $PluginDir "package.json") | ConvertFrom-Json).version

Invoke-ps2exe `
    -InputFile $Source `
    -OutputFile $Output `
    -NoConsole `
    -IconFile $IconFile `
    -Title "Claude2Bot Launcher" `
    -Company "TribGames" `
    -Product "Claude2Bot" `
    -Version $Version `
    -Copyright "2026 TribGames"

Copy-Item (Join-Path $PluginDir "launcher.mjs") (Join-Path $Root "dist\launcher.mjs") -Force
Copy-Item (Join-Path $PluginDir "launcher-wezterm.lua") (Join-Path $Root "dist\launcher-wezterm.lua") -Force

Write-Host "Done: $Output"
