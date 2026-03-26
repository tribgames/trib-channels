# Claude2Bot Launcher — Windows installer
# Usage: irm https://github.com/claude2bot/claude2bot/releases/latest/download/install.ps1 | iex

$ErrorActionPreference = "Stop"
$Repo = "claude2bot/claude2bot"
$InstallDir = Join-Path $env:LOCALAPPDATA "Claude2Bot"

Write-Host "Installing Claude2Bot Launcher..."

# Get latest release
$Release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest"
$Asset = $Release.assets | Where-Object { $_.name -like "*tray-win*" } | Select-Object -First 1

if (-not $Asset) {
    Write-Error "Could not find Windows release"
    exit 1
}

# Download
$TmpZip = Join-Path $env:TEMP "claude2bot-launcher.zip"
Invoke-WebRequest $Asset.browser_download_url -OutFile $TmpZip

# Extract
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Expand-Archive -Path $TmpZip -DestinationPath $InstallDir -Force
Remove-Item $TmpZip

# Create Start Menu shortcut
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut((Join-Path ([Environment]::GetFolderPath("StartMenu")) "Claude2Bot Launcher.lnk"))
$Shortcut.TargetPath = Join-Path $InstallDir "Claude2BotLauncher.exe"
$Shortcut.WorkingDirectory = $InstallDir
$Shortcut.IconLocation = Join-Path $InstallDir "icon.ico"
$Shortcut.Save()

Write-Host "Installed to $InstallDir"
Write-Host "Launching..."
Start-Process (Join-Path $InstallDir "Claude2BotLauncher.exe")
