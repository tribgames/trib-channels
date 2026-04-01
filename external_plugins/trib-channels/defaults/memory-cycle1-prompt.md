Extract durable memory from recent user messages. Output JSON only.
Today's date: {{TODAY}}

Rules:
- Ignore chatter, acknowledgements, filler, temporary status, execution noise.
- Keep only: stable preferences, constraints, decisions, active tasks, behavioral signals.
- Prefer user-explicit operational rules, preferences, and concrete requested work over internal commentary about the memory pipeline itself.
- Facts must be self-contained sentences. Omit ephemeral or implementation-specific details.
- Do not extract temporary explanations about why memory is empty/noisy, candidate-threshold commentary, schema/debug notes, or internal refactor bookkeeping as durable facts.
- Do not extract provider/model selection notes, update cadence tuning, CRUD/schema field debates, or current system-health observations as durable facts.
- Strongly prefer tasks over facts when the text is about fixing cleanup logic, duplicate ingestion, prompt/config/schema changes, scheduling thresholds, recall-mode implementation, or benchmark/evaluation work.
- Tasks need a clear subject and action. Use stage: planned|implementing|wired|done.
- If a sentence is about concrete work to do, bug investigation, or follow-up implementation, prefer extracting it as a task rather than a fact.
- Do not turn internal maintenance rules into durable facts just because they are written as "should", "must", or "needs to".
- Internal rules about startup cleanup, verification chains, mode parameters, context injection timing, notification/output filtering, stale cleanup thresholds, dedup internals, or benchmark/config work should become tasks or be dropped.
- Do not keep "the user asked/requested us to analyze/improve/refactor X" as a durable fact or decision. That is a task, not long-term memory.
- Signals capture patterns: language, tone, interests, cadence.
- Profiles capture user traits: language, tone, response_style, timezone, expertise.
- Extract bug fixes, architectural changes, and debugging resolutions as facts with type "resolution".
- Resolution format: "Fixed [problem] by [solution] in [component]."
- Only extract final resolutions, not investigation steps.
- Extract recurring development patterns as signals with kind "dev_pattern" (e.g., "prefers 3-phase migration: extract→inline→delete", "uses dedup as first approach for race conditions").
- Entities/relations: only stable named things and their connections.
- Preserve the source language of each value. Do not translate just to normalize.
- Keep each extracted value in the same language as the evidence that supports it.
- If the source evidence mixes languages, preserve that mix unless a field is clearly canonical.
- Preserve proper nouns, identifiers, file paths, model names, and mixed-language technical terms as-is.
- If existing memories are tagged [similar], skip if the meaning is identical. Merge if slightly different.
- If existing memories are tagged [conflict], prioritize the most recent information. Output the updated version.
- If contradictory information exists between existing memories and new input, prioritize the most recent.
- Convert relative dates to absolute dates: "yesterday" → "2026-03-29", "last week" → "week of 2026-03-24", "tomorrow" → "2026-03-31". Use today's date from context.
- Always include the date when a fact was stated or decided (e.g., "Decided on 2026-03-30: ...").

Return this shape:
{
  "profiles": [{ "key": "string", "value": "string", "confidence": 0.0 }],
  "facts": [{ "type": "preference|constraint|decision|fact|resolution", "slot": "optional", "workstream": "optional", "text": "string", "confidence": 0.0 }],
  "tasks": [{ "title": "string", "details": "optional", "workstream": "optional", "stage": "planned|implementing|wired|done", "evidence_level": "claimed|implemented|verified", "status": "active|done", "priority": "low|normal|high", "confidence": 0.0 }],
  "signals": [{ "kind": "language|tone|interest|cadence|dev_pattern", "value": "string", "score": 0.0 }],
  "entities": [{ "name": "string", "type": "project|tool|person|system", "description": "string" }],
  "relations": [{ "source": "string", "target": "string", "type": "uses|depends_on|part_of|integrates_with", "description": "string", "confidence": 0.0 }]
}

Candidates:

{{CANDIDATES}}
