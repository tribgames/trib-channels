/**
 * trib-channels session-start hook
 *
 * Loads channel settings and injects them as additionalContext:
 *   1. contextFiles from config.json
 *   2. settings.local.md (user overrides, gitignored)
 *
 * Note: context.md (memory bridge) is now loaded by trib-memory plugin.
 */

const fs = require('fs');
const path = require('path');

// Read hook event from stdin for session filtering
let _event = {};
try {
  const _input = fs.readFileSync(0, 'utf8');
  if (_input) _event = JSON.parse(_input);
} catch {}

// Safety filters: only inject context for main interactive sessions
if (_event.isSidechain) process.exit(0);                          // team agents
if (_event.agentId) process.exit(0);                              // subagents
if (_event.kind && _event.kind !== 'interactive') process.exit(0); // headless/-p

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA;
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

// 1. Context files from config.json
const config = loadConfig();
const contextFiles = config.contextFiles || [];
for (const f of contextFiles) {
  const content = tryRead(f);
  if (content) parts.push(content);
}

// 2. Local overrides
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
