# claude2bot Configuration Reference

All settings live in `config.json` inside the plugin data directory (`$CLAUDE_PLUGIN_DATA/config.json`).

---

## Top-Level

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `backend` | `"discord"` | `"discord"` | Messaging backend (only Discord supported) |
| `discord` | object | — | Discord connection settings |
| `discord.token` | string | **required** | Discord bot token |
| `discord.stateDir` | string | `<data>/discord` | Directory for Discord state files |
| `access` | object | — | Access control settings |
| `channelsConfig` | object | — | Named channel configuration |
| `contextFiles` | string[] | `[]` | MD file paths injected as additional context |
| `nonInteractive` | TimedSchedule[] | `[]` | Spawns separate `claude -p` sessions at scheduled times |
| `interactive` | TimedSchedule[] | `[]` | Injects prompts into the current session at scheduled times |
| `proactive` | object | — | Bot-initiated conversation settings |
| `promptsDir` | string | — | Directory containing prompt `.md` files |
| `voice` | object | — | Voice message transcription settings |
| `language` | string | — | UI / response language override (`"ko"`, `"en"`, `"ja"`) |
| `webhook` | object | — | Webhook receiver configuration |
| `events` | object | — | Event automation system configuration |
| `embedding` | object | — | Embedding provider configuration |
| `memory` | object | — | Memory cycle configuration (see below) |

---

## `access`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `dmPolicy` | `"pairing"` \| `"allowlist"` \| `"disabled"` | `"pairing"` | DM access policy |
| `allowFrom` | string[] | `[]` | User IDs allowed to interact |
| `channels` | object | `{}` | Per-channel access policies |
| `channels.<id>.requireMention` | boolean | — | Whether bot requires @mention |
| `channels.<id>.allowFrom` | string[] | — | User IDs allowed in this channel |
| `mentionPatterns` | string[] | — | Custom mention patterns |
| `ackReaction` | string | — | Emoji reaction for message acknowledgment |
| `replyToMode` | `"off"` \| `"first"` \| `"all"` | — | Reply threading mode |
| `textChunkLimit` | number | — | Max characters per message chunk |
| `chunkMode` | `"length"` \| `"newline"` | — | How to split long messages |

---

## `channelsConfig`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `main` | string | `"general"` | Label of the main channel |
| `channels` | object | — | Named channels map |
| `channels.<name>.id` | string | — | Platform-specific channel ID |
| `channels.<name>.mode` | `"interactive"` \| `"monitor"` | — | `interactive` = listen + respond, `monitor` = listen only |

---

## `voice`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `command` | string | auto-detect | Whisper binary name or absolute path |
| `model` | string | — | GGML model file path |
| `language` | string | `"auto"` | BCP-47 language code or `"auto"` |

---

## `embedding`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `provider` | `"local"` \| `"ollama"` | `"local"` | Embedding provider |
| `ollamaModel` | string | — | Ollama model name (when provider is `"ollama"`) |

---

## `memory`

Memory cycle configuration. The system runs three cycles:

- **cycle1**: Lightweight extraction — runs on an interval or immediately on new episodes
- **cycle2**: Consolidation — daily deep processing of pending candidates
- **cycle3**: Weekly decay — gradual cleanup and retention control

### `memory.cycle1`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `interval` | string | `"10m"` | Extraction interval. Values: `"immediate"`, `"5m"`, `"10m"`, `"30m"`, `"1h"`. `"immediate"` triggers on every new episode instead of using a timer. |
| `timeout` | number | `60000` | LLM call timeout in milliseconds |
| `maxCandidatesPerBatch` | number | `50` | Max candidates processed per LLM batch |
| `maxBatches` | number | `5` | Max batches per cycle1 run |
| `provider` | object | codex | LLM provider for extraction |
| `provider.connection` | string | `"codex"` | Provider type: `"codex"`, `"cli"`, `"ollama"`, `"api"` |
| `provider.model` | string | `"gpt-5.3-codex-spark"` | Model identifier |
| `provider.effort` | string | `"medium"` | Reasoning effort level |
| `provider.fast` | boolean | `false` | Use fast service tier |
| `provider.baseUrl` | string | — | Custom API base URL (for `"ollama"` or `"api"`) |

### `memory.cycle2`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `schedule` | string | `"03:00"` | Time of day to run consolidation (`"HH:MM"`) |
| `maxCandidates` | number | — | When pending candidates exceed this count, consolidation runs immediately (bypasses schedule). Unset = no auto-trigger. |
| `provider` | object | cli (claude) | LLM provider for consolidation |
| `provider.connection` | string | `"cli"` | Provider type |
| `provider.model` | string | `"sonnet"` | Model identifier |
| `provider.effort` | string | — | Reasoning effort level |
| `provider.fast` | boolean | `false` | Use fast service tier |
| `provider.baseUrl` | string | — | Custom API base URL |

### `memory.cycle3`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `schedule` | string | `"03:00"` | Time of day to run weekly decay (`"HH:MM"`) |
| `day` | string | `"sunday"` | Day of week: `"monday"` through `"sunday"` |
| `provider` | object | cli (claude) | LLM provider for weekly decay |
| `provider.connection` | string | `"cli"` | Provider type |
| `provider.model` | string | `"sonnet"` | Model identifier |
| `provider.effort` | string | — | Reasoning effort level |
| `provider.fast` | boolean | `false` | Use fast service tier |
| `provider.baseUrl` | string | — | Custom API base URL |

---

## Example Configuration

```json
{
  "backend": "discord",
  "discord": {
    "token": "YOUR_BOT_TOKEN"
  },
  "channelsConfig": {
    "main": "general",
    "channels": {
      "general": { "id": "123456789", "mode": "interactive" }
    }
  },
  "access": {
    "dmPolicy": "pairing",
    "allowFrom": ["USER_ID"]
  },
  "embedding": {
    "provider": "local"
  },
  "memory": {
    "cycle1": {
      "interval": "10m",
      "provider": {
        "connection": "codex",
        "model": "gpt-5.3-codex-spark",
        "effort": "medium"
      }
    },
    "cycle2": {
      "schedule": "03:00",
      "maxCandidates": 50,
      "provider": {
        "connection": "cli",
        "model": "sonnet"
      }
    },
    "cycle3": {
      "schedule": "03:00",
      "day": "sunday",
      "provider": {
        "connection": "cli",
        "model": "sonnet"
      }
    }
  }
}
```

---

## Provider Types

| Connection | Description | Requirements |
|-----------|-------------|--------------|
| `codex` | OpenAI Codex CLI | `codex` binary in PATH |
| `cli` | Claude Code CLI (`claude -p`) | `claude` binary in PATH |
| `ollama` | Local Ollama server | Ollama running, `baseUrl` optional |
| `api` | Direct API call | `baseUrl` required |

---

## Fact Status Values

Facts in the memory database can have the following status values:

| Status | Description |
|--------|-------------|
| `active` | Current, valid fact — included in search results |
| `stale` | Not seen recently — excluded from active queries |
| `superseded` | Replaced by a newer fact (via semantic dedup, similarity > 0.75) |
| `deprecated` | Explicitly deprecated — excluded from all searches |
