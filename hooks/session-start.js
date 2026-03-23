/**
 * cc-bot session-start hook
 *
 * Loads settings files and injects them as additionalContext:
 *   1. settings.default.md (bundled with plugin)
 *   2. contextFiles from config.json
 *   3. settings.local.md (user overrides, gitignored)
 */

const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || __dirname.replace(/[/\\]hooks$/, '');
const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || path.join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.claude', 'plugins', 'data', 'cc-bot'
);

const DEFAULT_FILE = path.join(PLUGIN_ROOT, 'settings.default.md');
const LOCAL_FILE = path.join(DATA_DIR, 'settings.local.md');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

function tryRead(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

// Build additional context
const parts = [];

// 1. Default settings (bundled)
const defaults = tryRead(DEFAULT_FILE);
if (defaults) parts.push(defaults);

// 2. Context files from config
const config = loadConfig();
const contextFiles = config.contextFiles || [];
for (const f of contextFiles) {
  const content = tryRead(f);
  if (content) parts.push(content);
}

// 3. Local overrides
const local = tryRead(LOCAL_FILE);
if (local) parts.push(local);

// Output hook result
if (parts.length > 0) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: parts.join('\n\n')
    }
  }));
}
