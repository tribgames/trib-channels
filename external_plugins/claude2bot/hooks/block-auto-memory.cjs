'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

// Block Read/Write/Edit access to auto-memory folder when MCP memory is active.
// This ensures all memory operations go through the RAG system (recall_memory, memory_cycle).

const MEMORY_DIR = path.join(os.homedir(), '.claude', 'projects');

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    try {
      const event = JSON.parse(input);
      const toolInput = event.tool_input || {};
      const filePath = toolInput.file_path || toolInput.path || '';

      if (!filePath) {
        process.stdout.write('{}');
        return;
      }

      // Normalize path separators for Windows compatibility
      const normalized = filePath.replace(/\\/g, '/');
      const memoryBase = MEMORY_DIR.replace(/\\/g, '/');

      // Check if path is under ~/.claude/projects/*/memory/
      if (normalized.startsWith(memoryBase) && /\/memory\//.test(normalized)) {
        // Allow MEMORY.md index reads (it's loaded by Claude Code automatically anyway)
        // Block everything else
        const basename = path.basename(normalized);
        if (basename === 'MEMORY.md' && event.tool_name === 'Read') {
          process.stdout.write('{}');
          return;
        }

        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            permissionDecision: 'deny',
            reason: 'Auto-memory is disabled when MCP memory system is active. Use recall_memory for retrieval and let memory_cycle handle storage.'
          }
        }));
        return;
      }

      process.stdout.write('{}');
    } catch (e) {
      process.stdout.write('{}');
    }
  });
}

main();
