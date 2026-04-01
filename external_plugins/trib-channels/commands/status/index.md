---
description: Show trib-channels status — backend connection, channels, schedules, running processes, and access summary.
allowed-tools:
  - Read
  - mcp__plugin_trib-channels_trib-channels__schedule_status
---

# trib-channels Status

Display the current state of trib-channels. Use the MCP tools to gather information.

## What to show

### Backend
- Backend type (discord)
- Connection status (connected/disconnected)
- Bot username (if connected)

### Channels
Show registered channels from config:
```
Channels:
  general (main)   148...  interactive
  news             148...  interactive
  issues           148...  monitor
```

### Schedules
Call the `schedule_status` tool and display results grouped by category:
```
Non-Interactive:
  weather       07:00  daily    idle
  daily-build   08:00  weekday  [RUNNING]

Interactive:
  morning       07:30  daily    idle

Proactive (freq=3, feedback=on):
  project-updates   general   last: 2025-03-23T14:30
  reminders         general   last: 2025-03-23T11:15
```

### Access Control
Summarize the current access policy from `config.json > access`:
- DM policy (pairing/allowlist/disabled)
- Number of allowed users
- Number of registered channel policies
- Pending pairing requests

### Voice
- Voice transcription: automatic when whisper + model are available

### Config
- Config file location
- Settings files loaded (default, local, context)
