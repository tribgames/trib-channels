<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.0-blue" alt="version">
  <img src="https://img.shields.io/badge/node-%3E%3D22-green" alt="node">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey" alt="platform">
  <img src="https://img.shields.io/badge/license-Apache%202.0-orange" alt="license">
</p>

# claude2bot

An agentic Discord plugin for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) that bridges your messaging app with a managed Claude session. It lives in your system tray, handles session lifecycle, and builds a self-evolving memory of your conversations.

## Get started

### macOS

```bash
curl -fsSL https://github.com/claude2bot/claude2bot/releases/latest/download/install.sh | bash
```

### Windows

```powershell
irm https://github.com/claude2bot/claude2bot/releases/latest/download/install.ps1 | iex
```

One command installs the launcher, sets up dependencies (Claude CLI, Node.js, WezTerm), and starts the tray app.

> [!NOTE]
> macOS requires [Homebrew](https://brew.sh). Windows uses winget (built-in).
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

**Tray app** — Native menu bar app (`c2b`) for macOS (Swift) and Windows (PowerShell). Launch, restart, toggle visibility, and configure settings from the system tray.

**View / Hide toggle** — Switch between visible terminal and background mode instantly. No session restart — Claude keeps running in the WezTerm mux server.

**Sleeping Mode** — At a scheduled time (default 03:00), claude2bot summarizes the day's conversation, updates your identity profile, and restarts the session with full context.

**Memory System** — Conversations compress through a daily > weekly > monthly > yearly > lifetime chain. Your identity, ongoing tasks, and interests are tracked and injected into every new session.

**Scheduler** — Three modes: non-interactive (`claude -p` tasks), interactive (prompt injection into live session), and proactive (frequency-based autonomous conversations).

**Voice transcription** — Optionally transcribes Discord voice messages using whisper.cpp.

## Tray app

The tray app is the primary control center.

| | macOS | Windows |
|---|---|---|
| Format | `.app` (Swift) | `.exe` / `.ps1` (PowerShell) |
| Install | `curl \| bash` | `irm \| iex` |
| Terminal | WezTerm (mux) | WezTerm (mux) |

**Menu**: Launch / Restart / View Mode / Hide Mode / Settings / Quit

**Settings**: Workspace, Autotalk frequency, Quiet Hours, Sleeping Mode, Auto-start on Login, Voice Support, Plugin Update

**Lifecycle**:
- Start: stop old sessions > install deps > launch new session
- Quit: stop all processes (GUI + mux + Claude)
- Sleep: summarize > restart

## Sleeping Mode

```
Sleep time (default 03:00)
  1. Stop session
  2. Extract user-assistant conversation from transcript
  3. Generate via claude -p:
     - daily summary
     - identity profile (evolves organically)
     - ongoing tasks
     - interest keywords
     - lifetime compressed history
  4. Roll up: daily > weekly > monthly > yearly > lifetime
  5. Build context.md (code concat, no AI)
  6. Restart session with context injected
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
| `/bot sleeping` | Sleeping mode ON/OFF/time |
| `/bot display` | View/hide mode |
| `/bot schedule` | Schedule management |
| `/bot profile` | Bot profile |
| `/bot launcher` | Launcher status |

### Launcher CLI

```bash
node launcher.mjs install        # Install dependencies
node launcher.mjs launch         # Start session
node launcher.mjs restart        # Stop + launch
node launcher.mjs stop           # Stop everything
node launcher.mjs sleep-cycle    # Run sleeping mode now
node launcher.mjs display [mode] # View or hide
node launcher.mjs workspace [p]  # Set workspace
node launcher.mjs doctor         # Environment check
```

## Architecture

```
Tray App (Swift / PowerShell)
  |
  +-- launcher.mjs (session lifecycle)
       |
       +-- WezTerm mux (terminal management)
            |
            +-- claude --channels plugin:claude2bot@claude2bot
                 |
                 +-- server.ts (MCP server)
                      |-- Discord backend (discord.js)
                      |-- Scheduler (interactive / non-interactive / proactive)
                      |-- Output forwarder (transcript > Discord)
                      +-- Memory System (context.md > MCP instructions)
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

**Compression chain**: daily > weekly > monthly > yearly > lifetime

**Fallback chain**: lifetime > yearly > monthly > weekly > daily

## Requirements

| | Required | Auto-installed |
|---|---|---|
| Node.js | Yes | Yes (brew/winget) |
| Claude Code | Yes | Yes (curl/irm installer) |
| WezTerm | Yes | Yes (brew/winget) |
| Discord bot token | Yes | Manual setup |
| Homebrew (macOS) | Yes | - |
| whisper.cpp + ffmpeg | Optional | Via Settings |

## Support

`dev@tribgames.com`

## License

Apache License 2.0
