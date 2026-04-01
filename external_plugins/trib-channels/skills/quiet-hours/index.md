---
description: Explain trib-channels Quiet Hours — do-not-disturb period where the bot won't initiate conversations or send notifications.
user_invocable: true
---

# Quiet Hours

Quiet Hours is a do-not-disturb mode. During quiet hours, trib-channels won't initiate autotalk conversations or send proactive notifications.

## How it works

- Set a time range (e.g., 22:00-08:00)
- During this period: no autotalk, no scheduled proactive messages
- User-initiated messages still work normally
- Memory Summarize runs independently (memory cycle has its own schedule)

## Settings

Configure via `/setup` or `/bot quiet`:
- **Quiet Hours**: ON/OFF
- **From**: Start time (e.g., 22:00)
- **To**: End time (e.g., 08:00)

Stored in `bot.json` as `quiet.schedule: "22:00-08:00"`.
