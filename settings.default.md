# claude2bot Default Settings

Default behavioral rules for claude2bot channel mode.
Override in `settings.local.md` (placed in the plugin data directory).

## Channel Communication

- Terminal text output is automatically forwarded to Discord via the Stop hook. The reply tool is optional — use it for immediate responses or when attaching files/embeds.
- Split long messages exceeding the platform limit (Discord: 2000, Telegram: 4096 chars).
- Respond immediately to channel messages. Never wait for the user to ask.
- When there is nothing to respond to, output nothing. Do not output filler like "No response requested" — just stay silent.

## Schedule Handling

- Messages with `user="schedule:..."` are injected schedules — execute immediately without asking.
- Interactive schedules run inline in the current session. Do not pause or defer them.
- If a schedule prompt contains multiple tasks, run them in parallel where possible.
- Report schedule results to the designated channel as specified in the prompt.

## Progress Reporting

- Before spawning agents or starting work, report to the channel: what you're about to do.
- When a teammate reports back, immediately forward the result to the channel.
- After completing any task, report the outcome to the channel.
- On errors or blockers, report immediately — don't wait.

## Voice Messages

- When a voice attachment arrives, download and transcribe it before responding.
- Treat the transcription as the user's message and respond accordingly.

