#!/bin/bash
# Claude2Bot — macOS one-click installer (tray app + Claude Code plugin)
# Usage: curl -fsSL https://github.com/claude2bot/claude2bot/releases/latest/download/install.sh | bash

set -euo pipefail

REPO="claude2bot/claude2bot"
REPO_URL="https://github.com/$REPO.git"
CLONE_DIR="$HOME/.claude2bot"
APP_NAME="Claude2BotLauncher.app"
APP_INSTALL_DIR="/Applications"
CLAUDE_HOME="$HOME/.claude"
SETTINGS_FILE="$CLAUDE_HOME/settings.json"

echo "=== Claude2Bot Installer ==="
echo ""

# ─── 1. Tray App ───
echo "[1/4] Downloading tray app..."

RELEASE_JSON=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest")
DOWNLOAD_URL=$(echo "$RELEASE_JSON" \
  | grep "browser_download_url.*Claude2BotLauncher-macos.zip" \
  | head -1 \
  | cut -d '"' -f 4)

if [ -n "$DOWNLOAD_URL" ]; then
  TMPDIR=$(mktemp -d)
  curl -fsSL "$DOWNLOAD_URL" -o "$TMPDIR/launcher.zip"
  unzip -q "$TMPDIR/launcher.zip" -d "$TMPDIR"
  rm -rf "$APP_INSTALL_DIR/$APP_NAME"
  mv "$TMPDIR/$APP_NAME" "$APP_INSTALL_DIR/$APP_NAME"
  rm -rf "$TMPDIR"
  echo "  ✓ Tray app installed to $APP_INSTALL_DIR/$APP_NAME"
else
  echo "  ⚠ Tray app not found in release, skipping..."
fi

# ─── 2. Clone/Update Repository ───
echo "[2/4] Setting up plugin repository..."

if [ -d "$CLONE_DIR/.git" ]; then
  cd "$CLONE_DIR" && git pull --quiet
  echo "  ✓ Repository updated ($CLONE_DIR)"
else
  rm -rf "$CLONE_DIR"
  git clone --quiet "$REPO_URL" "$CLONE_DIR"
  echo "  ✓ Repository cloned to $CLONE_DIR"
fi

# ─── 3. Register Marketplace ───
echo "[3/4] Registering plugin marketplace..."

if [ ! -f "$SETTINGS_FILE" ]; then
  mkdir -p "$CLAUDE_HOME"
  echo '{}' > "$SETTINGS_FILE"
fi

python3 -c "
import json, sys

settings_path = '$SETTINGS_FILE'
clone_dir = '$CLONE_DIR'

with open(settings_path, 'r') as f:
    settings = json.load(f)

mkp = settings.setdefault('extraKnownMarketplaces', {})
mkp['claude2bot'] = {
    'source': {
        'source': 'directory',
        'path': clone_dir
    }
}

ep = settings.setdefault('enabledPlugins', {})
ep['claude2bot@claude2bot'] = True

with open(settings_path, 'w') as f:
    json.dump(settings, f, indent=2)

print('  ✓ Marketplace registered in settings.json')
"

# ─── 4. Install Plugin ───
echo "[4/4] Installing Claude Code plugin..."

if command -v claude &>/dev/null; then
  claude plugin install claude2bot@claude2bot 2>/dev/null && \
    echo "  ✓ Plugin installed" || \
    echo "  ✓ Plugin already installed or registered via settings"
else
  echo "  ⚠ Claude Code CLI not found — plugin will activate on next session"
fi

# ─── Done ───
echo ""
echo "=== Installation Complete ==="
echo "  Tray app: $APP_INSTALL_DIR/$APP_NAME"
echo "  Plugin:   claude2bot@claude2bot"
echo "  Config:   ~/.claude/plugins/data/claude2bot-claude2bot/config.json"
echo ""
echo "Next: Edit config.json with your Discord token, then launch the tray app."

if [ -n "$DOWNLOAD_URL" ]; then
  echo "Launching tray app..."
  open "$APP_INSTALL_DIR/$APP_NAME"
fi
