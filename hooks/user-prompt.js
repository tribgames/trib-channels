/**
 * cc-bot user-prompt hook
 *
 * Extracts "Response Rules" section from settings.local.md and
 * injects it as a system reminder on every user prompt.
 *
 * This ensures user-defined behavioral rules are always visible
 * to the model, even after context compression.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA;

const LOCAL_FILE = path.join(DATA_DIR, 'settings.local.md');

function extractResponseRules(content) {
  // Find "## Response Rules" or "## Rules" section
  const patterns = [
    /^## Response Rules\n([\s\S]*?)(?=\n## |\n# |$)/m,
    /^## Rules\n([\s\S]*?)(?=\n## |\n# |$)/m,
  ];

  for (const re of patterns) {
    const match = content.match(re);
    if (match && match[1].trim()) {
      return match[1].trim();
    }
  }
  return null;
}

try {
  const content = fs.readFileSync(LOCAL_FILE, 'utf8');
  const rules = extractResponseRules(content);

  if (rules) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `## cc-bot Response Rules\n${rules}`
      }
    }));
  }
} catch {
  // settings.local.md doesn't exist or can't be read — no-op
}
