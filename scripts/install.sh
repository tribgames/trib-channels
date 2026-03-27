#!/bin/bash
# Claude2Bot — macOS one-click installer (tray app + Claude Code plugin)
# Usage: curl -fsSL https://github.com/claude2bot/claude2bot/releases/latest/download/install.sh | bash

set -euo pipefail

REPO="claude2bot/claude2bot"
APP_NAME="Claude2BotLauncher.app"
APP_INSTALL_DIR="/Applications"
CONFIG_DIR="$HOME/.claude/plugins/data/claude2bot-claude2bot"
CONFIG_FILE="$CONFIG_DIR/config.json"

echo "=== Claude2Bot Installer ==="
echo ""

# ─── 1. Dependencies ───
echo "[1/4] Checking dependencies..."

# Node.js
if command -v node &>/dev/null; then
  echo "  ✓ Node.js $(node -v)"
else
  if command -v brew &>/dev/null; then
    echo "  Installing Node.js..."
    brew install node
  else
    echo "  ⚠ Node.js not found. Install from https://nodejs.org/"
  fi
fi

# WezTerm
if command -v wezterm &>/dev/null || [ -d "/Applications/WezTerm.app" ]; then
  echo "  ✓ WezTerm"
else
  if command -v brew &>/dev/null; then
    echo "  Installing WezTerm..."
    brew install --cask wezterm
    echo "  ✓ WezTerm installed"
  else
    echo "  ⚠ WezTerm not found. Install from https://wezfurlong.org/wezterm/"
  fi
fi

# ─── 2. Tray App ───
echo "[2/4] Downloading tray app..."

RELEASE_JSON=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest")
DOWNLOAD_URL=$(echo "$RELEASE_JSON" \
  | grep "browser_download_url.*Claude2BotLauncher-macos.zip" \
  | head -1 \
  | cut -d '"' -f 4)

if [ -n "$DOWNLOAD_URL" ]; then
  WORK_DIR=$(mktemp -d)
  curl -fsSL "$DOWNLOAD_URL" -o "$WORK_DIR/launcher.zip"
  unzip -q "$WORK_DIR/launcher.zip" -d "$WORK_DIR"
  rm -rf "$APP_INSTALL_DIR/$APP_NAME"
  mv "$WORK_DIR/$APP_NAME" "$APP_INSTALL_DIR/$APP_NAME"
  rm -rf "$WORK_DIR"
  echo "  ✓ Tray app installed to $APP_INSTALL_DIR/$APP_NAME"
else
  echo "  ⚠ Tray app not found in release, skipping..."
fi

# ─── 3. Install Plugin ───
echo "[3/4] Installing Claude Code plugin..."

if command -v claude &>/dev/null; then
  claude plugin marketplace add claude2bot/claude2bot 2>/dev/null && \
    echo "  ✓ Marketplace registered" || \
    echo "  ✓ Marketplace already registered"

  claude plugin install claude2bot@claude2bot 2>/dev/null && \
    echo "  ✓ Plugin installed" || \
    echo "  ✓ Plugin already installed"
else
  echo "  ⚠ Claude Code CLI not found — install manually:"
  echo "    claude plugin marketplace add claude2bot/claude2bot"
  echo "    claude plugin install claude2bot@claude2bot"
fi

# ─── 4. Setup Config ───
echo "[4/4] Checking configuration..."

if [ ! -f "$CONFIG_FILE" ]; then
  mkdir -p "$CONFIG_DIR"
  cat > "$CONFIG_FILE" <<'CONF'
{
  "backend": "discord",
  "discord": {
    "token": "YOUR_DISCORD_BOT_TOKEN"
  },
  "channelsConfig": {
    "main": "general",
    "channels": {
      "general": { "id": "YOUR_CHANNEL_ID", "mode": "interactive" }
    }
  }
}
CONF
  echo "  ⚠ Config template created at $CONFIG_FILE"
  echo "  >> Edit config.json with your Discord token and channel ID"
else
  echo "  ✓ Config already exists"
fi

# ─── Done ───
echo ""
echo "=== Installation Complete ==="
echo "  Tray app: $APP_INSTALL_DIR/$APP_NAME"
echo "  Plugin:   claude2bot@claude2bot"
echo "  Config:   $CONFIG_FILE"
echo ""

if [ -n "$DOWNLOAD_URL" ]; then
  echo "Launching tray app..."
  open "$APP_INSTALL_DIR/$APP_NAME"
fi
