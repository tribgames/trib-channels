export function cleanMemoryText(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<memory-context>[\s\S]*?<\/memory-context>/gi, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi, '')
    .replace(/<command-name>[\s\S]*?<\/command-name>/gi, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/gi, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/gi, '')
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/gi, '')
    .replace(/<tool-use-id>[\s\S]*?<\/tool-use-id>/gi, '')
    .replace(/<output-file>[\s\S]*?<\/output-file>/gi, '')
    .replace(/^[ \t]*\|.*\|[ \t]*$/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/^#{1,4}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/<channel[^>]*>\n?([\s\S]*?)\n?<\/channel>/g, '$1')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<schedule-context>[\s\S]*?<\/schedule-context>/g, '')
    .replace(/<teammate-message[\s\S]*?<\/teammate-message>/g, '')
    .replace(/^This session is being continued from a previous conversation[\s\S]*?(?=\n\n|$)/gim, '')
    .replace(/^\[[^\]\n]{1,140}\]\s*$/gm, '')
    .replace(/^\s*●\s.*$/gm, '')
    .replace(/^\s*Ran .*$/gm, '')
    .replace(/^\s*Command: .*$/gm, '')
    .replace(/^\s*Process exited .*$/gm, '')
    .replace(/^\s*Full transcript available at: .*$/gm, '')
    .replace(/^\s*Read the output file to retrieve the result: .*$/gm, '')
    .replace(/^\s*Original token count: .*$/gm, '')
    .replace(/^\s*Wall time: .*$/gm, '')
    .replace(/^\s*Chunk ID: .*$/gm, '')
    .replace(/^\s*tool_uses: .*$/gm, '')
    .replace(/^\s*menu item .*$/gm, '')
    .replace(/[\u{1F300}-\u{1FAD6}\u{2600}-\u{27BF}]/gu, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .replace(/^\s+|\s+$/gm, '')
    .trim()
}

function compactClause(label, value) {
  const clean = cleanMemoryText(value)
  if (!clean) return ''
  return `${label}: ${clean}`
}

export function composeTaskDetails(task = {}) {
  const base = cleanMemoryText(task?.details ?? '')
  const extras = [
    compactClause('Goal', task?.goal),
    compactClause('Integration', task?.integration_point),
    compactClause('Blocked by', task?.blocked_by),
    compactClause('Next', task?.next_step),
    Array.isArray(task?.related_to) && task.related_to.length
      ? compactClause('Related', task.related_to.join(', '))
      : compactClause('Related', task?.related_to),
  ].filter(Boolean)
  if (!base && extras.length === 0) return ''
  if (!base) return extras.join(' | ')
  if (extras.length === 0) return base
  return `${base} | ${extras.join(' | ')}`
}

