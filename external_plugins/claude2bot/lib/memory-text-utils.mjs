import {
  cleanMemoryText,
  classifyCandidateConcept,
} from './memory-extraction.mjs'

const MEMORY_TOKEN_ALIASES = new Map([
  ['윈도우', 'windows'],
  ['호환성', 'compatibility'],
  ['대응', 'compatibility'],
  ['중복', 'duplicate'],
  ['메시지', 'message'],
  ['리콜', 'recall'],
  ['배포', 'deploy'],
  ['빌드', 'build'],
  ['커밋', 'commit'],
  ['푸시', 'push'],
  ['클라', 'client'],
  ['서버', 'server'],
  ['호칭', 'address'],
  ['말투', 'tone'],
  ['어투', 'tone'],
  ['시간대', 'timezone'],
  ['타임존', 'timezone'],
  ['deployment', 'deploy'],
])

const MEMORY_TOKEN_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'did', 'do', 'does', 'for', 'from',
  'how', 'i', 'if', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'our', 'so', 'that', 'the',
  'their', 'them', 'they', 'this', 'to', 'was', 'we', 'were', 'what', 'when', 'who', 'why', 'you',
  'your', 'unless', 'with',
  'user', 'assistant', 'requested', 'request', 'asked', 'ask', 'stated', 'state', 'reported', 'report',
  'mentioned', 'mention', 'clarified', 'clarify', 'explicitly', 'currently',
  '사용자', '유저', '요청', '질문', '답변', '언급', '말씀', '설명', '보고', '무슨', '뭐야', '했지',
])

const SUBJECT_STOPWORDS = new Set([
  ...MEMORY_TOKEN_STOPWORDS,
  'active', 'current', 'ongoing', 'issue', 'issues', 'problem', 'weakness', 'weaknesses', 'thing', 'things',
  '현재', '핵심', '문제', '약점', '이슈',
])

export function firstTextContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
}

