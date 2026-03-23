---
description: Interactive first-time setup for cc-bot — configure backend, token, channels, and profile.
allowed-tools:
  - AskUserQuestion
  - Read
  - Write
  - Bash(node *)
  - Bash(mkdir *)
---

# cc-bot Setup

Walk the user through initial cc-bot configuration.

**Plugin root**: `${CLAUDE_PLUGIN_ROOT}`
**Data directory**: `${CLAUDE_PLUGIN_DATA}`

## Steps

### 1. Backend Selection
Ask which messaging backend to use:
```
Which messaging backend? (discord / telegram)
```
Default: discord.

### 2. Bot Token
Ask for the bot token:
- **Discord**: Bot token from Developer Portal → Bot → Reset Token
- **Telegram**: Token from @BotFather (format: `123456789:AAH...`)

```
Paste your bot token:
```

### 3. Verify & Discover

Run the discovery helper with the selected backend:

```bash
node ${CLAUDE_PLUGIN_ROOT}/lib/discover-channels.js <backend> "THE_TOKEN"
```

If the connection fails, show the error and ask the user to check their token.

#### Discord path
The helper returns a JSON array of text channels. Display numbered:

```
Connected! Available channels:
  1. #general       (1484077247...)
  2. #news          (1484095703...)
  3. #issues        (1485569037...)
```

Then proceed to **Step 4 (Channel Selection)**.

#### Telegram path
The helper calls `getMe` and returns bot info. Display:

```
Connected! Bot verified:
  Username: @YourBotName
  ID: 123456789
```

Telegram bots cannot list groups/channels via API. Explain to the user:

```
Telegram bots can't auto-discover groups.
You have two options:
  1. Add the bot to a group, send any message, then run /claude2bot:access
     to see the detected chat ID and approve it.
  2. Enter a group chat ID manually if you know it.

Add a group chat ID now? (paste ID or 'skip')
```

If the user provides a chat ID, ask for a label and mode. If 'skip', proceed with DM-only setup.

### 4. Channel Selection (Discord only)
Ask the user to pick the **main** channel by number:
```
Select main channel (number):
```

### 5. Additional Channels
Ask if the user wants to register more channels. For each:
1. Pick by number (Discord) or paste chat ID (Telegram)
2. Choose a label (or use the channel name as default)
3. Set mode: `interactive` (listen + respond) or `monitor` (listen only, report to main)

```
Add another channel? (number/ID or 'done'):
Channel label? (default: channel-name):
Channel mode? (interactive / monitor):
```

### 6. Access Policy
Ask about DM policy:
- `pairing` (default) — new users send a pairing code for approval
- `allowlist` — only pre-approved user IDs can interact
- `disabled` — no DMs accepted

### 7. Voice
Ask if voice message transcription should be enabled:
```
Enable voice transcription? (yes/no)
```
Requires whisper.cpp and ffmpeg installed on the system.

### 8. Write Config
Create the data directory if needed:
```bash
mkdir -p ${CLAUDE_PLUGIN_DATA}
```

Save config to `${CLAUDE_PLUGIN_DATA}/config.json`.

**Discord example:**
```json
{
  "backend": "discord",
  "discord": {
    "token": "the-token"
  },
  "channelsConfig": {
    "main": "general",
    "channels": {
      "general": { "id": "123...", "mode": "interactive" },
      "news": { "id": "456...", "mode": "interactive" }
    }
  },
  "voice": {
    "enabled": true,
    "language": "auto"
  }
}
```

**Telegram example:**
```json
{
  "backend": "telegram",
  "telegram": {
    "token": "123456789:AAH..."
  },
  "channelsConfig": {
    "main": "group1",
    "channels": {
      "group1": { "id": "-100123456789", "mode": "interactive" }
    }
  },
  "voice": {
    "enabled": true,
    "language": "auto"
  }
}
```

Save access.json to `${CLAUDE_PLUGIN_DATA}/<backend>/access.json`:

**Discord:**
```json
{
  "dmPolicy": "pairing",
  "allowFrom": [],
  "channels": {
    "123...": { "requireMention": false, "allowFrom": [] }
  },
  "pending": {}
}
```

**Telegram:**
```json
{
  "dmPolicy": "pairing",
  "allowFrom": [],
  "channels": {},
  "pending": {}
}
```

### 9. Done
Show a summary of what was configured and the next step:

```
Setup complete!

  Backend:  discord|telegram
  Channels: N registered (main: #label)
  Voice:    enabled|disabled
  DM:       pairing mode

Restart your session to activate:
  claude --dangerously-load-development-channels plugin:claude2bot@claude2bot
```
