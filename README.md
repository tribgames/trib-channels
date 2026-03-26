<p align="center">
  <h1 align="center">claude2bot</h1>
  <p align="center">
    Discord plugin for Claude Code — live chat, session control, scheduling, and self-evolving memory.
  </p>
  <p align="center">
    <a href="#quick-install">Install</a> ·
    <a href="#features">Features</a> ·
    <a href="#sleeping-mode">Sleeping Mode</a> ·
    <a href="#commands">Commands</a> ·
    <a href="https://github.com/claude2bot/claude2bot/releases">Releases</a>
  </p>
</p>

> [!NOTE]
> Claude Code channel mode is still experimental. claude2bot uses the `--dangerously-load-development-channels` flag.

---

## Quick Install

**macOS:**
```bash
curl -fsSL https://github.com/claude2bot/claude2bot/releases/latest/download/install.sh | bash
```

**Windows:**
```powershell
irm https://github.com/claude2bot/claude2bot/releases/latest/download/install.ps1 | iex
```

One command. Downloads the launcher, installs dependencies, and starts everything.

**Manual:**
```bash
claude plugin marketplace add https://github.com/claude2bot/claude2bot
claude plugin install claude2bot@claude2bot
claude --dangerously-load-development-channels plugin:claude2bot@claude2bot
```

---

## Features

### Discord Bridge
Messages flow between Discord and Claude Code in real time. Claude's responses are auto-forwarded. Permission buttons let you approve tool use from Discord.

### Tray App
A native menu bar app (`c2b`) for macOS and Windows. Launch, restart, toggle visibility, configure settings — all from the tray.

| | macOS | Windows |
|---|---|---|
| **Format** | `.app` (Swift) | `.exe` (PowerShell) |
| **Install** | `curl \| bash` | `irm \| iex` |
| **Terminal** | WezTerm (mux) | WezTerm (mux) |

### View / Hide Toggle
Switch between visible terminal and background mode instantly. No session restart needed — Claude keeps running in the mux server.

### Settings GUI
Configure from the tray menu:
- **Workspace** — project folder
- **Autotalk** — proactive conversation frequency (OFF ~ Very High)
- **Quiet Hours** — no notifications during set hours
- **Sleeping Mode** — daily summary + session restart
- **Auto-start on Login**
- **Voice Support** — install whisper.cpp
- **Plugin Update**

### Scheduler
Three scheduling modes:
- **Non-interactive** — `claude -p` one-shot tasks
- **Interactive** — inject prompts into live session
- **Proactive** — frequency-based autonomous conversations

### Voice Transcription
Optional. Transcribes Discord voice messages using whisper.cpp and feeds text into the session.

---

## Sleeping Mode

At the scheduled time (default 03:00), claude2bot:

1. **Stops** the current session
2. **Extracts** user-assistant conversation from transcript (no code/tool noise)
3. **Summarizes** via `claude -p`:
   - `daily/` — what happened today
   - `identity.md` — who you are (evolves naturally)
   - `ongoing.md` — active tasks
   - `interests.json` — topic frequency
   - `lifetime.md` — compressed full history
4. **Rolls up**: daily → weekly → monthly → yearly → lifetime
5. **Restarts** with full context injected into the new session

Next session, Claude knows what happened, what's ongoing, and who you are.

```
history/
├─ daily/           Never deleted
├─ weekly/          Rollup from dailies
├─ monthly/         Rollup from weeklies
├─ yearly/          Rollup from monthlies
├─ lifetime.md      Everything compressed
├─ identity.md      User profile (organic)
├─ ongoing.md       Active tasks
├─ interests.json   Keywords + frequency
└─ context.md       Injected on session start
```

---

## Commands

### Discord Slash Commands

| Command | Description |
|---------|-------------|
| `/claude stop` | Stop current turn |
| `/claude status` | Session status |
| `/claude model [name]` | Switch model |
| `/claude compact` | Compact conversation |
| `/claude clear` | Clear context |
| `/claude new` | New session |
| `/claude config` | Show config |

### Bot Text Commands

| Command | Description |
|---------|-------------|
| `/bot autotalk` | Proactive chat settings |
| `/bot quiet` | Quiet hours settings |
| `/bot schedule` | Schedule management |
| `/bot profile` | Bot profile |
| `/bot launcher` | Launcher status |

### Launcher CLI

```bash
launcher install        # Install all dependencies
launcher launch         # Start session
launcher restart        # Stop + launch
launcher stop           # Stop everything
launcher sleep-cycle    # Run sleeping mode now
launcher display [mode] # View or hide
launcher workspace [p]  # Set workspace
launcher doctor         # Environment check
```

---

## Architecture

```
Tray App (Swift / PowerShell)
  └─ launcher.mjs
       └─ WezTerm mux
            └─ Claude Code
                 └─ server.ts (MCP)
                      ├─ Discord backend
                      ├─ Scheduler
                      ├─ Output forwarder
                      └─ Memory System
```

---

## Requirements

| | Required | Optional |
|---|---|---|
| **Runtime** | Node.js | |
| **Package Manager** | brew (macOS) / winget (Windows) | |
| **Discord** | Bot token | |
| **Voice** | | whisper.cpp + ffmpeg |

All dependencies are auto-installed by the launcher.

---

## Support

`dev@tribgames.com`

## License

Apache License 2.0