export function looksLowSignal(text) {
  const clean = cleanMemoryText(text)
  if (!clean) return true
  if (clean.includes('[Request interrupted by user]')) return true
  if (/<event-result[\s>]|<event\s/i.test(String(text ?? ''))) return true
  if (/^(read|list|show|count|find|tell me|summarize)\b/i.test(clean) && /(\/|\.jsonl\b|\.md\b|\.csv\b|\bfilenames?\b)/i.test(clean)) return true
  if (/^no response requested\.?$/i.test(clean)) return true
  if (/^stop hook error:/i.test(clean)) return true
  if (/^you are consolidating high-signal long-term memory candidates/i.test(clean)) return true
  if (/^you are improving retrieval quality for a long-term memory system/i.test(clean)) return true
  if (/^analyze the conversation and output only markdown/i.test(clean)) return true
  if (/^you are analyzing (today's|a day's) conversation to generate/i.test(clean)) return true
  if (/^summarize the conversation below\.?/i.test(clean)) return true
  if (/history directory:/i.test(clean) && /data sources/i.test(clean)) return true
  if (/use read tool/i.test(clean) && /existing files/i.test(clean)) return true
  if (/return this exact shape:/i.test(clean)) return true
  if (/^claude2bot setup\b/i.test(clean) && /parse the command arguments/i.test(clean)) return true
  if (/\b(chat_id|gmail_search_messages|newer_than:\d+[dh]|query:\s*")/i.test(clean)) return true
  if (/^new session started\./i.test(clean) && /one short message only/i.test(clean)) return true
  if (/^before starting any work/i.test(clean) && /tell the user/i.test(clean)) return true
  const compact = clean.replace(/\s+/g, '')
  const hasKorean = /[\uAC00-\uD7AF]/.test(compact)
  const shortKoreanMeaningful =
    hasKorean &&
    compact.length >= 2 &&
    (
      /[?？]$/.test(clean) ||
      /일정|상태|시간|규칙|정책|언어|말투|호칭|기억|검색|중복|설정|오류|버그|왜|뭐|언제|어디|누구|무엇/.test(clean) ||
      /해봐|해줘|진행|시작|고쳐|수정|확인|돌려|ㄱㄱ|ㅇㅇ|ㄴㄴ|좋아|오케이/.test(clean) ||
      classifyCandidateConcept(clean, 'user')?.admit
    )
  const minCompactLen = hasKorean ? 4 : 8
  if (compact.length < minCompactLen && !shortKoreanMeaningful) return true
  const words = clean.split(/\s+/).filter(Boolean)
  if (words.length < 2 && compact.length < (hasKorean ? 4 : 16) && !shortKoreanMeaningful) return true
  const symbolCount = (clean.match(/[^\p{L}\p{N}\s]/gu) ?? []).length
  if (symbolCount > clean.length * 0.45) return true
  return false
}

export function looksLowSignalQuery(text) {
  const clean = cleanMemoryText(text)
  if (!clean) return true
  if (clean.includes('[Request interrupted by user]')) return true
  const compact = clean.replace(/\s+/g, '')
  if (!/[\p{L}\p{N}]/u.test(compact)) return true
  if (compact.length <= 1) return true
  return false
}

export function normalizeMemoryToken(token) {
  let normalized = String(token ?? '').trim().toLowerCase()
  if (!normalized) return ''

  if (normalized.length > 2) {
    const stripped = normalized.replace(/(은|는|이|가|을|를|랑|과|와|도|에|의)$/u, '')
    if (stripped.length > 0) normalized = stripped
  }

  if (/^[a-z][a-z0-9_-]+$/i.test(normalized)) {
    if (normalized.length > 5 && normalized.endsWith('ing')) normalized = normalized.slice(0, -3)
    else if (normalized.length > 4 && normalized.endsWith('ed')) normalized = normalized.slice(0, -2)
    else if (normalized.length > 4 && normalized.endsWith('es')) normalized = normalized.slice(0, -2)
    else if (normalized.length > 3 && normalized.endsWith('s')) normalized = normalized.slice(0, -1)
  }

  normalized = MEMORY_TOKEN_ALIASES.get(normalized) ?? normalized
  return normalized
}

export function tokenizeMemoryText(text) {
  return cleanMemoryText(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map(token => normalizeMemoryToken(token))
    .filter(token => token.length >= 2)
    .filter(token => !MEMORY_TOKEN_STOPWORDS.has(token))
    .slice(0, 24)
}

export function extractExplicitDate(text) {
  const clean = cleanMemoryText(text)
  const isoDateMatch = clean.match(/(\d{4})[-.](\d{2})[-.](\d{2})/)
  if (isoDateMatch) return `${isoDateMatch[1]}-${isoDateMatch[2]}-${isoDateMatch[3]}`
  const koreanDateMatch = clean.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/)
  if (koreanDateMatch) {
    return `${koreanDateMatch[1]}-${String(koreanDateMatch[2]).padStart(2, '0')}-${String(koreanDateMatch[3]).padStart(2, '0')}`
  }
  return null
}

export function propositionSubjectTokens(text) {
  return tokenizeMemoryText(text).filter(token => !SUBJECT_STOPWORDS.has(token))
}

export function buildFtsQuery(text) {
  const tokens = tokenizeMemoryText(text)
  if (tokens.length === 0) return ''
  const trigramTokens = [...new Set(tokens)].filter(t => t.length >= 3)
  if (trigramTokens.length === 0) return ''
  return trigramTokens.map(token => `"${token.replace(/"/g, '""')}"`).join(' OR ')
}

export function getShortTokensForLike(text) {
  const tokens = tokenizeMemoryText(text)
  return [...new Set(tokens)].filter(t => t.length === 2)
}

export function shortTokenMatchScore(content, shortTokens = []) {
  const clean = cleanMemoryText(content)
  if (!clean || shortTokens.length === 0) return 0
  const matched = shortTokens.filter(token => clean.includes(token)).length
  if (matched === 0) return 0
  return -(matched / shortTokens.length) * 1.5
}

export function buildTokenLikePatterns(text) {
  const clean = cleanMemoryText(text)
  if (!clean) return []
  const tokens = [...new Set(tokenizeMemoryText(clean))]
  if (tokens.length > 0) return tokens.map(token => `%${token}%`)
  return [`%${clean}%`]
}

export function candidateScore(text, role) {
  const clean = cleanMemoryText(text)
  if (!clean || looksLowSignal(clean)) return 0
  const concept = classifyCandidateConcept(clean, role)
  if (!concept.admit) return 0
  const compact = clean.replace(/\s+/g, '')
  const lenScore = Math.min(1, compact.length / 120)
  const wordCount = clean.split(/\s+/).filter(Boolean).length
  const lineCount = clean.split('\n').filter(Boolean).length
  const colonCount = (clean.match(/:/g) ?? []).length
  const pathCount = (String(text ?? '').match(/\/[A-Za-z0-9._-]+/g) ?? []).length
  const tagCount = (String(text ?? '').match(/<[^>]+>/g) ?? []).length
  const hasKoreanChars = /[\uAC00-\uD7AF]/.test(clean)
  if (role === 'assistant' && wordCount < (hasKoreanChars ? 4 : 8)) return 0
  const roleBoost = role === 'user' ? 0.25 : 0.08
  const conceptBoost =
    concept.category === 'user_rule' ? 0.22 :
    concept.category === 'active_task' ? 0.16 :
    concept.category === 'maintenance_task' ? 0.14 :
    concept.category === 'preference' ? 0.14 :
    concept.category === 'storage_decision' ? 0.12 :
    0
  const structureBoost = /\n/.test(clean) ? 0.04 : 0
  const overlongPenalty = compact.length > 320
    ? Math.min(0.45, ((compact.length - 320) / 1200) * 0.45)
    : 0
  const proceduralPenalty = lineCount > 8 && colonCount >= 4 ? 0.18 : 0
  const artifactPenalty = pathCount >= 3 || tagCount >= 2 ? 0.14 : 0
  const explicitRuleBoost =
    /\b(do not|don't|must not|should not|forbidden|blocked|explicit approval|explicitly requested|json|schema)\b/i.test(clean)
      || /하지 마|하면 안|금지|승인|명시|JSON|스키마/.test(clean)
      ? 0.22
      : 0
  const explicitTaskBoost =
    /\b(fix|implement|verify|review|investigate|refactor|cleanup|deduplicate|stabilize)\b/i.test(clean)
      || /수정|구현|검증|리뷰|조사|정리|중복 제거|안정화/.test(clean)
      ? 0.16
      : 0
  const metaPenalty =
    /\b(consolidation-dependent|candidate threshold|backlog control|provider\/model choice configurable|runtime bot settings|context sections|why the pipeline)\b/i.test(clean)
      || /후보 임계값|컨텍스트 섹션|파이프라인이 비어|설정이 비어|config commentary|cleanup state/.test(clean)
      ? 0.28
      : 0
  const questionPenalty =
    /\?$/.test(clean) && explicitRuleBoost === 0 && explicitTaskBoost === 0
      ? 0.08
      : 0
  return Math.max(
    0,
    Math.min(
      1,
      Number((0.22 + lenScore * 0.45 + roleBoost + structureBoost + conceptBoost + explicitRuleBoost + explicitTaskBoost - overlongPenalty - proceduralPenalty - artifactPenalty - metaPenalty - questionPenalty).toFixed(3)),
    ),
  )
}

export function splitMessageIntoCandidateUnits(text) {
  const clean = cleanMemoryText(text)
  if (!clean) return []
  const lines = clean
    .split(/\n+/)
    .map(line => line.trim())
    .filter(Boolean)

  const units = []
  for (const line of lines) {
    const chunks = line
      .split(/(?<=[.!?。！？])\s+|(?<=다\.|요\.|죠\.|니다\.)\s+/)
      .map(chunk => chunk.trim())
      .filter(Boolean)
    if (chunks.length <= 1) {
      units.push(line)
      continue
    }
    for (const chunk of chunks) {
      units.push(chunk)
    }
  }

  const deduped = []
  const seen = new Set()
  for (const unit of units) {
    const normalized = cleanMemoryText(unit).toLowerCase().replace(/\s+/g, ' ').trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    deduped.push(unit)
  }
  return deduped.length > 0 ? deduped : [clean]
}

export function insertCandidateUnits(insertStmt, episodeId, ts, dayKey, role, content) {
  const units = splitMessageIntoCandidateUnits(content)
  let inserted = 0
  for (const unit of units) {
    const concept = classifyCandidateConcept(unit, role)
    if (!concept.admit) continue
    const score = candidateScore(unit, role)
    if (score <= 0) continue
    insertStmt.run(episodeId, ts, dayKey, role, unit, score)
    inserted += 1
  }
  return inserted
}

export function generateQueryVariants(query) {
  const clean = cleanMemoryText(query)
  if (!clean) return [clean]

  const variants = [clean]
  const tokens = tokenizeMemoryText(clean)

  // 1. Token alias 적용 버전 (한→영)
  const aliasedTokens = tokens.map(t => {
    const alias = MEMORY_TOKEN_ALIASES.get(t)
    return alias && alias !== t ? alias : t
  })
  const aliased = aliasedTokens.join(' ')
  if (aliased !== tokens.join(' ')) variants.push(aliased)

  // 2. 한국어 조사 제거 + 영문 키워드 보강
  const koToEn = {
    '수정': 'fix', '상태': 'status', '구조': 'structure', '방식': 'method',
    '설정': 'config settings', '작업': 'task work', '규칙': 'rule policy',
    '목록': 'list', '관련': 'related', '현재': 'current', '진행': 'progress',
    '이관': 'migration', '정리': 'cleanup', '안정화': 'stabilize',
    '아키텍처': 'architecture', '검색': 'search retrieval', '저장': 'storage',
    '인증': 'authentication auth', '메모리': 'memory', '언어': 'language',
    '호칭': 'address name honorific', '응답': 'response', '형식': 'format style',
    '캐주얼': 'casual informal', '누적': 'accumulate',
  }
  const translated = tokens.map(t => koToEn[t] ?? t).join(' ')
  if (translated !== tokens.join(' ')) variants.push(translated)

  // 중복 제거
  return [...new Set(variants)].slice(0, 3)
}
