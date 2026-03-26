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
Extract from today's conversation and merge into existing identity with "recent > past" priority. Structure as:

**User** (who they are):
- Current traits (recent behavior/preferences)
- Core traits (stable long-term)

**What They Seem to Want From Me** (observed patterns, written as "seems to..."):
- What kind of work they seem to enjoy me doing
- How they seem to prefer I communicate
- Workflow patterns they seem to like (e.g., "seems to prefer I just execute rather than ask")
- Things that seemed to frustrate them

If empty, create both sections from today's observations.

### 4. Update: {{HISTORY_DIR}}/ongoing.md
From existing ongoing + today's conversation:
- Add new tasks/projects mentioned
- Remove items confirmed as completed today
- Keep items that are still in progress (even if not mentioned today)

### 5. Update: {{HISTORY_DIR}}/interests.json
Extract keywords/topics from today's conversation. Merge into existing JSON, incrementing counts for existing keywords and adding new ones with count: 1. Format: {"keyword": {"count": N, "last": "YYYY-MM-DD"}}

Use the Write tool to create/update each file.
