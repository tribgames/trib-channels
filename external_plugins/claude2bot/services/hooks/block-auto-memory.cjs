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
        // Only block if MCP memory service is actually running
        const portFile = path.join(os.tmpdir(), 'claude2bot', 'memory-port');
        let mcpActive = false;
        try {
          const port = fs.readFileSync(portFile, 'utf8').trim();
          if (port) mcpActive = true;
        } catch {}

        if (!mcpActive) {
          // MCP not running — allow auto-memory as fallback
          process.stdout.write('{}');
          return;
        }

        // MCP active — allow MEMORY.md reads, block rest
        const basename = path.basename(normalized);
        if (basename === 'MEMORY.md' && event.tool_name === 'Read') {
          process.stdout.write('{}');
          return;
        }

        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            permissionDecision: 'deny'
          },
          systemMessage: 'Auto-memory files are blocked. MCP memory system is active — use recall_memory tool for retrieval and memory_cycle for storage. Do not attempt to read or write files under the memory/ directory.'
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
