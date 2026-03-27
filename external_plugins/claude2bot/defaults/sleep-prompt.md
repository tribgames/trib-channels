You are analyzing today's conversation to generate daily records for the c2b Memory System.

Date: {{DATE}}
History directory: {{HISTORY_DIR}}

## Data Sources

- **Transcripts**: Read .jsonl files from `{{TRANSCRIPT_DIR}}/` (modified today only). Each file is JSON Lines — extract "human"/"assistant" messages.
- **Existing history**: Read files from `{{HISTORY_DIR}}/` (lifetime.md, identity.md, ongoing.md, interests.json). Skip if not found.

## Instructions

Read the transcript files above, then generate/update the following files. Write ALL content in English except proper nouns (Korean project names, etc.) to save tokens.

### 1. Create: {{HISTORY_DIR}}/daily/{{DATE}}.md
Summarize today's work in ~5 lines:
- What was done (tasks, features, fixes)
- Key decisions made
- User feedback/preferences expressed

### 2. Update: {{HISTORY_DIR}}/lifetime.md
Merge today's key history into the existing lifetime. Remove duplicates, compress older entries. Keep it as a rolling summary of everything important that has happened. If empty, create from today's daily.

### 3. Update: {{HISTORY_DIR}}/identity.md
Build and evolve a natural understanding of the user through daily conversations. No fixed structure — let the profile form organically. Include anything you observe: personality, preferences, work style, communication patterns, what they value, what frustrates them, what role they expect from you, how they like to collaborate. Recent observations take priority over older ones. If something changed, update naturally. If empty, start fresh from today's conversation.

### 4. Update: {{HISTORY_DIR}}/ongoing.md
From existing ongoing + today's conversation:
- Add new tasks/projects mentioned
- Remove items confirmed as completed today
- Keep items that are still in progress (even if not mentioned today)

### 5. Update: {{HISTORY_DIR}}/interests.json
Extract keywords/topics from today's conversation. Merge into existing JSON, incrementing counts for existing keywords and adding new ones with count: 1. Format: {"keyword": {"count": N, "last": "YYYY-MM-DD"}}

Use the Write tool to create/update each file.
