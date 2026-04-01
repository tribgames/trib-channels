---
description: Run memory management operations — consolidation, context refresh, rebuild, prune, status.
allowed-tools:
  - mcp__plugin_trib-channels_trib-channels__memory_cycle
---

# Memory Management

Use the `memory_cycle` MCP tool to manage trib-channels's long-term memory.

## Available Actions

| Action | Description |
|--------|-------------|
| `status` | Show last cycle time and pending candidates count |
| `sleep` | Consolidate pending memory and refresh embeddings/context |
| `flush` | Consolidate pending memory candidates into facts/tasks/signals |
| `rebuild` | Rebuild recent memory (re-consolidate last N days) |
| `prune` | Remove old consolidated memory, keep only recent days |

## Usage

- `/trib-channels memory` → show status
- `/trib-channels memory sleep` → run memory cycle
- `/trib-channels memory flush` → consolidate pending candidates
- `/trib-channels memory rebuild` → rebuild recent 2 days
- `/trib-channels memory prune` → keep only last 5 days

## How it works

1. Parse the user's subcommand (default: status)
2. Call `memory_cycle` tool with the appropriate action
3. Report the result
