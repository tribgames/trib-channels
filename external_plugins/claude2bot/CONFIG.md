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

`provider: "local"` uses `Xenova/bge-m3` (1024 dimensions) by default.
The model is downloaded automatically on first use through `@xenova/transformers`, so no extra Ollama setup is required.
When switching embedding models, rebuild the memory vectors before relying on dense retrieval again.

---

## `memory`

Memory cycle configuration. The runtime centers on one active worker plus one manual consolidation path:

- **cycle1**: Main update worker — runs on an interval and can auto-trigger when pending candidates back up
- **cycle2**: Consolidation settings — used by the merged update flow and manual refresh paths

### `memory.cycle1`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `interval` | string | `"5m"` | Extraction interval. Values: `"immediate"`, `"5m"`, `"10m"`, `"30m"`, `"1h"`. `"immediate"` triggers on every new episode instead of using a timer. |
| `maxPending` | number | — | When pending candidates reach this count, cycle1 auto-runs immediately. Unset = disabled. |
| `timeout` | number | `60000` | LLM call timeout in milliseconds |
| `maxCandidatesPerBatch` | number | `50` | Max candidates processed per LLM batch |
| `maxBatches` | number | `5` | Max batches per cycle1 run |
| `provider` | object | codex | LLM provider for extraction |
| `provider.connection` | string | `"codex"` | Provider type: `"codex"`, `"cli"`, `"ollama"`, `"api"` |
| `provider.model` | string | `"gpt-5.4"` | Model identifier |
| `provider.effort` | string | `"medium"` | Reasoning effort level |
| `provider.fast` | boolean | `true` | Use fast service tier |
| `provider.baseUrl` | string | — | Custom API base URL (for `"ollama"` or `"api"`) |

### `memory.cycle2`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `schedule` | string | `"03:00"` | Time of day to run consolidation (`"HH:MM"`) |
| `maxCandidates` | number | — | When pending candidates exceed this count, consolidation runs immediately (bypasses schedule). Unset = no auto-trigger. |
| `provider` | object | codex | LLM provider for consolidation |
| `provider.connection` | string | `"codex"` | Provider type |
| `provider.model` | string | `"gpt-5.4"` | Model identifier |
| `provider.effort` | string | `"medium"` | Reasoning effort level |
| `provider.fast` | boolean | `true` | Use fast service tier |
| `provider.baseUrl` | string | — | Custom API base URL |

## `retrieval`

Retrieval tuning configuration. All keys are optional; if omitted, the current built-in defaults remain active.

### `retrieval.intent`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `topScoreMin` | number | `0.74` | Minimum top intent score before considering the classifier confident |
| `gapMin` | number | `0.05` | Minimum gap between top-1 and top-2 intent scores |

### `retrieval.secondStageThreshold`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `default` | number | `-0.50` | Fallback rerank threshold |
| `profile` | number | `-0.42` | Profile intent threshold |
| `task` | number | `-0.42` | Task intent threshold |
| `policy` | number | `-0.44` | Policy intent threshold |
| `history` | number | `-0.40` | History intent threshold |
| `event` | number | `-0.40` | Event intent threshold |
| `graph` | number | `-0.46` | Graph intent threshold |

### `retrieval.hintInjection`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `compositeWeights.relevance` | number | `0.58` | Composite relevance weight |
| `compositeWeights.confidence` | number | `0.27` | Composite confidence weight |
| `compositeWeights.overlap` | number | `0.15` | Composite lexical overlap weight |
| `thresholds.<type>.relevance` | number | varies | Per-type minimum relevance gate |
| `thresholds.<type>.composite` | number | varies | Per-type minimum composite gate |
| `thresholds.<type>.confidence` | number | varies | Per-type confidence gate |
| `thresholds.<type>.overlap` | number | varies | Per-type overlap gate |

### `retrieval.weights`

Representative tuning groups:

- `recency.*`
- `overlap.*`
- `typeBoost.*`
- `intentBoost.*`
- `taskStagePenalty.*`
- `doneTask.*`
- `taskSeed.*`
- `history.representative.*`
- `history.exactDate.*`

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
      "interval": "5m",
      "maxPending": 30,
      "provider": {
        "connection": "codex",
        "model": "gpt-5.4",
        "effort": "medium",
        "fast": true
      }
    },
    "cycle2": {
      "schedule": "03:00",
      "maxCandidates": 50,
      "provider": {
        "connection": "codex",
        "model": "gpt-5.4",
        "effort": "medium",
        "fast": true
      }
    },
    "cycle3": {
      "schedule": "03:00",
      "day": "daily",
      "hardDelete": false,
      "provider": {
        "connection": "codex",
        "model": "gpt-5.4",
        "effort": "medium",
        "fast": true
      }
    }
  },
  "retrieval": {
    "intent": {
      "topScoreMin": 0.74,
      "gapMin": 0.05
    },
    "secondStageThreshold": {
      "default": -0.5,
      "task": -0.42,
      "history": -0.4
    },
    "hintInjection": {
      "compositeWeights": {
        "relevance": 0.58,
        "confidence": 0.27,
        "overlap": 0.15
      }
    },
    "weights": {
      "taskStagePenalty": {
        "planned": 0.12,
        "implementing": -0.03
      },
      "taskSeed": {
        "ongoingQuery": {
          "plannedPenalty": -0.85
        }
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
