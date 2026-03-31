You are consolidating high-signal long-term memory candidates for claude2bot.

Rules:
- Output JSON only.
- Ignore chatter, acknowledgements, emotional filler, temporary status, and execution noise.
- Prefer durable preferences, constraints, stable facts, explicit decisions, and active tasks.
- Prefer user-explicit rules, user preferences, user-confirmed decisions, and concrete ongoing work over internal commentary about the pipeline itself.
- Each candidate may include a short surrounding turn span under `Context:`. Use that local span to understand what the candidate refers to.
- Treat the whole local span as evidence, but only extract durable memory if the meaning is still stable and reusable later.
- If a candidate is ambiguous or likely temporary, drop it.
- Keep facts short and reusable.
- Facts should be rare. Only keep a fact if it is likely to matter across many future conversations.
- Do not turn implementation details, temporary debugging notes, or one-off observations into facts.
- Do not turn temporary system-health observations, missing-data explanations, candidate-threshold commentary, schema/debug notes, or "why the pipeline currently looks empty/noisy" explanations into durable facts.
- Do not store memory about how the memory pipeline itself should be cleaned up, scheduled, bootstrapped, or configured unless the user explicitly approved it as a lasting external rule that materially affects future behavior.
- Do not turn a single day's worklog, a local refactor note, or a temporary implementation choice into a durable fact.
- If an item mainly says what was discussed or worked on that day, it belongs in the daily summary, not in durable memory.
- Do not turn internal maintenance rules into durable facts just because they are written as "should", "must", or "needs to".
- Internal rules about startup cleanup, verification chains, mode parameters, context injection timing, notification/output filtering, stale cleanup thresholds, dedup internals, or benchmark/config work should become tasks or be dropped.
- Do not keep "the user asked/requested us to analyze/improve/refactor X" as a durable fact or decision. That is a task, not long-term memory.
- Stable architectural wiring may be kept as a decision or fact if it explains where a long-lived system behavior is attached, injected, persisted, or routed.
- Keep architectural memory only when it explains a long-lived user-facing behavior, storage boundary, retrieval contract, or explicit operational rule. Drop meta commentary about cleanup state, backlog thresholds, or current extraction quality.
- Reject internal-maintenance commentary such as:
  - how many candidates trigger a cycle
  - why context sections are empty/noisy
  - MCP singleton/process cleanup mechanics
  - where bot.json/settings files should live
  - how profile hints are injected per turn
  - how the memory system should be debugged or benchmarked
- These may still become tasks if they describe active work, but they should not become durable facts/decisions unless they are explicit user-facing operating rules.
- Strongly prefer `task` instead of `fact/decision` for:
  - process cleanup work
  - duplicate ingestion fixes
  - output filtering/sanitization work
  - cycle scheduling or threshold tuning work
  - recall mode implementation work
  - benchmark/evaluation work
  - prompt/config/schema cleanups
- If a candidate sounds like an internal implementation note for maintainers, extract it as a task or drop it.
- If you keep an architectural wiring memory, name the integration point explicitly (component + timing or component + path), not just the feature name.
- Add an optional `workstream` when a fact or task clearly belongs to a stable project/workstream cluster. Keep it short, stable, and generic.
- Good workstream labels are things like `claude2bot-memory`, `codex-integration`, `discord-output`, `schedule-ux`, `payroll-system`.
- Do not invent a workstream when the cluster is unclear.
- Only include `slot` when a fact should supersede or overwrite an older fact in the same stable category.
- If `slot` is not clearly needed, omit it.
- When you do include `slot`, keep it stable, short, and generic. Never include dates, random IDs, or project-unique noise in the slot.
- Every memory sentence must be self-contained. Include a clear subject, target, and action/state.
- If the text is primarily about the memory system's temporary failure state, extraction gap, or internal refactor bookkeeping, drop it unless it encodes an explicit long-term rule or decision.
- Avoid shorthand fragments like "remove the GUI", "inside the Codex harness", or "improve Discord formatting". Rewrite them into complete sentences.
- Prefer forms like:
  - "The user prefers ..."
  - "The current task is ..."
  - "The agreed decision is ..."
  - "The system constraint is ..."
  - "The retrieval pipeline injects ..."
  - "The session-start hook loads ..."
  - "The storage layer persists ... through ..."
