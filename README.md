# claude2bot

> 🤖 100% built with Claude Code — inspired by the official Discord plugin, redesigned as an all-in-one autonomous agent

**v0.1.0-preview** — Claude Code channel mode plugin for autonomous AI agent & personal assistant.

> ⚠️ **Preview**: Claude Code's channel API is currently in preview. The `--dangerously-load-development-channels` flag is required to run this plugin.

## Features

- **Discord-first**: purpose-built Discord channel bridge for Claude Code
- **Built-in scheduler**: non-interactive (`claude -p`), interactive (session inject), proactive (random-interval bot-initiated chat)
- **Voice transcription**: whisper.cpp with cross-platform auto-detection (macOS / Windows / Linux)
- **Access control**: DM allowlists, channel policies, pairing codes
- **Proactive chat**: Memory-driven conversations with feedback loop and idle guard

Windows session control priority:
- Preferred: `WSL tmux`
- Fallback: native PowerShell window activation

## Quick Start

### 1. Add marketplace & install

```bash
claude plugin marketplace add https://github.com/claude2bot/claude2bot
claude plugin install claude2bot@claude2bot
```

### 2. Configure

Run the setup wizard inside a Claude Code session:

```
/claude2bot:setup
```

The wizard will:
- Ask for your Discord bot token
- Connect to verify the token and discover channels
- Let you select main channel and additional channels
- Configure access policy and voice transcription
- Write `config.json` and `access.json` automatically

### 3. Run

```bash
# Channel API is in preview — this flag is required
claude --dangerously-load-development-channels plugin:claude2bot@claude2bot
```

The session will show:
```
Listening for channel messages from: plugin:claude2bot@claude2bot
```

## Commands

| Command | Description |
|---------|-------------|
| `/claude2bot:setup` | Interactive first-time setup |
| `/claude2bot:status` | Bot connection, channels, scheduler status |
| `/claude2bot:schedule` | List, add, remove, or trigger schedules |
| `/claude2bot:access` | Manage allowlists, pairings, DM policy |
| `/claude2bot:doctor` | Diagnose configuration and connectivity |
| `/claude2bot:voice-setup` | Install voice transcription dependencies |

## Configuration Files

| File | Description |
|------|-------------|
| `config.json` | Backend, tokens, channels, schedules, voice settings |
| `access.json` | Per-backend access control policies |
| `settings.default.md` | Default behavioral rules (bundled) |
| `settings.local.md` | User overrides for response style (gitignored) |
| `prompts/` | Schedule prompt templates (`.md` files) |

### Voice Config

```jsonc
{
  "voice": {
    "enabled": true,
    "command": "whisper-cli",    // optional: override binary name or full path
    "model": null,               // optional: path to GGML model file
    "language": "auto"           // "auto" for detection, or BCP-47 code
  }
}
```

Cross-platform auto-detection order: `whisper-cli` → `whisper` → `whisper.cpp`

Requires [whisper.cpp](https://github.com/ggerganov/whisper.cpp) and `ffmpeg`.

## Scheduler Types

| Type | How it runs | Session required? |
|------|-------------|-------------------|
| **non-interactive** | Spawns `claude -p` subprocess | No (independent process) |
| **interactive** | Injects prompt into current session | Yes |
| **proactive** | Random-interval session inject with idle guard | Yes |

## CLI Mirroring

Assistant text and tool activity are forwarded by the MCP server and transcript watcher. Hooks are only used for session bootstrap, turn-end signaling, and permission requests:

| Hook | Purpose |
|------|---------|
| `SessionStart` | Injects bundled + local instruction context |
| `Stop` | Signals turn end so the server can flush final text and clear typing |
| `PermissionRequest` | Sends approve/deny buttons to Discord and waits for decision |

- Action tools (Bash, Edit, Write, Agent, Team) show with `-#` subtext + code block
- Search tools (Read, Grep, Glob) show as `-#` one-liner
- Voice messages are auto-transcribed by the server — no manual processing needed

## License

Apache License 2.0
