---
description: First-time claude2bot installation guide. Use this before the bot is connected to Discord.
allowed-tools:
  - AskUserQuestion
  - Read
  - Write
  - Bash(node *)
  - Bash(mkdir *)
  - Bash(open *)
---

# claude2bot Install

Guide the user through first-time claude2bot installation.

Use this flow when the bot is not connected yet.
If claude2bot is already connected and working, prefer the setup flow instead.

**Plugin root**: `${CLAUDE_PLUGIN_ROOT}`
**Data directory**: `${CLAUDE_PLUGIN_DATA}`

## Language Rule
- Write this guide in English.
- During the actual conversation, always respond in the user's language.
- Keep messages short and action-focused.

## Goal
Complete the minimum steps required to connect claude2bot:
- create or reuse a Discord bot
- collect Bot Token and Application ID
- invite the bot
- pick one main channel
- write the first config files

Do not handle advanced bot settings here.
Leave extra channels, voice, quiet hours, restart helper, and launchd for setup.

## Flow

### 1. Bot readiness
Ask whether the user already has a Discord bot.

If not, offer to open:
`https://discord.com/developers/applications`

### 2. Credentials
Collect:
- Bot Token
- Application ID (Client ID)

### 3. Invite
Generate the bot invite URL using:
- client_id = Application ID
- scopes = `bot applications.commands`

Offer to open the invite URL for the user.

### 4. Verify and discover channels
Run:

```bash
node ${CLAUDE_PLUGIN_ROOT}/lib/discover-channels.cjs discord "THE_TOKEN"
```

If discovery fails:
- explain briefly
- let the user retry token or invite steps
- do not continue until it succeeds

### 5. Main channel only
Show the discovered text channels and ask the user to select exactly one main channel.

Do not ask for extra channels here.

### 6. Access policy
Ask for DM policy:
- pairing
- allowlist
- disabled

Default to `pairing` if the user has no preference.

### 7. Optional profile basics
Offer optional profile fields:
- name
- role
- lang
- tone

### 8. Write files
Create or update:
- `${CLAUDE_PLUGIN_DATA}/config.json`
- `${CLAUDE_PLUGIN_DATA}/discord/access.json`
- `${CLAUDE_PLUGIN_DATA}/profile.json` if profile values were provided

### 9. Completion
Summarize:
- main channel
- DM policy
- profile status

Then tell the user to continue with setup for post-install configuration.
