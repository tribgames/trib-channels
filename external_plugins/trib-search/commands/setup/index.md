---
description: Configure trib-search defaults such as raw provider priority, AI default provider, result count, and crawl limits.
args: ""
allowed-tools:
  - AskUserQuestion
  - Read
  - Write
  - Edit
---

# trib-search Setup

Manage `${CLAUDE_PLUGIN_DATA}/config.json`.

If the file does not exist, create it with this base shape:

```json
{
  "rawProviders": ["serper", "brave", "perplexity", "firecrawl", "tavily"],
  "rawMaxResults": 5,
  "aiDefaultProvider": "gemini",
  "aiTimeoutMs": 120000,
  "grokApiKey": "",
  "firecrawlApiKey": "",
  "aiModels": {
    "grok": "grok-4",
    "gemini": "gemini-2.5-pro",
    "claude": "sonnet",
    "codex": "gpt-5"
  },
  "requestTimeoutMs": 30000,
  "crawl": {
    "maxPages": 10,
    "maxDepth": 1,
    "sameDomainOnly": true
  }
}
```

Ask the user for:
1. Raw search provider priority as a comma-separated list.
2. Default raw result count.
3. Default AI provider (`grok`, `gemini`, `claude`, or `codex`).
4. Optional `grokApiKey` for direct xAI API mode.
5. Optional `firecrawlApiKey` for Firecrawl search and fallback scraping.
6. Optional default model per AI provider.
7. Crawl defaults: `maxPages`, `maxDepth`, and `sameDomainOnly`.

Write only the changed fields back to `${CLAUDE_PLUGIN_DATA}/config.json`.
