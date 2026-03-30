---
description: Run memory management operations — consolidation, context refresh, rebuild, prune, status.
allowed-tools:
  - mcp__plugin_claude2bot_claude2bot__memory_cycle
---

# Memory Management

Use the `memory_cycle` MCP tool to manage claude2bot's long-term memory.

## Available Actions

| Action | Description |
|--------|-------------|
| `status` | Show last cycle time and pending candidates count |
| `sleep` | Consolidate pending memory and refresh embeddings/context |
| `flush` | Consolidate pending memory candidates into facts/tasks/signals |
| `rebuild` | Rebuild recent memory (re-consolidate last N days) |
| `prune` | Remove old consolidated memory, keep only recent days |

## Usage

- `/claude2bot memory` → show status
- `/claude2bot memory sleep` → run memory cycle
- `/claude2bot memory flush` → consolidate pending candidates
- `/claude2bot memory rebuild` → rebuild recent 2 days
- `/claude2bot memory prune` → keep only last 5 days

## How it works

1. Parse the user's subcommand (default: status)
2. Call `memory_cycle` tool with the appropriate action
3. Report the result
