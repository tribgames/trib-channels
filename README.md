<p align="center">
  <img src="https://img.shields.io/badge/version-0.0.1-blue" alt="version">
  <img src="https://img.shields.io/badge/node-%3E%3D22-green" alt="node">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey" alt="platform">
  <img src="https://img.shields.io/badge/license-Apache%202.0-orange" alt="license">
</p>

# claude2bot

An agentic Discord plugin for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) that bridges your messaging app with a managed Claude session. It handles session lifecycle and builds a self-evolving memory of your conversations.

## Get started

```bash
claude plugin marketplace add https://github.com/claude2bot/claude2bot
claude plugin install claude2bot@claude2bot
```
> Claude Code channel mode is experimental and uses the `--dangerously-load-development-channels` flag.

### Manual installation

If you prefer to manage the session yourself:

```bash
# 1. Add marketplace and install plugin
claude plugin marketplace add https://github.com/claude2bot/claude2bot
claude plugin install claude2bot@claude2bot

# 2. Launch with channel flag
claude --dangerously-load-development-channels plugin:claude2bot@claude2bot

# 3. Run guided setup inside Claude Code
/claude2bot setup
```

## Features

**Discord bridge** — Messages flow between Discord and Claude Code in real time. Claude's responses are auto-forwarded. Permission buttons let you approve tool use from Discord.

**Memory Summarize** — At a scheduled time (default 03:00), claude2bot summarizes the day's conversation and updates memory via the `memory_cycle` MCP tool.

**Memory System** — Conversations are stored in `memory.sqlite`, then consolidated into a daily > weekly > monthly > yearly > lifetime chain. Identity, ongoing tasks, interests, and recent activity are rebuilt into session context.

**Scheduler** — Three modes: non-interactive (`claude -p` tasks), interactive (prompt injection into live session), and proactive (frequency-based autonomous conversations).

**Voice transcription** — Optionally transcribes Discord voice messages using whisper.cpp.

## Setup

1. Install claude2bot as a Claude Code plugin
2. Configure Discord bot token and channel IDs via `/claude2bot setup`
3. Start with `claude --channels plugin:claude2bot@claude2bot`

**Settings**:
- Workspace
- Discord setup
- Autotalk
- Quiet Hours
- Memory Summarize
- Auto-start on Login
- Optional add-ons: ngrok, whisper CLI

## Memory Summarize

```
Summarize time (default 03:00)
  1. Extract user-assistant conversation from transcript
  2. Generate via claude -p:
     - daily summary
     - identity profile (evolves organically)
     - ongoing tasks
     - interest keywords
     - lifetime compressed history
  3. Roll up: daily > weekly > monthly > yearly > lifetime
  4. Build context.md (code concat, no AI)
  5. Restart session with context injected
```

Memory files are stored at `~/.claude/plugins/data/claude2bot-claude2bot/history/`.

## Commands

### Discord slash commands

| Command | Description |
|---------|-------------|
| `/claude stop` | Stop current turn |
| `/claude status` | Session status |
| `/claude model` | Switch model |
| `/claude compact` | Compact conversation |
| `/claude clear` | Clear context |
| `/claude new` | New session |
| `/claude config` | Show config |

### Bot commands (text)

| Command | Description |
|---------|-------------|
| `/bot status` | Dashboard with buttons |
| `/bot autotalk` | Proactive chat settings |
| `/bot quiet` | Quiet hours |
| `/bot sleeping` | Memory Summarize ON/OFF/time |
| `/bot sleeping run` | Run memory summarize manually |
| `/bot display` | View/hide mode |
| `/bot schedule` | Schedule management |
| `/bot profile` | Bot profile |

## Architecture

```
claude --channels plugin:claude2bot@claude2bot
  |
  `-- server.ts (MCP server)
       |-- Discord backend
       |-- Scheduler / events
       |-- Output forwarder
       `-- Memory context injection
```

## Memory System

```
history/
  daily/           Daily summaries (never deleted)
  weekly/          Weekly rollups (max 4)
  monthly/         Monthly rollups (max 12)
  yearly/          Yearly rollups (max 3)
  lifetime.md      Compressed full history
  identity.md      User profile (forms organically)
  interests.json   Keyword frequency tracking
  ongoing.md       Active tasks (cumulative)
  context.md       Injected on session start
```

```
memory.sqlite      Canonical long-term memory store
```

**Compression chain**: daily > weekly > monthly > yearly > lifetime

**Fallback chain**: lifetime > yearly > monthly > weekly > daily

## Requirements

| | Required | Auto-installed |
|---|---|---|
| Node.js | Yes | Yes (brew/winget) |
| Claude Code | Yes | Yes (curl/irm installer) |
| Discord bot token | Yes | Manual setup |
| Discord bot client ID | Yes for invite helper | Manual setup |
| Homebrew (macOS) | Optional | - |
| ngrok | Optional | Manual install |
| whisper.cpp + ffmpeg | Optional | Manual install |

## Support

`dev@tribgames.com`

## License

Apache License 2.0
