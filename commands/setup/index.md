---
description: Post-install claude2bot setup and reconfiguration. Use this after the bot is already connected.
allowed-tools:
  - AskUserQuestion
  - Read
  - Write
  - Bash(node *)
  - Bash(mkdir *)
---

# claude2bot Setup

Walk the user through post-install claude2bot configuration.

If the bot is not connected yet, prefer the install flow first.

**Plugin root**: `${CLAUDE_PLUGIN_ROOT}`
**Data directory**: `${CLAUDE_PLUGIN_DATA}`

## Language Rule
- Write this guide in English.
- During the actual conversation, always respond in the user's language.
- Keep messages short and action-focused.

## Scope
Use this flow for:
- adding or changing channels
- reviewing access policy
- editing profile values
- enabling voice features
- quiet/autotalk settings
- advanced maintenance tasks

## Entry
Start by checking whether the basic install is already complete:
- config exists
- bot token exists
- main channel exists

If not, tell the user to run the install flow first.

If yes, offer a short menu:
- Channels & Access
- Profile
- Voice
- Quiet / Autotalk
- Restart Helper
- launchd

## Channels & Access
Treat channels and access as one configuration area.

Cover:
- main channel
- extra channels
- interactive / monitor mode
- requireMention
- allowFrom
- DM policy

## Profile
Update profile fields such as:
- name
- role
- lang
- tone

## Voice
Handle voice enablement and voice-related config.
If system dependencies are missing, guide the user to the voice setup flow.

## Quiet / Autotalk
Update bot.json settings for:
- schedule quiet hours
- autotalk quiet hours
- holiday country
- autotalk frequency / enabled state

## Restart Helper / launchd
Treat these as advanced optional features.
Only guide the user into them when explicitly requested.

## Completion
Show a short summary of what changed and the relevant file paths.
