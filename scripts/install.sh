#!/bin/bash
# Claude2Bot Launcher — macOS installer
# Usage: curl -fsSL https://github.com/claude2bot/claude2bot/releases/latest/download/install.sh | bash

set -euo pipefail

REPO="claude2bot/claude2bot"
APP_NAME="Claude2BotLauncher.app"
INSTALL_DIR="/Applications"

echo "Installing Claude2Bot Launcher..."

# Get latest release URL
DOWNLOAD_URL=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep "browser_download_url.*app-macos.zip" \
  | head -1 \
  | cut -d '"' -f 4)

if [ -z "$DOWNLOAD_URL" ]; then
  echo "Error: Could not find release download URL"
  exit 1
fi

# Download and extract
TMPDIR=$(mktemp -d)
curl -fsSL "$DOWNLOAD_URL" -o "$TMPDIR/launcher.zip"
unzip -q "$TMPDIR/launcher.zip" -d "$TMPDIR"

# Install
rm -rf "$INSTALL_DIR/$APP_NAME"
mv "$TMPDIR/$APP_NAME" "$INSTALL_DIR/$APP_NAME"
rm -rf "$TMPDIR"

echo "Installed to $INSTALL_DIR/$APP_NAME"
echo "Launching..."
open "$INSTALL_DIR/$APP_NAME"
