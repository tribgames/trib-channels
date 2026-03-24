---
description: Manage claude2bot schedules — list, add, remove, or trigger scheduled tasks.
args: "[list|add|remove|trigger] [name]"
allowed-tools:
  - AskUserQuestion
  - Read
  - Write
  - mcp__plugin_claude2bot_claude2bot__schedule_status
  - mcp__plugin_claude2bot_claude2bot__trigger_schedule
---

# claude2bot Schedule Management

Manage the built-in scheduler. Parse the command arguments to determine the action.

## Schedule Categories

### non-interactive
Spawns a separate `claude -p` session at the scheduled time. Runs independently from the current session.

### interactive
Injects the prompt into the current session at the scheduled time. The session handles the task inline.

### proactive
Bot-initiated conversations at random intervals based on a frequency level (1-5). Uses idle guard to prevent bursts. Merges topic prompt with feedback history.

## Actions

### list (default)
Call `schedule_status` tool and display all schedules grouped by category with their status.

### add
Ask the user for schedule details using AskUserQuestion:
1. **category** — `non-interactive`, `interactive`, or `proactive`

For non-interactive / interactive:
2. **name** — kebab-case identifier (e.g., `weather`)
3. **time** — HH:MM (24h) or `hourly`
4. **days** — `daily` or `weekday` (default: daily)
5. **channel** — target channel label (from channelsConfig)

For proactive:
2. **topic** — kebab-case topic name (e.g., `project-updates`)
3. **channel** — target channel label

Then:
- Add the entry to the appropriate array in `${CLAUDE_PLUGIN_DATA}/config.json`
- For proactive: also set `frequency` and `feedback` if not already configured
- Remind the user to create a prompt file at `${CLAUDE_PLUGIN_DATA}/prompts/{name|topic}.md`

### remove [name]
Remove the named schedule or proactive topic from config.json.
- For proactive, use `proactive:{topic}` format or just the topic name.

### trigger [name]
Call `trigger_schedule` tool with the given name to run it immediately.
- For proactive, use `proactive:{topic}` or just the topic name.
