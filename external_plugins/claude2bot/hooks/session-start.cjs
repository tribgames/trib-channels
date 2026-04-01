/**
 * claude2bot session-start hook
 *
 * Loads settings files and injects them as additionalContext:
 *   1. contextFiles from config.json
 *   2. context.md (memory bridge)
 *   3. settings.local.md (user overrides, gitignored)
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

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || __dirname.replace(/[/\\]hooks$/, '');
const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA;

const LOCAL_FILE = path.join(DATA_DIR, 'settings.local.md');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const MEMORY_CONTEXT_FILE = path.join(DATA_DIR, 'history', 'context.md');

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

// 2. SQLite-backed memory bridge rendered to context.md
const memoryContext = tryRead(MEMORY_CONTEXT_FILE);
if (memoryContext) parts.push(memoryContext);

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
