---
description: View and configure trib-channels settings — channels, access, profile, voice, quiet hours, autotalk, memory summarize.
args: "[status|channels|access|profile|voice|quiet|autotalk|sleeping] [detail]"
allowed-tools:
  - AskUserQuestion
  - Read
  - Write
  - Edit
---

# trib-channels Setup

Manage post-install configuration. Parse the command arguments to determine the action.

## Config Files
| File | Path |
|------|------|
| config.json | `${CLAUDE_PLUGIN_DATA}/config.json` |
| bot.json | `${CLAUDE_PLUGIN_DATA}/bot.json` |
| profile.json | `${CLAUDE_PLUGIN_DATA}/profile.json` |
| access policy | `${CLAUDE_PLUGIN_DATA}/config.json` → `access` |

## Actions

### status (default)
Read config.json, bot.json, and profile.json and display a compact summary of current settings: channels (main + count), access (DM policy + user count), profile (name, role, lang, tone), voice (enabled/disabled), quiet hours, and autotalk state.

### channels
Manage `channelsConfig` in config.json.

If no detail is given, display current channels and return.

To **add** a channel:
1. Ask for label (kebab-case), channel ID, mode (`interactive` or `monitor`) using AskUserQuestion
2. Add to `channelsConfig.channels` in `${CLAUDE_PLUGIN_DATA}/config.json`
3. Also add `access.channels.{id}` entry in `${CLAUDE_PLUGIN_DATA}/config.json` with `{ "requireMention": true, "allowFrom": [] }`

To **remove** a channel:
1. Delete from `channelsConfig.channels` in config.json
2. Remove corresponding channel ID entry from `access.channels`

To **set main**:
- Update `channelsConfig.main` in config.json to the given label.

To **change mode**:
- Update the channel's `mode` field in config.json.

### access
Manage `access` section in `${CLAUDE_PLUGIN_DATA}/config.json`.

If no detail is given, display current DM policy, allowed users, and per-channel policies.

To **change DM policy**:
- Set `dmPolicy` to `pairing`, `allowlist`, or `disabled`.

To **allow a user**:
- Add user ID to top-level `allowFrom` array (skip if already present).

To **deny a user**:
- Remove user ID from top-level `allowFrom` array.

To **update channel policy**:
- Set `channels.{channelId}.requireMention` and `channels.{channelId}.allowFrom`.

### profile
Manage `${CLAUDE_PLUGIN_DATA}/profile.json`.

If no detail is given, display current profile values (name, role, lang, tone).

To **update fields**:
1. Read current profile.json — show each field's current value or "not set"
2. Ask for each field using AskUserQuestion: name, role, lang, tone — allow skip per field
3. Write only changed fields to profile.json

Fields:
- **name** — display name for the bot to address you
- **role** — your role (e.g., "game developer")
- **lang** — preferred language code (e.g., "ko", "en")
- **tone** — response tone (e.g., "casual", "professional")

### voice
Manage `voice` section in `${CLAUDE_PLUGIN_DATA}/config.json`.

Voice transcription is automatic for voice attachments. This section only manages whisper command, model, and language overrides.

If no detail is given, display current voice settings (command, model, language).

To **set command**: set `voice.command` to the whisper binary path. Use `"auto"` to clear.

To **set model**: set `voice.model` to the GGML model path. Use `"default"` to clear.

To **set language**: set `voice.language` to a BCP-47 code or `"auto"`.

### quiet
Manage quiet hours in `${CLAUDE_PLUGIN_DATA}/bot.json` and proactive DND in `${CLAUDE_PLUGIN_DATA}/config.json`.

If no detail is given, display current quiet hours and proactive DND settings.

To **set schedule quiet**: set `quiet.schedule` to `"HH:MM-HH:MM"` (e.g., `"23:00-07:00"`). Set to `null` or delete the key to remove.

To **set autotalk quiet**: set `quiet.autotalk` to `"HH:MM-HH:MM"`. Set to `null` or delete the key to remove.

To **set holidays**: set `quiet.holidays` to ISO country code (e.g., `"KR"`). Set to `null` or delete the key to remove.

To **set timezone**: set `quiet.timezone` to IANA timezone (e.g., `"Asia/Seoul"`). Set to `null` or delete the key to remove.

Proactive DND has been unified into `quiet.schedule`. No separate proactive DND settings needed.

### autotalk
Manage autotalk settings in `${CLAUDE_PLUGIN_DATA}/bot.json`.

If no detail is given, display current autotalk state (enabled, frequency).

To **toggle autotalk**: flip `autotalk.enabled` in bot.json.

To **set frequency**: set `autotalk.freq` to 1-5 (1=~1/day, 5=~10/day) in bot.json.

### sleeping
Manage Memory Summarize in `${CLAUDE_PLUGIN_DATA}/bot.json`.

If no detail is given, display current summarize state (enabled, time, lastSleepAt).

To **toggle**: set `sleepEnabled` to `true` or `false`.

To **set time**: set `sleepTime` to `"HH:MM"` (e.g., `"03:00"`).

To **run now**: inform user to use `/trib-channels memory sleep` or the MCP `memory_cycle` tool.

Memory Summarize daily summarizes conversations, updates identity/ongoing/interests/lifetime, and restarts the session. Memory files are at `${CLAUDE_PLUGIN_DATA}/history/`.

### quiet (updated)
Note: proactive DND (`proactive.dndStart/dndEnd`) has been removed. All quiet hours now use `quiet.schedule` in bot.json only.
