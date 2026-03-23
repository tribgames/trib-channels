---
description: Manage cc-bot access control — approve pairings, edit allowlists, set DM/group policy.
args: "[pair|allow|deny|policy|channel|show] [value]"
allowed-tools:
  - AskUserQuestion
  - Read
  - Write
---

# cc-bot Access Control

Manage who can communicate with the bot through the messaging channel.

Read the current access.json from the backend state directory.

## access.json Structure
```json
{
  "dmPolicy": "pairing",
  "allowFrom": ["286..."],
  "channels": {
    "148...": { "requireMention": false, "allowFrom": [] }
  }
}
```
- `dmPolicy`: pairing / allowlist / disabled
- `allowFrom` (top-level): user IDs allowed to DM the bot
- `channels`: keyed by **channel ID** (not label), per-channel access rules

## Actions

### show (default)
Display current access configuration:
- DM policy
- Allowed user IDs (from top-level `allowFrom`)
- Per-channel policies (by channel ID)
- Pending pairing requests

### pair [code]
Approve a pending pairing request. Look up the code in `access.json` pending entries:
1. Find the pending entry matching the code
2. Add the sender to the top-level `allowFrom` array
3. Remove from pending
4. Write an approval marker file to `approved/{senderId}` with the DM channel ID
5. Save access.json

### allow [userId]
Add a user ID directly to the top-level `allowFrom` array.

### deny [userId]
Remove a user ID from the top-level `allowFrom` array.

### policy [pairing|allowlist|disabled]
Change the DM access policy (`dmPolicy` field).

### channel [channelId] [requireMention] [allowFrom...]
Add or update a per-channel access policy (keyed by channel ID):
- `requireMention`: true/false (default true)
- `allowFrom`: comma-separated user IDs, or empty for all

## File Location
Access file: `{stateDir}/access.json` (stateDir from config.json discord.stateDir)
