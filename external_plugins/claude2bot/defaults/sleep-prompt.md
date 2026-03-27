You are analyzing a day's conversation to generate daily records for the c2b Memory System.

Date: {{DATE}}
History directory: {{HISTORY_DIR}}

Read existing files from {{HISTORY_DIR}}/ if they exist (lifetime.md, identity.md, ongoing.md, interests.json).

The conversation log follows below (u: = user, a: = assistant). Generate/update the following files. Write ALL content in English except proper nouns.

1. Create: {{HISTORY_DIR}}/daily/{{DATE}}.md — Summarize in ~5 lines: tasks worked on, key decisions, completed vs in-progress, user preferences/feedback.

2. Update: {{HISTORY_DIR}}/lifetime.md — Merge today into existing lifetime. Compress older entries. Rolling summary of everything important.

3. Update: {{HISTORY_DIR}}/identity.md — Evolve understanding of the user organically. Personality, preferences, work style, communication patterns, values, frustrations, collaboration expectations. Recent > older.

4. Update: {{HISTORY_DIR}}/ongoing.md — Add new tasks, remove completed, keep in-progress.

5. Update: {{HISTORY_DIR}}/interests.json — Extract keywords, merge counts. Format: {"keyword": {"count": N, "last": "YYYY-MM-DD"}}

Use the Write tool for each file.
