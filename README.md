# claude2bot

> 🤖 100% built with Claude Code — inspired by the official Discord & Telegram plugins, redesigned as an all-in-one autonomous agent

Claude Code channel mode plugin — Autonomous AI agent & personal assistant for messengers.

## Features

- Discord & Telegram support (multi-backend)
- Built-in scheduler (non-interactive, interactive, proactive)
- Voice transcription (whisper.cpp)
- Access control & pairing
- Proactive chat with feedback loop

## Quick Start

1. Install: `/plugin marketplace add claude2bot/claude2bot`
2. Enable: `enabledPlugins: { "claude2bot@claude2bot": true }`
3. Setup: `/claude2bot:setup`
4. Run: `claude --channels plugin:claude2bot@claude2bot`

## Commands

- `/claude2bot:setup` — Initial configuration
- `/claude2bot:status` — Bot & scheduler status
- `/claude2bot:schedule` — Manage schedules
- `/claude2bot:access` — Access control
- `/claude2bot:doctor` — Diagnostics

## Configuration

- `config.json` — Bot tokens, channels, schedules
- `settings.local.md` — Custom response rules (gitignored)
- `access.json` — Access control policies

## License

Apache License 2.0
