---
description: Interactive first-time setup for claude2bot — configure Discord token, channels, and profile.
allowed-tools:
  - AskUserQuestion
  - Read
  - Write
  - Bash(node *)
  - Bash(mkdir *)
---

# claude2bot Setup

Walk the user through initial claude2bot configuration.

**Plugin root**: `${CLAUDE_PLUGIN_ROOT}`
**Data directory**: `${CLAUDE_PLUGIN_DATA}`

## Steps

### 1. Bot Token
Ask for the bot token:
- **Discord**: Bot token from Developer Portal → Bot → Reset Token

```
Paste your bot token:
```

### 2. Verify & Discover

Run the discovery helper:

```bash
node ${CLAUDE_PLUGIN_ROOT}/lib/discover-channels.cjs discord "THE_TOKEN"
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

### 3. Channel Selection
Ask the user to pick the **main** channel by number:
```
Select main channel (number):
```

### 4. Additional Channels
Ask if the user wants to register more channels. For each:
1. Pick by number
2. Choose a label (or use the channel name as default)
3. Set mode: `interactive` (listen + respond) or `monitor` (listen only, report to main)

```
Add another channel? (number/ID or 'done'):
Channel label? (default: channel-name):
Channel mode? (interactive / monitor):
```

### 5. Access Policy
Ask about DM policy:
- `pairing` (default) — new users send a pairing code for approval
- `allowlist` — only pre-approved user IDs can interact
- `disabled` — no DMs accepted

### 6. Voice
Ask if voice message transcription should be enabled:
```
Enable voice transcription? (yes/no)
```
Requires whisper.cpp and ffmpeg installed on the system.

### 7. Write Config
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

### 8. Done
Show a summary of what was configured and the next step:

```
Setup complete!

  Backend:  discord
  Channels: N registered (main: #label)
  Voice:    enabled|disabled
  DM:       pairing mode

Restart your session to activate:
  claude --dangerously-load-development-channels plugin:claude2bot@claude2bot
```
