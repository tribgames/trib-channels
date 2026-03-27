#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="Claude2BotLauncher"
APP_DIR="$ROOT/dist/${APP_NAME}.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"

SIGN_IDENTITY="${CODESIGN_IDENTITY:-}"
TEAM_ID="${TEAM_ID:-}"
BUNDLE_ID="com.tribgames.claude2bot.launcher"

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

# Compile Swift tray app
/usr/bin/swiftc \
  "$ROOT/tray/macos/Claude2BotLauncherTray.swift" \
  -framework Cocoa \
  -o "$MACOS_DIR/$APP_NAME"

# Copy resources (from external_plugins/claude2bot/)
PLUGIN_DIR="$ROOT/external_plugins/claude2bot"
cp "$PLUGIN_DIR/launcher.mjs" "$RESOURCES_DIR/launcher.mjs"
cp "$PLUGIN_DIR/launcher-wezterm.lua" "$RESOURCES_DIR/launcher-wezterm.lua"
cat > "$RESOURCES_DIR/claude2bot-launcher" <<'SCRIPT'
#!/bin/bash
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
for NODE_BIN in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node "$(command -v node 2>/dev/null || true)"; do
  if [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ]; then
    exec "$NODE_BIN" "$APP_DIR/launcher.mjs" "$@"
  fi
done
echo "claude2bot-launcher: Node.js not found. Install Node.js first." >&2
exit 1
SCRIPT
chmod +x "$RESOURCES_DIR/claude2bot-launcher"

# Info.plist with version
VERSION="${VERSION:-1.0.0}"
cat > "$CONTENTS_DIR/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key>
  <string>${BUNDLE_ID}</string>
  <key>CFBundleName</key>
  <string>${APP_NAME}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${VERSION}</string>
  <key>CFBundleVersion</key>
  <string>${VERSION}</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
PLIST

chmod +x "$MACOS_DIR/$APP_NAME"

# Code sign
if [[ "${SKIP_SIGN:-}" != "1" ]] && [[ -n "$SIGN_IDENTITY" ]]; then
  codesign --force --deep --sign "$SIGN_IDENTITY" \
    --entitlements /dev/stdin \
    --options runtime \
    "$APP_DIR" <<'ENTITLEMENTS'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
</dict>
</plist>
ENTITLEMENTS
  echo "Signed: $SIGN_IDENTITY"
fi

echo "$APP_DIR"
