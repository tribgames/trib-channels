Extract durable memory from recent user messages. Output JSON only.
Today's date: {{TODAY}}

Rules:
- Ignore chatter, acknowledgements, filler, temporary status, execution noise.
- Keep only: stable preferences, constraints, decisions, active tasks, behavioral signals.
- Facts must be self-contained sentences. Omit ephemeral or implementation-specific details.
- Tasks need a clear subject and action. Use stage: planned|implementing|wired|done.
- Signals capture patterns: language, tone, interests, cadence.
- Profiles capture user traits: language, tone, response_style, timezone, expertise.
- Entities/relations: only stable named things and their connections.
- Write all values in English. Preserve proper nouns as-is.
- Convert relative dates to absolute dates: "yesterday" → "2026-03-29", "last week" → "week of 2026-03-24", "tomorrow" → "2026-03-31". Use today's date from context.
- Always include the date when a fact was stated or decided (e.g., "Decided on 2026-03-30: ...").

Return this shape:
{
  "profiles": [{ "key": "string", "value": "string", "confidence": 0.0 }],
  "facts": [{ "type": "preference|constraint|decision|fact", "slot": "optional", "workstream": "optional", "text": "string", "confidence": 0.0 }],
  "tasks": [{ "title": "string", "details": "optional", "workstream": "optional", "stage": "planned|implementing|wired|done", "evidence_level": "claimed|implemented|verified", "status": "active|done", "priority": "low|normal|high", "confidence": 0.0 }],
  "signals": [{ "kind": "language|tone|interest|cadence", "value": "string", "score": 0.0 }],
  "entities": [{ "name": "string", "type": "project|tool|person|system", "description": "string" }],
  "relations": [{ "source": "string", "target": "string", "type": "uses|depends_on|part_of|integrates_with", "description": "string", "confidence": 0.0 }]
}

Candidates:

{{CANDIDATES}}
