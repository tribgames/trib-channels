---
description: Explain claude2bot Autotalk — proactive conversation feature where the bot initiates topics based on context and memory.
user_invocable: true
---

# Autotalk

Autotalk is a proactive conversation feature. When enabled, claude2bot occasionally initiates conversations based on recent context, memory, and user interests.

## How it works

1. Bot monitors idle time in the Discord channel
2. When the user hasn't been active for a while, bot may start a conversation
3. Topics are chosen based on: ongoing tasks, recent interests, scheduled items, or general check-ins
4. Respects quiet hours — won't talk during DND periods

## Frequency levels

| Level | Messages/day | Description |
|-------|-------------|-------------|
| 1 | ~3/day | Very low — occasional check-ins |
| 2 | ~5/day | Low |
| 3 | ~7/day | Medium (default) |
| 4 | ~10/day | High |
| 5 | ~15/day | Very high — frequent engagement |

## Settings

Configure via tray app Settings or `/setup`:
- **Autotalk**: ON/OFF
- **Frequency**: 1-5 (or OFF)

## Behavior

- Will not interrupt active conversations
- Adjusts tone by time of day (morning: light, evening: wrap-up)
- If user declines, backs off gracefully
- Combined with Sleeping Mode memory for context-aware topics
