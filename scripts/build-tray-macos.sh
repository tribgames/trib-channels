#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="Claude2BotLauncher"
APP_DIR="$ROOT/dist/${APP_NAME}.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
rm -rf "$ROOT/dist/Claude2BotLauncherTray.app"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

/usr/bin/swiftc \
  "$ROOT/tray/macos/Claude2BotLauncherTray.swift" \
  -framework Cocoa \
  -o "$MACOS_DIR/$APP_NAME"

cp "$ROOT/launcher.mjs" "$RESOURCES_DIR/launcher.mjs"
cp "$ROOT/launcher-wezterm.lua" "$RESOURCES_DIR/launcher-wezterm.lua"
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

cat > "$CONTENTS_DIR/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>Claude2BotLauncher</string>
  <key>CFBundleIdentifier</key>
  <string>com.tribgames.claude2bot.launcher</string>
  <key>CFBundleName</key>
  <string>Claude2BotLauncher</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
PLIST

chmod +x "$MACOS_DIR/$APP_NAME"
echo "$APP_DIR"