export function classifyMemorySentence(factType, text) {
  const clean = cleanMemoryText(text)
  const hasImperative = /\b(should|must|needs to|need to|expected to|prefer|preferred|do not|don't|must not|should not)\b/i.test(clean)
    || /해야|하지 마|하면 안|금지|우선|선호/.test(clean)
  const hasTaskVerb = /\b(implement|finalize|add|remove|move|fix|investigate|analyze|review|refactor|clean(?: ?up)?|persist|deduplicate|harden|align|extend|wire)\b/i.test(clean)
    || /구현|마무리|추가|제거|이동|수정|조사|분석|리뷰|리팩터|정리|저장|중복 제거|강화|맞추|연결/.test(clean)
  const isRequestNarration = /\bthe user (asked|requested|wants|wanted|is actively improving|explicitly asked)\b/i.test(clean)
    || /사용자가 .*요청했|유저가 .*요청했|분석해달라고 요청|계속 진행해달라고 요청/.test(clean)

  const operationRuleTopic = /\b(commit|push|build|deploy|approval|language|tone|timezone|transcript prompt|durable memory|profile source of truth|identity storage|api keys?|credentials?)\b/i.test(clean)
    || /커밋|푸시|빌드|배포|승인|언어|말투|어투|시간대|장기기억|transcript prompt|source of truth|정체성 저장|API 키|자격 증명/.test(clean)
  const jsonOutputRuleTopic = ((/\b(json|schema)\b/i.test(clean) || /JSON|스키마/.test(clean))
    && (/\b(output|response|format|return)\b/i.test(clean) || /출력|응답|형식|반환/.test(clean)))
  const userRuleTopic = operationRuleTopic || jsonOutputRuleTopic

  const durableStorageTopic = /\b(sqlite|context\.md|source of truth|primary store|long-term memory|profile data|identity storage|storage architecture|persistence path)\b/i.test(clean)
    || /SQLite|context\.md|source of truth|장기 메모리|저장 구조|저장 경로|프로필 데이터|정체성 저장/.test(clean)

  const internalMaintenanceTopic = /\b(mcp|session start|startup|profile hints?|memory-context|current time|notification|output|discord-visible|verify(?:ing|ication)?|ambiguous hints?|source episodes?|state file|cycle status|catch-up execution|candidate|cycle\s*\d|stale cleanup|dedup(?:lication)?|ingestion|pipeline|routing parameters|provider abstraction|config|schema\/readme|benchmark|vacuum|tool-call output|memory-edit actions?)\b/i.test(clean)
    || /세션 시작|시작 시|프로필 힌트|memory-context|현재 시간|알림|출력|verify|검증 체인|애매한 힌트|source episode|state file|cycle status|catch-up|candidate|cycle|stale cleanup|중복|ingestion|파이프라인|provider abstraction|설정|벤치마크|vacuum|tool-call output|memory-edit/.test(clean)

  const internalDataModelCommentary = /\b(profiles? currently overwrite|signals use additive scoring|automatic .* not yet fully wired|instructions are sent once|sections are maintained as|implemented with .* parameters|uses two memory injection paths)\b/i.test(clean)
    || /현재 overwrite-on-write|signals .* additive|아직 fully wired|instructions are sent once|섹션 구성|파라미터를 포함해 구현|두 개의 memory injection path/.test(clean)

  if (isRequestNarration) return { category: 'request_narration', keepFact: false }
  if (userRuleTopic) return { category: 'user_rule', keepFact: true }
  if (internalDataModelCommentary) return { category: 'internal_commentary', keepFact: false }
  if (durableStorageTopic && !internalMaintenanceTopic) return { category: 'storage_decision', keepFact: true }
  if (internalMaintenanceTopic && (hasImperative || hasTaskVerb)) return { category: 'maintenance_task', keepFact: false }
  if (internalMaintenanceTopic) return { category: 'internal_commentary', keepFact: false }
  if (factType === 'preference') return { category: 'preference', keepFact: true }
  return { category: 'generic', keepFact: true }
}

export function shouldKeepFact(factType, text, confidence) {
  const clean = cleanMemoryText(text)
  if (!clean) return false
  const classification = classifyMemorySentence(factType, clean)
  if (!classification.keepFact) return false
  const compact = clean.replace(/\s+/g, '')
  if (compact.length < 18) return false
  const words = clean.split(/\s+/).filter(Boolean).length
  if (words < 4) return false
  const score = Number(confidence ?? 0.6)
  const minScore =
    factType === 'decision' ? 0.82 :
    factType === 'constraint' ? 0.75 :
    factType === 'preference' ? 0.74 :
    0.86
  const minWords =
    factType === 'decision' || factType === 'fact' ? 6 : 5
  if (words < minWords) return false
  return score >= minScore
}

export function shouldKeepSignal(kind, value, score) {
  const clean = cleanMemoryText(value)
  if (!clean) return false
  const compact = clean.replace(/\s+/g, '')
  if (compact.length < 18) return false
  const words = clean.split(/\s+/).filter(Boolean).length
  if (words < 5) return false
  return Number(score ?? 0.5) >= 0.72
}
