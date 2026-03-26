---
description: Diagnose claude2bot configuration and connectivity issues.
allowed-tools:
  - Read
  - Bash(node *)
  - Bash(which *)
  - Bash(ls *)
---

# claude2bot Doctor

Run diagnostic checks and report issues with actionable fixes.

## Checks to perform

### 1. Config File
- Does `${CLAUDE_PLUGIN_DATA}/config.json` exist?
- Is it valid JSON?
- Does it have a `backend` field?
- Fix: "Run /claude2bot setup to create the config"

### 2. Bot Token
- Is the token present in config?
- Is it non-empty?
- Fix: "Add your bot token to config.json discord.token"

### 3. Backend Connection
- Try to verify the bot can reach the messaging platform
- Check if the bot user tag is available
- Fix: "Check your token and network connectivity"

### 4. Access Control
- Does access.json exist?
- Are there any allowed users or group channels?
- Fix: "Open /claude2bot setup and review Channels & Access"

### 5. Schedules
- Are any schedules configured? (nonInteractive, interactive, proactive)
- For each timed schedule, does the prompt file exist at `{promptsDir}/{name}.md`?
- For each proactive topic, does the prompt file exist at `{promptsDir}/{topic}.md`?
- If proactive.feedback is true, does `proactive-feedback.md` exist in DATA_DIR?
- Fix: "Create prompt file at {promptsDir}/{name}.md"

### 6. Settings Files
- Does settings.default.md exist (bundled)?
- Does settings.local.md exist (optional)?
- Any contextFiles referenced in config that are missing?

### 7. Channels
- Is `channelsConfig` present in config.json?
- Is a `main` channel defined?
- Do all channel IDs look valid?
- Fix: "Run /claude2bot setup to configure channels"

### 8. Voice (if enabled)
- Is `voice.enabled` true in config.json?
- Is `whisper` (or `whisper.cpp`) available in PATH?
- Is `ffmpeg` available in PATH?
- Fix: "Install whisper and ffmpeg for voice transcription"

### 9. Dependencies
- Is `claude` CLI available in PATH?
- Is `node` (v18+) available?
- Is `npx tsx` available?

## Output Format
```
[PASS] Config file found
[PASS] Bot token present
[FAIL] Access control: no users or channels configured
       Fix: Open /claude2bot setup and update Channels & Access
[WARN] Schedule "weather": prompt file not found
       Fix: Create /path/to/schedules/weather.md
```
