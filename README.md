# claude2bot

Discord channel plugin for Claude Code with live chat forwarding, slash controls, scheduler flows, permission buttons, and optional voice transcription.

Preview note:
- Claude Code channel mode is still experimental.
- In the current preview environment, this plugin is expected to be both installed/enabled and launched with the development channel flag.

Support:
- `dev@tribgames.com`

## What It Does

- Bridges Discord channel messages into Claude Code
- Mirrors Claude responses back to Discord
- Supports slash commands for session status, schedule management, diagnostics, and bot settings
- Provides permission approval buttons for tool use
- Supports scheduler-driven interactive, non-interactive, and proactive flows
- Optionally transcribes voice messages

## Recommended Runtime

- macOS:
  Run Claude Code inside `tmux`.

- Windows:
  Run Claude Code inside `WSL + tmux`.

- Windows native PowerShell:
  Supported as a limited fallback only.
  Status and configuration commands still work, but live session-control commands are not fully reliable unless the Claude window can be activated.

## PowerShell Limitation

On native Windows PowerShell, the plugin can still handle CLI-style and config-driven features such as:

- `/claude status`
- `/claude usage`
- `/claude config`
- `/claude2bot setup`
- `/claude2bot schedule`
- `/claude2bot doctor`

Commands that inject input into the live Claude session are best used in `tmux` or `WSL tmux`:

- `/claude model`
- `/claude compact`
- `/claude clear`
- `/claude new`

`/claude stop` is usually the only native PowerShell session-control command that behaves acceptably, but `WSL tmux` is still the recommended Windows setup.

## Installation

### 1. Add the marketplace source

```bash
claude plugin marketplace add https://github.com/claude2bot/claude2bot
```

### 2. Install the plugin

```bash
claude plugin install claude2bot@claude2bot
```

### 3. Verify the plugin is enabled

Make sure `~/.claude/settings.json` contains:

```json
{
  "enabledPlugins": {
    "claude2bot@claude2bot": true
  }
}
```

### 4. Launch Claude Code with the development channel flag

```bash
claude --dangerously-load-development-channels plugin:claude2bot@claude2bot
```

This is currently the expected launch command for preview channel mode.

### 5. Run the setup flow

Inside Claude Code, run:

```text
/claude2bot setup
```

The setup flow will guide you through:

- post-install bot configuration
- channel and access settings
- profile, quiet hours, and voice settings
- schedule and diagnostics entry points

## Daily Start Command

After installation, the normal start command is:

```bash
claude --dangerously-load-development-channels plugin:claude2bot@claude2bot
```

Recommended examples:

```bash
# macOS
tmux new -s claude
claude --dangerously-load-development-channels plugin:claude2bot@claude2bot
```

```bash
# Windows via WSL
wsl
tmux new -s claude
claude --dangerously-load-development-channels plugin:claude2bot@claude2bot
```

## Slash Commands

### Session control

- `/claude stop`
- `/claude status`
- `/claude usage`
- `/claude config`
- `/claude model`
- `/claude compact`
- `/claude clear`
- `/claude new`

### Bot operations

- `/claude2bot setup`
- `/claude2bot schedule`
- `/claude2bot doctor`

## Runtime Files

Main plugin data:

- `config.json`
- `bot.json`
- `profile.json`
- `discord/access.json`
- `prompts/*.md`

Session runtime files are created under the system temp directory for turn-end, permission, control, and status signaling.

## External Dependencies

Required:

- Node.js
- npm
- Discord bot token

Recommended for full session control:

- macOS/Linux: `tmux`
- Windows: `WSL + tmux`

Optional:

- `ffmpeg`
- `whisper.cpp` or compatible `whisper-cli`

## Current Packaging Note

The preview package currently starts through `.mcp.json` with:

- `npm install --silent`
- `npx tsx server.ts`

That means first-run startup can be slower than a prebuilt distribution.

## License

Apache License 2.0