- Tasks should represent actionable ongoing work, not vague topics.
- Tasks must reflect concrete user-requested work items, defects, or follow-up actions. Prefer task extraction over fact extraction when the sentence describes work to be done.
- If a sentence says the system "should", "must", or "needs to" do some internal maintenance/refactor/cleanup work, prefer a task or drop it; do not turn it into a durable fact by default.
- Task titles must name both the subject and the action. Avoid bare titles like "remove GUI" or "formatting fix".
- Put longer explanation, rationale, and next-step context in `details`, not in the title.
- For tasks, estimate the current lifecycle stage as one of: `planned`, `investigating`, `implementing`, `wired`, `verified`, `done`.
- For tasks, estimate the confidence/evidence level as one of: `claimed`, `implemented`, `verified`.
- Extract at least 1 signal per batch when any notable interaction pattern, topic interest, or behavioral cue is present.
- Prefer broad patterns, but narrow signals (single topic interest, one-off preference) are acceptable at lower scores (0.3-0.5).
- Always extract at least 1 profile item per batch if any user trait, preference, or communication style is mentioned or implied. Even weak signals (confidence 0.3) are valuable. Prefer keys like `language`, `tone`, `address`, `response_style`, `timezone`, `work_hours`, `expertise`.
- Extract entities and relations when a candidate mentions named things (projects, tools, people, systems) and their connections.
- Entity types: `project`, `tool`, `person`, `system`, `concept`, `service`.
- Relation types: `uses`, `depends_on`, `part_of`, `created_by`, `integrates_with`, `replaced_by`, `blocks`.
- Only extract entities/relations that are stable and likely to matter in future conversations.
- Do not extract ephemeral entities or trivial relationships.
- Preserve the source language of each JSON string value. Do not translate just to normalize.
- Keep each extracted value in the same language as the evidence that supports it.
- If the evidence mixes languages, preserve that mix unless a field is clearly canonical.
- Preserve proper nouns, product names, identifiers, model names, and mixed-language technical terms as-is.
- If an "Existing memories" section is provided at the end, use it to avoid duplicates and detect changes.
- Existing memories may be tagged [similar] or [conflict]:
  - [similar]: High semantic overlap with new candidates. Skip if the meaning is identical. If slightly different, merge into one updated fact.
  - [conflict]: Same topic/slot but contradictory value. Prioritize the most recent information. Output the updated version as a new fact (the system will handle deprecation of the old one).
- Skip any candidate that is already covered by an existing memory with the same meaning.
- If a candidate updates or contradicts an existing memory, output the updated version as a new fact (the system will handle deprecation).
- If two or more similar existing facts can be combined into one without losing information, output a single merged fact that covers both. The system will deprecate the originals.
- Mark updated facts clearly when they supersede existing ones.

Return this exact shape:
{
  "profiles": [
    { "key": "language|tone|address|response_style|timezone", "value": "short stable profile value", "confidence": 0.0 }
  ],
  "facts": [
    { "type": "preference|constraint|decision|fact", "slot": "optional-stable-slot", "workstream": "optional-stable-workstream", "text": "short durable fact", "confidence": 0.0 }
  ],
  "tasks": [
    {
      "title": "task title",
      "details": "optional details",
      "workstream": "optional-stable-workstream",
      "stage": "planned|investigating|implementing|wired|verified|done",
      "evidence_level": "claimed|implemented|verified",
      "goal": "optional short goal",
      "integration_point": "optional component or path",
      "blocked_by": "optional blocker",
      "next_step": "optional next action",
      "related_to": ["optional related item"],
      "status": "active|in_progress|paused|done",
      "priority": "low|normal|high",
      "confidence": 0.0
    }
  ],
  "signals": [
    { "kind": "language|tone|time_pref|interest|cadence", "value": "stable pattern", "score": 0.0 }
  ],
  "entities": [
    { "name": "entity name", "type": "project|tool|person|system|concept|service", "description": "short description" }
  ],
  "relations": [
    { "source": "entity name", "target": "entity name", "type": "uses|depends_on|part_of|created_by|integrates_with|replaced_by|blocks", "description": "short description", "confidence": 0.0 }
  ]
}

Candidates for {{DATE}}:

{{CANDIDATES}}
