You are improving retrieval quality for a long-term memory system.

For each memory item below, write a short contextual retrieval note that helps semantic search.

Rules:
- Output JSON only.
- Keep each note to 1-2 sentences.
- Preserve important names, technologies, and nouns.
- Add surrounding context: why this memory matters, what it relates to, and how it should be retrieved later.
- Do not restate metadata mechanically.
- Keep the note in the same dominant language as the memory item whenever possible. Do not translate just to normalize. Preserve proper nouns, product names, identifiers, and mixed-language technical terms as-is.

Return this exact shape:
{
  "items": [
    { "key": "fact:123", "context": "short retrieval-oriented context" }
  ]
}

Memory items:

{{ITEMS}}
