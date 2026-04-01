# trib-channels

Discord channel plugin for [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

Bridges a Discord bot with a managed Claude Code session -- messages flow bidirectionally, responses are auto-forwarded, and MCP tools give Claude direct access to Discord operations.

## Features

- **Bidirectional Discord bridge** -- inbound Discord messages become Claude notifications; Claude's terminal output is auto-forwarded back to Discord.
- **Voice transcription** -- transcribes Discord voice messages via whisper.cpp.
- **Scheduler** -- non-interactive (`claude -p`), interactive (prompt injection), and proactive (frequency-based) scheduled tasks.
- **Session signal auto-rebinding** -- the SessionStart hook writes a signal file on startup, resume, `/clear`, and `/new`, so the MCP server automatically rebinds to the correct transcript.
- **channelsEnabled bridge control** -- when Claude is started without the `--channels` flag, the output forwarder and inbound notification bridge are disabled while MCP tools (reply, fetch_messages, etc.) remain available.
- **Access control** -- per-channel policies, DM pairing, allowlists, and mention requirements.

## Installation

```bash
claude plugin install tribgames/trib-channels
```

See [CONFIG.md](external_plugins/trib-channels/CONFIG.md) for the full configuration schema.

## Quick Start

### With channels (full bidirectional bridge)

```bash
claude --dangerously-load-development-channels plugin:trib-channels@tribgames
```

This enables the complete bridge: Discord messages arrive as Claude notifications, Claude's text output is auto-forwarded to Discord, and typing indicators are shown while Claude is working.

### Without channels (tools only)

```bash
claude
```

When started without the `--channels` flag, the plugin still loads as an MCP server. Tools like `reply`, `fetch_messages`, `react`, and others work normally -- you can read and send Discord messages on demand. The difference is that there is no automatic output forwarding and no inbound message notifications. The session signal detects this and sets `channelsEnabled: false`.

## Configuration

All settings live in `config.json` inside the plugin data directory (`$CLAUDE_PLUGIN_DATA/config.json`).

Top-level structure:

| Key | Description |
|-----|-------------|
| `backend` | Messaging backend (`"discord"`) |
| `discord.token` | Discord bot token (required) |
| `channelsConfig` | Named channel map with per-channel mode (`interactive` or `monitor`) |
| `access` | Access control: DM policy, allowlists, per-channel rules |
| `nonInteractive` | Scheduled `claude -p` tasks |
| `interactive` | Scheduled prompt injections into the live session |
| `proactive` | Bot-initiated conversation settings |
| `voice` | Whisper transcription settings |
| `contextFiles` | Markdown file paths injected as additional context on session start |

See [CONFIG.md](external_plugins/trib-channels/CONFIG.md) for the complete schema, all fields, and an example configuration.

## MCP Tools

The plugin registers 8 tools on the MCP server:

| Tool | Description |
|------|-------------|
| `reply` | Send a message to a Discord channel. Supports text, file attachments, embeds, and components. |
| `fetch_messages` | Fetch recent messages from a channel (oldest-first, up to 100). |
| `react` | Add an emoji reaction to a message. |
| `edit_message` | Edit a previously sent bot message. Supports text, embeds, and components. |
| `download_attachment` | Download attachments from a message to the local inbox. Returns file paths. |
| `schedule_status` | Show all configured schedules, next fire times, and running state. |
| `trigger_schedule` | Manually trigger a named schedule, ignoring time/day constraints. |
| `schedule_control` | Defer or skip a schedule (`defer` for N minutes, `skip_today` for the rest of the day). |

Backend-dependent tools (`reply`, `fetch_messages`, `react`, `edit_message`, `download_attachment`) auto-connect to Discord on first use if not already connected.

## Hooks

### SessionStart

Fires on session startup, resume, `/clear`, and `/new` -- but only for main interactive sessions (filtered out for sidechains, subagents, and non-interactive/headless runs).

Two responsibilities:

1. **Context injection** -- loads `contextFiles` from `config.json` and `settings.local.md`, then injects them as `additionalContext` into the session.
2. **Session signal** -- writes `session-signal.json` to the runtime directory (see Session Signal below).

Hook command: `node ${CLAUDE_PLUGIN_ROOT}/hooks/session-start.cjs`

### PermissionRequest

Relays tool permission requests to Discord so the user can approve or deny tool use from the messaging app. Has a 15-minute timeout to allow for asynchronous approval.

Hook command: `node ${CLAUDE_PLUGIN_ROOT}/hooks/permission-request.cjs`

### Turn-end signal

Not a hooks.json entry but a file-system mechanism. The MCP server watches for a turn-end marker file written per instance. When detected, it stops typing indicators and flushes any remaining output. This is also triggered by the `/claude stop` Discord command.

## Session Signal

The SessionStart hook writes a `session-signal.json` file to `$TMPDIR/trib-channels/` on every qualifying session event. The MCP server polls this file every second.

Signal payload:

```json
{
  "sessionId": "...",
  "transcriptPath": "...",
  "pid": 12345,
  "ts": 1711929600000,
  "source": "startup",
  "channelsEnabled": true
}
```

Key behaviors:

- **Transcript rebinding** -- when `transcriptPath` changes (e.g., after `/clear` or `/new`), the output forwarder rebinds to the new transcript file.
- **channelsEnabled flag** -- the hook inspects the parent Claude process args to detect `--channels` or `--dangerously-load-development-channels`. When `false`, the forwarder stops and inbound notifications are suppressed. MCP tools continue to work.
- **PID filtering** -- the server only responds to signals from its parent Claude process, preventing cross-session interference.

## Architecture

```
claude --channels plugin:trib-channels@tribgames
  |
  +-- server.ts (MCP server)
  |     |-- Tool handlers (reply, fetch, react, edit, download, schedule)
  |     |-- Session signal watcher (polls session-signal.json)
  |     `-- Turn-end file watcher
  |
  +-- Discord backend
  |     |-- Gateway connection (discord.js)
  |     |-- Inbound message -> MCP notification bridge
  |     `-- Typing indicator management
  |
  +-- Output forwarder
  |     |-- Watches Claude transcript file
  |     `-- Forwards new text to Discord
  |
  +-- Scheduler
  |     |-- Non-interactive jobs (claude -p)
  |     |-- Interactive prompt injection
  |     `-- Proactive conversations
  |
  +-- Event pipeline
  |     `-- Webhook-triggered and scheduled event automation
  |
  +-- Hooks
        |-- session-start.cjs (context + signal)
        `-- permission-request.cjs (Discord relay)
```

## License

[Apache License 2.0](LICENSE)
