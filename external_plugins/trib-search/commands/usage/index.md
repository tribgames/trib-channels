---
description: Show trib-search provider state, routing cache, and recent usage snapshot.
args: ""
allowed-tools:
  - Read
---

# trib-search Usage

Read `${CLAUDE_PLUGIN_DATA}/usage.local.json` and summarize:

1. Providers with `updatedAt`, `lastUsedAt`, `lastSuccessAt`, `lastFailureAt`, `cooldownUntil`, and quota fields if present.
2. `routingCache.rawBySite`.
3. `routingCache.scrapeByHost`.

If the file does not exist, say that no usage data has been recorded yet.
