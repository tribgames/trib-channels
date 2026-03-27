---
description: Explain claude2bot Sleeping Mode — automatic daily conversation summarization, memory system, and manual execution.
user_invocable: true
---

# Sleeping Mode

Sleeping Mode automatically summarizes each day's conversations and builds a long-term memory system.

## How it works

1. **Tray app triggers** sleep-cycle at the configured time (default: 03:00)
2. **Extracts conversations** from Claude Code session logs (.jsonl files)
3. **Generates daily summary** via `claude -p` for each day missing a summary (up to 7 days)
4. **Rollups**: weekly → monthly → yearly → lifetime compression
5. **Updates**: identity.md (user profile), ongoing.md (active tasks), interests.json (keyword tracking)
6. **Restarts** the Claude Code session with fresh context

## Files generated

All files are stored in `~/.claude2bot-launcher/history/`:

- `daily/YYYY-MM-DD.md` — Daily work summary (~5 lines)
- `weekly/YYYY-WNN.md` — Weekly rollup
- `monthly/YYYY-MM.md` — Monthly rollup
- `yearly/YYYY.md` — Yearly rollup
- `lifetime.md` — Cumulative rolling history
- `identity.md` — User profile (personality, preferences, work style)
- `ongoing.md` — Active tasks and projects
- `interests.json` — Keyword frequency tracking
- `context.md` — Combined context injected into new sessions

## Settings

Configure via tray app Settings or `/setup`:
- **Sleeping Mode**: ON/OFF
- **Sleep Time**: When to run (default: 03:00)

## Manual execution

Run summarize without restarting the session:
```
node ~/.claude/plugins/cache/claude2bot/claude2bot/*/launcher.mjs summarize
```
