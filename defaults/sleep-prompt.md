You are analyzing today's conversation to generate daily records for the c2b Memory System.

Date: {{DATE}}
History directory: {{HISTORY_DIR}}

## Existing Files

### lifetime.md (cumulative history compression)
{{LIFETIME}}

### identity.md (user profile, recent > past)
{{IDENTITY}}

### ongoing.md (active tasks, cumulative)
{{ONGOING}}

### interests.json (keyword frequency tracking)
{{INTERESTS}}

## Today's Conversation (user ↔ assistant ping-pong only)

{{PINGPONG}}

---

## Instructions

Analyze the conversation above and generate/update the following files. Write ALL content in English except proper nouns (Korean project names, etc.) to save tokens.

### 1. Create: {{HISTORY_DIR}}/daily/{{DATE}}.md
Summarize today's work in ~5 lines:
- What was done (tasks, features, fixes)
- Key decisions made
- User feedback/preferences expressed

### 2. Update: {{HISTORY_DIR}}/lifetime.md
Merge today's key history into the existing lifetime. Remove duplicates, compress older entries. Keep it as a rolling summary of everything important that has happened. If empty, create from today's daily.

### 3. Update: {{HISTORY_DIR}}/identity.md
Extract any user traits, preferences, or feedback from today's conversation. Merge into existing identity with "recent > past" priority — if today's behavior contradicts older entries, update to reflect the latest. Structure as:
- Current (recent behavior)
- Core (stable long-term traits)
If empty, create from today's observations.

### 4. Update: {{HISTORY_DIR}}/ongoing.md
From existing ongoing + today's conversation:
- Add new tasks/projects mentioned
- Remove items confirmed as completed today
- Keep items that are still in progress (even if not mentioned today)

### 5. Update: {{HISTORY_DIR}}/interests.json
Extract keywords/topics from today's conversation. Merge into existing JSON, incrementing counts for existing keywords and adding new ones with count: 1. Format: {"keyword": {"count": N, "last": "YYYY-MM-DD"}}

Use the Write tool to create/update each file.
