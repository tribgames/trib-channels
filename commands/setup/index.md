---
description: Interactive first-time setup for cc-bot — configure backend, token, channels, and profile.
---

# cc-bot Setup

Walk the user through initial cc-bot configuration. Use AskUserQuestion for each step.

## Steps

### 1. Backend Selection
Ask which messaging backend to use. Currently supported: **discord**.
```
Which messaging backend? (discord)
```

### 2. Bot Token
Ask for the bot token. For Discord, this is the bot token from the Discord Developer Portal.
```
Paste your Discord bot token:
```

### 3. Connect & Discover Channels
Connect the bot with the provided token. On success, automatically fetch the server's channel list and display them numbered:
```
Connected as BotName#1234!

Available channels:
  1. #general       (123456789012...)
  2. #news          (148409570346...)
  3. #issues        (148556903757...)
  4. #history       (148410129802...)
  ...
```

### 4. Main Channel Selection
Ask the user to pick the **main** channel by number. This is the default channel for bot output and monitor-mode reports.
```
Select main channel (number): 1
```

### 5. Additional Channels
Ask if the user wants to register more channels. For each additional channel:
1. Pick by number
2. Choose a label (or use the channel name as default)
3. Set mode: `interactive` (listen + respond) or `monitor` (listen only, report to main)
```
Add another channel? (number or 'done'):
Channel mode? (interactive / monitor):
```

### 6. Access Policy
Ask about DM policy: `pairing` (default), `allowlist`, or `disabled`.

### 7. Voice
Ask if voice message transcription should be enabled:
```
Enable voice message transcription? (yes/no)
```

### 8. Write Config
Save all settings to `${CLAUDE_PLUGIN_DATA}/config.json`:
```json
{
  "backend": "discord",
  "discord": {
    "token": "the-token",
    "stateDir": "~/.claude/channels/discord"
  },
  "channelsConfig": {
    "main": "general",
    "channels": {
      "general": { "id": "123456789012...", "mode": "interactive" },
      "news": { "id": "148409570346...", "mode": "interactive" },
      "issues": { "id": "148556903757...", "mode": "monitor" }
    }
  },
  "voice": { "enabled": true }
}
```

Also write the access.json file:
```json
{
  "dmPolicy": "pairing",
  "allowFrom": [],
  "channels": {
    "123456789012...": { "requireMention": false, "allowFrom": [] }
  }
}
```

### 9. Verify
Run a quick connection test by checking if the bot can log in.
Report success or failure with actionable next steps.
