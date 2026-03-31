import { DatabaseSync } from 'node:sqlite'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { dirname, join, resolve } from 'path'
import { homedir } from 'os'
import { createHash } from 'crypto'
import { embedText, getEmbeddingModelId, getEmbeddingDims, warmupEmbeddingProvider, configureEmbedding, consumeProviderSwitchEvent } from './embedding-provider.mjs'
import {
  cleanMemoryText,
  composeTaskDetails,
  shouldKeepFact,
  shouldKeepSignal,
} from './memory-extraction.mjs'
import {
  buildHintKey,
  computeHintRelevance,
  formatHintTag,
  shouldInjectHint,
} from './memory-context-utils.mjs'
import {
  isProfileIntent,
  isPolicyIntent,
  getIntentTypeCaps,
  getIntentSubtypeBonus,
  shouldKeepRerankItem,
  computeSourceTrustAdjustment,
  compactRetrievalContent,
  claimSurfaceKey,
  collapseClaimSurfaceDuplicates,
} from './memory-ranking-utils.mjs'
let sqliteVec = null
try { sqliteVec = await import('sqlite-vec') } catch { /* sqlite-vec not available */ }

function vecToHex(vector) {
  const hex = Buffer.from(new Float32Array(vector).buffer).toString('hex')
  if (!/^[0-9a-f]+$/.test(hex)) throw new Error('invalid hex from vector')
  return hex
}

function parseTemporalHint(query) {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  const localDate = (value) => `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
  const today = localDate(now)
  const daysAgo = (n) => {
    const value = new Date(now)
    value.setDate(value.getDate() - n)
    return localDate(value)
  }
  const weekdayOffset = (now.getDay() + 6) % 7
  if (/yesterday/i.test(query)) return { start: daysAgo(1), end: daysAgo(1) }
  if (/two days ago|day before yesterday/i.test(query)) return { start: daysAgo(2), end: daysAgo(2) }
  if (/last\s*week/i.test(query)) return { start: daysAgo(7), end: daysAgo(1) }
  if (/this[-_\s]*week/i.test(query)) return { start: daysAgo(weekdayOffset), end: today }
  if (/today/i.test(query)) return { start: today, end: today }
  if (/recently/i.test(query)) return { start: daysAgo(3), end: today, exact: false }
  if (/어제/.test(query)) return { start: daysAgo(1), end: daysAgo(1), exact: true }
  if (/그저께|이틀 전/.test(query)) return { start: daysAgo(2), end: daysAgo(2), exact: true }
  if (/오늘/.test(query)) return { start: today, end: today, exact: true }
  if (/이번 ?주/.test(query)) return { start: daysAgo(weekdayOffset), end: today, exact: false }
  if (/지난 ?주/.test(query)) return { start: daysAgo(7), end: daysAgo(1), exact: false }
  const isoDateMatch = query.match(/(\d{4})[-.](\d{2})[-.](\d{2})/)
  if (isoDateMatch) {
    const date = `${isoDateMatch[1]}-${isoDateMatch[2]}-${isoDateMatch[3]}`
    return { start: date, end: date, exact: true }
  }
  const monthMatch = query.match(/(\d{4})[-.](\d{2})(?![-.]\d{2})/)
  if (monthMatch) {
    const year = Number(monthMatch[1])
    const month = Number(monthMatch[2])
    if (month >= 1 && month <= 12) {
      const start = `${monthMatch[1]}-${monthMatch[2]}-01`
      const nextMonth = month === 12 ? new Date(year + 1, 0, 1) : new Date(year, month, 1)
      nextMonth.setDate(nextMonth.getDate() - 1)
      return { start, end: localDate(nextMonth), exact: false }
    }
  }
  const koreanDateMatch = query.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/)
  if (koreanDateMatch) {
    const date = `${koreanDateMatch[1]}-${String(koreanDateMatch[2]).padStart(2, '0')}-${String(koreanDateMatch[3]).padStart(2, '0')}`
    return { start: date, end: date, exact: true }
  }
  const dateMatch = query.match(/(\d{1,2})\/(\d{1,2})/)
  if (dateMatch) {
    const m = String(dateMatch[1]).padStart(2, '0')
    const d = String(dateMatch[2]).padStart(2, '0')
    const date = `${kst.getFullYear()}-${m}-${d}`
    return { start: date, end: date, exact: true }
  }
  return null
}

function isDoneTaskQuery(query = '') {
  const clean = cleanMemoryText(query).toLowerCase()
  return /\b(done|completed|finished|resolved|status)\b/.test(clean) || /완료|끝났|끝난|끝난거|상태/.test(query)
}

function isRuleQuery(query = '') {
  const clean = cleanMemoryText(query).toLowerCase()
  return /\b(rule|policy|forbidden|allowed|constraint|prompt|transcript|durable memory)\b/.test(clean) || /규칙|정책|제약|금지|허용|prompt|transcript|durable memory/.test(query)
}

function isRelationQuery(query = '') {
  const clean = cleanMemoryText(query).toLowerCase()
  return /\b(relation|connect|connected|responsibility|role|uses|use|depends|dependency|where.*used|what.*used|store|persistence)\b/.test(clean)
    || /관계|연결|책임|역할|분리|용도|어디에 쓰|어디 쓰|저장|persist|의존/.test(query)
}

function isHistoryQuery(query = '') {
  const clean = cleanMemoryText(query).toLowerCase()
  return /\b(history|timeline|discuss|discussion|discussed|happened|what did we discuss|summarize the discussion)\b/.test(clean)
    || /기억|타임라인|논의|대화|얘기|뭐라고 했|요약/.test(query)
}

const stores = new Map()
const INTENT_PROTOTYPES = {
  profile: [
    'user language tone response style preference',
    'how should the assistant speak, write, and address the user',
    'preferred language, tone, and communication style',
    'preferred address style and communication rules',
    'how should the system respond to the user',
    'language and style preference rules',
    'formal respectful address style',
    'response tone and wording rules',
    'language and address behavior',
  ],
  task: [
    'current work status and active priorities',
    'what is in progress right now and what comes next',
    'ongoing execution state and next action',
    'present operational focus and pending work',
    'priority items in the current workflow',
    'near-term work status and planned next steps',
  ],
  decision: [
    'architecture decision design constraint rule limitation',
    'system design choice and implementation constraint',
    'agreed technical decision and structural direction',
    'design decision and structural rule',
    'technical direction and constraints',
    'agreed system decision',
  ],
  policy: [
    'policy rule restriction allowed forbidden operational behavior',
    'explicit constraint and operating rule',
    'workflow policy and behavioral restrictions',
    'what is allowed forbidden or required in operation',
    'system rule and user-imposed constraint',
    'operational guardrail and preference rule',
  ],
  security: [
    'secret credential sensitive value security privacy',
    'how sensitive data should be handled safely',
    'secure handling of protected values and access',
    'private information safety and credential management',
    'security restriction for confidential operational data',
    'handling of protected secrets and privileged access',
  ],
  event: [
    'past event incident timeline and what occurred',
    'time-bounded event trace from prior conversation',
    'what occurred at a specific time in history',
    'historical event reconstruction from conversation evidence',
    'trace a past occurrence using dated conversation context',
    'timeline-oriented recall of an earlier incident',
  ],
  history: [
    'recent history and discussed topics',
    'recent activity and prior conversation context',
    'what has been discussed recently',
    'near-term conversational history and recent work',
    'recent context and prior topics',
    'history of recent discussion and activity',
  ],
}
let intentPrototypeVectorsPromise = null

function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true })
}

function workspaceToProjectSlug(workspacePath) {
  return resolve(workspacePath)
    .replace(/\\/g, '/')
    .replace(/^([A-Za-z]):/, '$1-')
    .replace(/\//g, '-')
}

function firstTextContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
}

export { cleanMemoryText }

function looksLowSignal(text) {
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
  const minCompactLen = hasKorean ? 4 : 8
  if (compact.length < minCompactLen) return true
  const words = clean.split(/\s+/).filter(Boolean)
  if (words.length < 2 && compact.length < (hasKorean ? 4 : 16)) return true
  const symbolCount = (clean.match(/[^\p{L}\p{N}\s]/gu) ?? []).length
  if (symbolCount > clean.length * 0.45) return true
  return false
}

function looksLowSignalQuery(text) {
  const clean = cleanMemoryText(text)
  if (!clean) return true
  if (clean.includes('[Request interrupted by user]')) return true
  const compact = clean.replace(/\s+/g, '')
  if (!/[\p{L}\p{N}]/u.test(compact)) return true
  if (compact.length <= 1) return true
  return false
}

function normalizeMemoryToken(token) {
  let normalized = String(token ?? '').trim().toLowerCase()
  if (!normalized) return ''

  if (normalized.length > 2) {
    normalized = normalized.replace(/(은|는|이|가|을|를|랑|과|와|도|에|의)$/u, '')
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
  ['배포', 'deploy'],
  ['빌드', 'build'],
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

function tokenizeMemoryText(text) {
  return cleanMemoryText(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map(token => normalizeMemoryToken(token))
    .filter(token => token.length >= 2)
    .filter(token => !MEMORY_TOKEN_STOPWORDS.has(token))
    .slice(0, 24)
}

function extractExplicitDate(text) {
  const clean = cleanMemoryText(text)
  const isoDateMatch = clean.match(/(\d{4})[-.](\d{2})[-.](\d{2})/)
  if (isoDateMatch) return `${isoDateMatch[1]}-${isoDateMatch[2]}-${isoDateMatch[3]}`
  const koreanDateMatch = clean.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/)
  if (koreanDateMatch) {
    return `${koreanDateMatch[1]}-${String(koreanDateMatch[2]).padStart(2, '0')}-${String(koreanDateMatch[3]).padStart(2, '0')}`
  }
  return null
}

function propositionSubjectTokens(text) {
  return tokenizeMemoryText(text).filter(token => !SUBJECT_STOPWORDS.has(token))
}

function buildFtsQuery(text) {
  const tokens = tokenizeMemoryText(text)
  if (tokens.length === 0) return ''
  // trigram requires ≥3 chars; keep only tokens with 3+ chars for FTS
  const trigramTokens = [...new Set(tokens)].filter(t => t.length >= 3)
  if (trigramTokens.length === 0) return ''
  return trigramTokens.map(token => `"${token.replace(/"/g, '""')}"`).join(' OR ')
}

function getShortTokensForLike(text) {
  const tokens = tokenizeMemoryText(text)
  // return 2-char tokens that trigram can't handle
  return [...new Set(tokens)].filter(t => t.length === 2)
}

function candidateScore(text, role) {
  const clean = cleanMemoryText(text)
  if (!clean || looksLowSignal(clean)) return 0
  const compact = clean.replace(/\s+/g, '')
  const lenScore = Math.min(1, compact.length / 120)
  const wordCount = clean.split(/\s+/).filter(Boolean).length
  const lineCount = clean.split('\n').filter(Boolean).length
  const colonCount = (clean.match(/:/g) ?? []).length
  const pathCount = (String(text ?? '').match(/\/[A-Za-z0-9._-]+/g) ?? []).length
  const tagCount = (String(text ?? '').match(/<[^>]+>/g) ?? []).length
  if (role === 'assistant' && wordCount < 8) return 0
  const roleBoost = role === 'user' ? 0.25 : 0.08
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
      Number((0.22 + lenScore * 0.45 + roleBoost + structureBoost + explicitRuleBoost + explicitTaskBoost - overlongPenalty - proceduralPenalty - artifactPenalty - metaPenalty - questionPenalty).toFixed(3)),
    ),
  )
}

function decayConfidence(confidence, lastSeen) {
  const base = Number(confidence ?? 0.5)
  if (!lastSeen) return base
  const ageDays = Math.max(0, (Date.now() - new Date(lastSeen).getTime()) / (1000 * 60 * 60 * 24))
  const penalty = Math.min(0.25, ageDays / 180 * 0.25)
  return Math.max(0.15, Number((base - penalty).toFixed(3)))
}

function staleCutoffDays(kind) {
  switch (kind) {
    case 'decision': return 180
    case 'preference': return 120
    case 'constraint': return 180
    case 'fact': return 90
    default: return 120
  }
}

function decaySignalScore(score, lastSeen, kind = '') {
  const base = Number(score ?? 0.5)
  if (!lastSeen) return base
  const ageDays = Math.max(0, (Date.now() - new Date(lastSeen).getTime()) / (1000 * 60 * 60 * 24))
  const cutoff =
    kind === 'language' || kind === 'tone' ? 180 :
    kind === 'cadence' ? 120 :
    90
  const penalty = Math.min(0.45, ageDays / cutoff * 0.25)
  return Math.max(0.15, Number((base - penalty).toFixed(3)))
}

function normalizeTaskStatus(status, details = '') {
  const raw = String(status ?? '').trim().toLowerCase()
  if (raw === 'done' || raw === 'completed' || raw === 'cancelled' || raw === 'paused' || raw === 'in_progress' || raw === 'active') {
    if (raw === 'active' && /\b(done|completed|resolved|finished|merged|shipped)\b/.test(String(details).toLowerCase())) {
      return 'done'
    }
    return raw === 'completed' ? 'done' : raw
  }
  const combined = `${raw} ${String(details).toLowerCase()}`
  if (/\b(done|completed|resolved|finished|merged|shipped)\b/.test(combined)) return 'done'
  if (/\b(cancelled|canceled|dropped|abandoned)\b/.test(combined)) return 'cancelled'
  if (/\b(paused|blocked|waiting|hold)\b/.test(combined)) return 'paused'
  if (/\b(in progress|progress|ongoing)\b/.test(combined)) return 'in_progress'
  return 'active'
}

function normalizeFactSlot(slot) {
  const value = String(slot ?? '').trim()
  return value ? value : ''
}

function propositionKindForFact(factType, slot = '') {
  const normalizedSlot = normalizeFactSlot(slot)
  if (normalizedSlot) return normalizedSlot
  return normalizeFactType(factType) || 'fact'
}

function normalizeWorkstream(value) {
  const clean = String(value ?? '').trim().toLowerCase()
  if (!clean) return ''
  return clean
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
}

function canonicalKeyTokens(text, maxTokens = 8) {
  return tokenizeMemoryText(text)
    .filter(token => token.length >= 2)
    .slice(0, Math.max(1, Number(maxTokens ?? 8)))
}

function deriveClaimKey(factType, slot = '', text = '', workstream = '') {
  const normalizedType = normalizeFactType(factType)
  const normalizedSlot = normalizeFactSlot(slot)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  const normalizedWorkstream = normalizeWorkstream(workstream)
  const normalizedText = cleanMemoryText(text).toLowerCase()
  const canonicalValue = canonicalKeyTokens(normalizedText).join('-')
    || createHash('sha1').update(normalizedText).digest('hex').slice(0, 16)
  return [normalizedType, normalizedWorkstream, normalizedSlot || canonicalValue].filter(Boolean).join(':').slice(0, 160)
}

function deriveTaskKey(title = '', workstream = '') {
  const normalizedWorkstream = normalizeWorkstream(workstream)
  const normalizedTitle = cleanMemoryText(title).toLowerCase()
  const canonicalTitle = canonicalKeyTokens(normalizedTitle).join('-')
    || createHash('sha1').update(normalizedTitle).digest('hex').slice(0, 16)
  return [normalizedWorkstream || 'task', canonicalTitle].join(':').slice(0, 160)
}

function normalizeFactType(factType) {
  const value = String(factType ?? '').trim().toLowerCase()
  return ['preference', 'constraint', 'decision', 'fact'].includes(value) ? value : 'fact'
}

function normalizeSignalKind(kind) {
  const value = String(kind ?? '').trim().toLowerCase()
  return ['language', 'tone', 'time_pref', 'interest', 'cadence'].includes(value) ? value : 'interest'
}

function normalizeTaskPriority(priority) {
  const value = String(priority ?? 'normal').trim().toLowerCase()
  return ['low', 'normal', 'high'].includes(value) ? value : 'normal'
}

function normalizeTaskStage(stage, details = '') {
  const raw = String(stage ?? '').trim().toLowerCase()
  if (['planned', 'investigating', 'implementing', 'wired', 'verified', 'done'].includes(raw)) {
    return raw
  }
  const combined = `${raw} ${String(details).toLowerCase()}`
  if (/\b(verified|tested|confirmed|working)\b/.test(combined)) return 'verified'
  if (/\b(wired|hooked|connected|registered|integrated)\b/.test(combined)) return 'wired'
  if (/\b(implementing|coding|building|refactoring|fixing)\b/.test(combined)) return 'implementing'
  if (/\b(investigating|researching|checking|exploring|surveying)\b/.test(combined)) return 'investigating'
  if (/\b(done|completed|resolved|finished|merged|shipped)\b/.test(combined)) return 'done'
  return 'planned'
}

function normalizeEvidenceLevel(value, details = '') {
  const raw = String(value ?? '').trim().toLowerCase()
  if (['claimed', 'implemented', 'verified'].includes(raw)) return raw
  const combined = `${raw} ${String(details).toLowerCase()}`
  if (/\b(verified|tested|confirmed|working)\b/.test(combined)) return 'verified'
  if (/\b(implemented|added|wired|registered|integrated|exists in code)\b/.test(combined)) return 'implemented'
  return 'claimed'
}

function taskStageRank(stage) {
  switch (String(stage ?? '').trim().toLowerCase()) {
    case 'planned': return 1
    case 'investigating': return 2
    case 'implementing': return 3
    case 'wired': return 4
    case 'verified': return 5
    case 'done': return 6
    default: return 0
  }
}

function taskEvidenceRank(level) {
  switch (String(level ?? '').trim().toLowerCase()) {
    case 'claimed': return 1
    case 'implemented': return 2
    case 'verified': return 3
    default: return 0
  }
}

function normalizeProfileKey(key) {
  const value = String(key ?? '').trim().toLowerCase()
  return ['language', 'tone', 'address', 'response_style', 'timezone'].includes(value) ? value : ''
}

function shouldKeepProfileValue(key, value) {
  const clean = cleanMemoryText(value)
  if (!key || !clean) return false
  if (key === 'timezone') return clean.length <= 64
  if (clean.length > 160) return false
  if (clean.length > 48 && /\b(?:on|as of)\s+\d{4}-\d{2}-\d{2}\b/i.test(clean)) return false
  if (clean.length > 48 && /\b(requested|asked|stated|reported|mentioned|clarified)\b/i.test(clean)) return false
  if (clean.length > 48 && /(요청|지시|말씀|언급|보고|설명)/.test(clean)) return false
  return true
}

function profileKeyForFact(factType, text = '', slot = '') {
  const combined = `${slot} ${text}`.toLowerCase()
  if (factType === 'preference' && (/\b(address|call|name|nickname)\b/.test(combined) || /호칭|이름|닉네임/.test(combined))) return 'address'
  if (factType === 'preference' && (/\b(response style|response-style|style|tone)\b/.test(combined) || /말투|어투|응답 스타일|답변 스타일/.test(combined))) return 'response_style'
  if (factType === 'constraint' && (/\btimezone|time zone|local time\b/.test(combined) || /시간대|현지 시간/.test(combined))) return 'timezone'
  return ''
}

function profileKeyForSignal(kind, value = '') {
  const combined = `${kind} ${value}`.toLowerCase()
  if (kind === 'language' || /\bkorean|english|japanese|chinese|language\b/.test(combined) || /한국어|영어|일본어|중국어|언어/.test(combined)) return 'language'
  if (kind === 'tone' || /\btone|style|formal|respectful|casual\b/.test(combined) || /존댓말|반말|격식|말투|어투/.test(combined)) return 'tone'
  return ''
}

function applyLexicalIntentHints(clean, scores) {
  const lowered = clean.toLowerCase()
  const add = (intent, value) => {
    scores[intent] = Number((scores[intent] + value).toFixed(4))
  }

  if (/\b(language|tone|style|address|honorific|timezone)\b/.test(lowered) || /한국어|영어|존댓말|반말|말투|어투|호칭|시간대/.test(clean)) {
    add('profile', /\btimezone\b/.test(lowered) || /시간대/.test(clean) ? 0.62 : 0.45)
    scores.event = Math.max(0, scores.event - 0.22)
    scores.history = Math.max(0, scores.history - 0.12)
    scores.task = Math.max(0, scores.task - 0.22)
  }
  if (/\b(profile|identity|source of truth|name|address)\b/.test(lowered) || /프로필|정체성|source of truth|호칭|이름/.test(clean)) {
    add('profile', 0.22)
    add('decision', 0.08)
  }
  if (/\bsource of truth\b/.test(lowered) || /source of truth/.test(clean)) {
    add('decision', 0.26)
  }
  if (/\b(remove|removed|delete|drop|separate)\b/.test(lowered) && /\b(identity|profile|storage|persistence)\b/.test(lowered)) {
    add('decision', 0.28)
  }
  if (/\b(task|tasks|work|working|todo|next step|in progress|current work)\b/.test(lowered) || /작업|진행|진행중|할 일|할일|다음/.test(clean)) {
    add('task', 0.32)
  }
  if (/\b(backlog|remaining work|remaining tasks|still ongoing)\b/.test(lowered) || /백로그|남은 작업|남은 거/.test(clean)) {
    add('task', 0.24)
  }
  if (isDoneTaskQuery(clean)) {
    add('task', 0.18)
  }
  if (/\b(rule|policy|forbidden|allowed|commit|push|deploy|build|restriction|approval)\b/.test(lowered) || /규칙|정책|금지|허용|커밋|푸시|배포|빌드|승인|제한/.test(clean)) {
    add('policy', 0.3)
    scores.task = Math.max(0, scores.task - 0.08)
  }
  if (/\b(deployment|opt-in only)\b/.test(lowered) || /opt-in/.test(clean)) {
    add('policy', 0.34)
    scores.task = Math.max(0, scores.task - 0.16)
  }
  if (isRuleQuery(clean)) {
    add('policy', 0.34)
    scores.history = Math.max(0, scores.history - 0.06)
    scores.event = Math.max(0, scores.event - 0.06)
  }
  if (isRelationQuery(clean) || /\b(project|service|tool|system|relation|integrates|uses|depends)\b/.test(lowered) || /관계|역할 분리|프로젝트|서비스|도구|시스템|어디에 쓰여|어디 쓰여/.test(clean)) {
    add('decision', 0.32)
    scores.security = Math.max(0, scores.security - 0.08)
    scores.profile = Math.max(0, scores.profile - 0.12)
  }
  if (/\b(related|pairing|connect|connected|integration point)\b/.test(lowered) || /연결|관계|integration point/.test(clean)) {
    add('decision', 0.34)
    scores.profile = Math.max(0, scores.profile - 0.14)
    scores.task = Math.max(0, scores.task - 0.12)
  }
  if (/\b(transcript|prompt|durable memory|memory recall)\b/.test(lowered) || /transcript|prompt|durable memory|memory recall|리콜/.test(clean)) {
    add('policy', 0.18)
    add('decision', 0.12)
  }
  if (/\b(decision|architecture|design|structure|direction|weakness|problem)\b/.test(lowered) || /결정|아키텍처|구조|설계|방향|약점|문제/.test(clean)) {
    add('decision', 0.22)
  }
  if (/\b(memory retrieval|retrieval)\b/.test(lowered) || /리트리벌|리콜/.test(clean)) {
    add('decision', 0.14)
  }
  if (isHistoryQuery(clean) || /\b(today|yesterday|when|timeline|history|discussed|happened)\b/.test(lowered) || /오늘|어제|언제|타임라인|기억|얘기|무슨|논의|했지/.test(clean)) {
    add('history', 0.24)
  }
  if (/\b(summarize the discussion|discussion on|what happened on)\b/.test(lowered)) {
    add('history', 0.18)
    scores.event = Math.max(0, scores.event - 0.04)
  }
  if (/\b(summarize|summary)\b/.test(lowered) || /요약/.test(clean)) {
    add('history', 0.18)
  }
  if (/\b(event|incident|meeting|discussion)\b/.test(lowered) || /이벤트|사건|회의|대화|논의/.test(clean)) {
    add('event', 0.22)
  }
  if (/\b(identity|secret|credential|api key|sensitive)\b/.test(lowered)) {
    scores.security = Math.max(0, scores.security - 0.08)
  }
  if (/\b(who does|who handles|external search|internal recall)\b/.test(lowered) || /누가 하고|누가 해|외부 검색|내부 리콜/.test(clean)) {
    add('decision', 0.24)
    scores.security = Math.max(0, scores.security - 0.08)
  }
}

function tokenizedWorkstream(value) {
  return normalizeWorkstream(value).split('-').filter(Boolean)
}


function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (!na || !nb) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function averageVectors(vectors = []) {
  const rows = vectors.filter(vector => Array.isArray(vector) && vector.length > 0)
  if (rows.length === 0) return []
  const dims = rows[0].length
  const out = new Array(dims).fill(0)
  for (const vector of rows) {
    if (vector.length !== dims) continue
    for (let i = 0; i < dims; i += 1) out[i] += vector[i]
  }
  for (let i = 0; i < dims; i += 1) out[i] /= rows.length
  return out
}

function embeddingItemKey(entityType, entityId) {
  return `${entityType}:${entityId}`
}

function hashEmbeddingInput(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

async function getIntentPrototypeVectors() {
  if (!intentPrototypeVectorsPromise) {
    intentPrototypeVectorsPromise = (async () => {
      const entries = []
      for (const [intent, phrases] of Object.entries(INTENT_PROTOTYPES)) {
        const vectors = await Promise.all(phrases.map(phrase => embedText(phrase)))
        entries.push([intent, vectors.filter(vector => Array.isArray(vector) && vector.length > 0)])
      }
      return new Map(entries)
    })()
  }
  return intentPrototypeVectorsPromise
}

function contextualizeEmbeddingInput(item) {
  const entityType = String(item.entityType ?? '')
  const content = cleanMemoryText(item.content ?? '')
  if (!content) return ''

  if (entityType === 'fact') {
    const label = String(item.subtype ?? 'fact')
    const slot = item.slot ? ` slot=${item.slot}` : ''
    const workstream = item.workstream ? ` workstream=${item.workstream}` : ''
    return cleanMemoryText(`memory fact type=${label}${slot}${workstream}\n${content}`)
  }

  if (entityType === 'task') {
    const status = item.status ? ` status=${item.status}` : ''
    const priority = item.priority ? ` priority=${item.priority}` : ''
    const workstream = item.workstream ? ` workstream=${item.workstream}` : ''
    return cleanMemoryText(`memory task${status}${priority}${workstream}\n${content}`)
  }

  if (entityType === 'signal') {
    const kind = item.subtype ? ` kind=${item.subtype}` : ''
    return cleanMemoryText(`memory signal${kind}\n${content}`)
  }

  return content
}

export class MemoryStore {
  constructor(dataDir) {
    this.dataDir = dataDir
    this.historyDir = join(dataDir, 'history')
    this.dbPath = join(dataDir, 'memory.sqlite')
    ensureDir(dirname(this.dbPath))
    this.db = new DatabaseSync(this.dbPath, { allowExtension: true })
    this.vecEnabled = false
    this._loadVecExtension()
    this.init()
    this.backfillCanonicalKeys()
    this.rebuildDerivedIndexes()
    this.syncEmbeddingMetadata()
  }

  _loadVecExtension() {
    if (!sqliteVec) return
    try {
      sqliteVec.load(this.db)
      this.vecEnabled = true
      let dims = getEmbeddingDims()
      try {
        const forcedDims = Number(process.env.CLAUDE2BOT_FORCE_VEC_DIMS ?? '0')
        if (forcedDims > 0) {
          dims = forcedDims
        } else {
          const hasMeta = this.db.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='memory_meta'`).get()?.ok
          if (hasMeta) {
            const storedDims = Number(this.db.prepare(`SELECT value FROM memory_meta WHERE key = 'embedding.vector_dims'`).get()?.value ?? '0')
            if (storedDims > 0) dims = storedDims
          }
        }
      } catch { /* ignore metadata lookup */ }
      // Check if vec_memory exists with different dimensions
      try {
        const existing = this.db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='vec_memory'`).get()
        if (existing?.sql && !existing.sql.includes(`float[${dims}]`)) {
          this.db.exec('DROP TABLE vec_memory')
          process.stderr.write(`[memory] vec_memory dimension changed, recreating with float[${dims}]\n`)
        }
      } catch {}
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory USING vec0(embedding float[${dims}])`)
    } catch (e) {
      process.stderr.write(`[memory] sqlite-vec load failed: ${e.message}\n`)
    }
  }

  async switchEmbeddingModel(config = {}) {
    const oldModel = getEmbeddingModelId()
    configureEmbedding(config)
    await warmupEmbeddingProvider()
    const newModel = getEmbeddingModelId()
    if (oldModel === newModel) return { changed: false }

    process.stderr.write(`[memory] switching embedding model: ${oldModel} → ${newModel}\n`)
    const reset = this.resetDerivedMemoryForEmbeddingChange({ newModel })
    process.stderr.write(
      `[memory] embedding model changed; cleared derived memory and rebuilt ${reset.rebuiltCandidates} candidates for ${newModel}\n`,
    )
    return { changed: true, oldModel, newModel, reset }
  }

  resetDerivedMemoryForEmbeddingChange(options = {}) {
    const preservedEpisodes = Number(this.countEpisodes() ?? 0)
    this.db.exec(`
      DELETE FROM memory_candidates;
      DELETE FROM facts;
      DELETE FROM task_events;
      DELETE FROM tasks;
      DELETE FROM signals;
      DELETE FROM profiles;
      DELETE FROM interests;
      DELETE FROM propositions;
      DELETE FROM relations;
      DELETE FROM entity_links;
      DELETE FROM entities;
      DELETE FROM documents;
      DELETE FROM facts_fts;
      DELETE FROM tasks_fts;
      DELETE FROM signals_fts;
      DELETE FROM propositions_fts;
      DELETE FROM memory_vectors;
      DELETE FROM pending_embeds;
      DELETE FROM memory_meta;
    `)

    if (this.vecEnabled) {
      try {
        this.db.exec('DROP TABLE IF EXISTS vec_memory')
        const dims = getEmbeddingDims()
        this.db.exec(`CREATE VIRTUAL TABLE vec_memory USING vec0(embedding float[${dims}])`)
      } catch {}
    }

    this.clearHistoryOutputs()
    const rebuiltCandidates = this.rebuildCandidates()
    this.writeContextFile()
    this.syncEmbeddingMetadata({ reason: 'switch_embedding_model' })

    return {
      preservedEpisodes,
      rebuiltCandidates,
      historyCleared: true,
      targetModel: options.newModel ?? getEmbeddingModelId(),
    }
  }

  clearHistoryOutputs() {
    ensureDir(this.historyDir)
    const directFiles = ['context.md', 'identity.md', 'ongoing.md', 'lifetime.md', 'interests.json']
    for (const name of directFiles) {
      try { rmSync(join(this.historyDir, name), { force: true }) } catch {}
    }
    for (const dir of ['daily', 'weekly', 'monthly', 'yearly']) {
      try { rmSync(join(this.historyDir, dir), { recursive: true, force: true }) } catch {}
    }
  }

  init() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA temp_store = MEMORY;
    `)

    // Migrate FTS tables from unicode61 to trigram for Korean support
    const ftsToMigrate = ['episodes_fts', 'facts_fts', 'tasks_fts', 'signals_fts']
    for (const table of ftsToMigrate) {
      try {
        const info = this.db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(table)
        if (info?.sql && !info.sql.includes('trigram')) {
          this.db.exec(`DROP TABLE IF EXISTS ${table}`)
        }
      } catch { /* table may not exist yet */ }
    }

    this.db.exec(`

      CREATE TABLE IF NOT EXISTS episodes (
        id INTEGER PRIMARY KEY,
        ts TEXT NOT NULL,
        day_key TEXT NOT NULL,
        backend TEXT NOT NULL DEFAULT 'claude2bot',
        channel_id TEXT,
        user_id TEXT,
        user_name TEXT,
        session_id TEXT,
        role TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        source_ref TEXT UNIQUE,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      DROP INDEX IF EXISTS idx_episodes_source_ref;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_episodes_source_ref ON episodes(source_ref);
      CREATE INDEX IF NOT EXISTS idx_episodes_day ON episodes(day_key, ts);
      CREATE INDEX IF NOT EXISTS idx_episodes_role ON episodes(role, ts);

      CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts
        USING fts5(content, tokenize='trigram');

      CREATE TABLE IF NOT EXISTS memory_candidates (
        id INTEGER PRIMARY KEY,
        episode_id INTEGER NOT NULL,
        ts TEXT NOT NULL,
        day_key TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        score REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY(episode_id) REFERENCES episodes(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_candidates_day ON memory_candidates(day_key, status, score DESC);

      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        doc_key TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(kind, doc_key)
      );

      CREATE TABLE IF NOT EXISTS profiles (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        first_seen TEXT,
        last_seen TEXT,
        source_episode_id INTEGER,
        retrieval_count INTEGER NOT NULL DEFAULT 0,
        last_retrieved_at TEXT,
        FOREIGN KEY(source_episode_id) REFERENCES episodes(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY,
        fact_type TEXT NOT NULL,
        slot TEXT,
        claim_key TEXT,
        workstream TEXT,
        text TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        first_seen TEXT,
        last_seen TEXT,
        source_episode_id INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        mention_count INTEGER NOT NULL DEFAULT 1,
        UNIQUE(fact_type, text),
        FOREIGN KEY(source_episode_id) REFERENCES episodes(id) ON DELETE SET NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts
        USING fts5(text, tokenize='trigram');

      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL UNIQUE,
        task_key TEXT,
        details TEXT,
        workstream TEXT,
        stage TEXT NOT NULL DEFAULT 'planned',
        evidence_level TEXT NOT NULL DEFAULT 'claimed',
        status TEXT NOT NULL DEFAULT 'active',
        priority TEXT NOT NULL DEFAULT 'normal',
        confidence REAL NOT NULL DEFAULT 0.5,
        first_seen TEXT,
        last_seen TEXT,
        source_episode_id INTEGER,
        FOREIGN KEY(source_episode_id) REFERENCES episodes(id) ON DELETE SET NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts
        USING fts5(title, details, tokenize='trigram');

      CREATE TABLE IF NOT EXISTS task_events (
        id INTEGER PRIMARY KEY,
        task_id INTEGER NOT NULL,
        ts TEXT NOT NULL,
        event_kind TEXT NOT NULL,
        stage TEXT,
        evidence_level TEXT,
        status TEXT,
        note TEXT,
        source_episode_id INTEGER,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY(source_episode_id) REFERENCES episodes(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS interests (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        score REAL NOT NULL DEFAULT 0,
        count INTEGER NOT NULL DEFAULT 0,
        last_seen TEXT
      );

      CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        score REAL NOT NULL DEFAULT 0,
        first_seen TEXT,
        last_seen TEXT,
        source_episode_id INTEGER,
        UNIQUE(kind, value),
        FOREIGN KEY(source_episode_id) REFERENCES episodes(id) ON DELETE SET NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS signals_fts
        USING fts5(kind, value, tokenize='trigram');

      CREATE TABLE IF NOT EXISTS memory_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS entities (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        entity_type TEXT NOT NULL DEFAULT 'thing',
        description TEXT,
        first_seen TEXT,
        last_seen TEXT,
        source_episode_id INTEGER,
        UNIQUE(name, entity_type)
      );

      CREATE TABLE IF NOT EXISTS relations (
        id INTEGER PRIMARY KEY,
        source_entity_id INTEGER NOT NULL REFERENCES entities(id),
        target_entity_id INTEGER NOT NULL REFERENCES entities(id),
        relation_type TEXT NOT NULL,
        description TEXT,
        confidence REAL DEFAULT 0.7,
        first_seen TEXT,
        last_seen TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        source_episode_id INTEGER,
        UNIQUE(source_entity_id, target_entity_id, relation_type)
      );

      CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_entity_id);
      CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_entity_id);

      CREATE TABLE IF NOT EXISTS entity_links (
        id INTEGER PRIMARY KEY,
        entity_id INTEGER NOT NULL REFERENCES entities(id),
        linked_type TEXT NOT NULL,
        linked_id INTEGER NOT NULL,
        source_episode_id INTEGER,
        strength REAL NOT NULL DEFAULT 1,
        UNIQUE(entity_id, linked_type, linked_id),
        FOREIGN KEY(source_episode_id) REFERENCES episodes(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_entity_links_entity ON entity_links(entity_id, linked_type);
      CREATE INDEX IF NOT EXISTS idx_entity_links_linked ON entity_links(linked_type, linked_id);

      CREATE TABLE IF NOT EXISTS propositions (
        id INTEGER PRIMARY KEY,
        subject_key TEXT NOT NULL,
        proposition_kind TEXT NOT NULL,
        text TEXT NOT NULL,
        occurred_on TEXT,
        confidence REAL NOT NULL DEFAULT 0.5,
        first_seen TEXT,
        last_seen TEXT,
        source_episode_id INTEGER,
        source_fact_id INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        mention_count INTEGER NOT NULL DEFAULT 1,
        retrieval_count INTEGER NOT NULL DEFAULT 0,
        last_retrieved_at TEXT,
        superseded_by INTEGER REFERENCES propositions(id),
        UNIQUE(subject_key, proposition_kind, text),
        FOREIGN KEY(source_episode_id) REFERENCES episodes(id) ON DELETE SET NULL,
        FOREIGN KEY(source_fact_id) REFERENCES facts(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_propositions_subject ON propositions(subject_key, proposition_kind, status);
      CREATE INDEX IF NOT EXISTS idx_propositions_fact ON propositions(source_fact_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS propositions_fts
        USING fts5(text, tokenize='trigram');

      CREATE TABLE IF NOT EXISTS pending_embeds (
        id INTEGER PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(entity_type, entity_id)
      );

      CREATE TABLE IF NOT EXISTS memory_vectors (
        entity_type TEXT NOT NULL,
        entity_id INTEGER NOT NULL,
        model TEXT NOT NULL,
        dims INTEGER NOT NULL,
        vector_json TEXT NOT NULL,
        content_hash TEXT,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY(entity_type, entity_id, model)
      );
    `)

    try {
      this.db.exec(`ALTER TABLE facts ADD COLUMN slot TEXT;`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE facts ADD COLUMN claim_key TEXT;`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE facts ADD COLUMN workstream TEXT;`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE facts ADD COLUMN retrieval_count INTEGER NOT NULL DEFAULT 0;`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE facts ADD COLUMN last_retrieved_at TEXT;`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE facts ADD COLUMN superseded_by INTEGER REFERENCES facts(id);`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN retrieval_count INTEGER NOT NULL DEFAULT 0;`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN task_key TEXT;`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN last_retrieved_at TEXT;`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN workstream TEXT;`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN stage TEXT NOT NULL DEFAULT 'planned';`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN evidence_level TEXT NOT NULL DEFAULT 'claimed';`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE signals ADD COLUMN retrieval_count INTEGER NOT NULL DEFAULT 0;`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE signals ADD COLUMN last_retrieved_at TEXT;`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE memory_vectors ADD COLUMN content_hash TEXT;`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE profiles ADD COLUMN status TEXT NOT NULL DEFAULT 'active';`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE profiles ADD COLUMN mention_count INTEGER NOT NULL DEFAULT 1;`)
    } catch { /* already present */ }
    try {
      this.db.exec(`ALTER TABLE signals ADD COLUMN status TEXT NOT NULL DEFAULT 'active';`)
    } catch { /* already present */ }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_slot ON facts(slot);`)
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_claim_key ON facts(claim_key);`)
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_task_key ON tasks(task_key);`)

    this.insertEpisodeStmt = this.db.prepare(`
      INSERT OR IGNORE INTO episodes (
        ts, day_key, backend, channel_id, user_id, user_name, session_id,
        role, kind, content, source_ref
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.insertEpisodeFtsStmt = this.db.prepare(`
      INSERT INTO episodes_fts(rowid, content) VALUES (?, ?)
    `)
    this.getEpisodeBySourceStmt = this.db.prepare(`
      SELECT id FROM episodes WHERE source_ref = ?
    `)
    this.insertCandidateStmt = this.db.prepare(`
      INSERT INTO memory_candidates (episode_id, ts, day_key, role, content, score)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    this.clearCandidatesStmt = this.db.prepare(`DELETE FROM memory_candidates`)
    this.clearFactsStmt = this.db.prepare(`DELETE FROM facts`)
    this.clearTasksStmt = this.db.prepare(`DELETE FROM tasks`)
    this.clearSignalsStmt = this.db.prepare(`DELETE FROM signals`)
    this.clearPropositionsStmt = this.db.prepare(`DELETE FROM propositions`)
    this.clearEntityLinksStmt = this.db.prepare(`DELETE FROM entity_links`)
    this.clearFactsFtsStmt = this.db.prepare(`DELETE FROM facts_fts`)
    this.clearTasksFtsStmt = this.db.prepare(`DELETE FROM tasks_fts`)
    this.clearSignalsFtsStmt = this.db.prepare(`DELETE FROM signals_fts`)
    this.clearPropositionsFtsStmt = this.db.prepare(`DELETE FROM propositions_fts`)
    this.clearVectorsStmt = this.db.prepare(`DELETE FROM memory_vectors`)
    this.getMetaStmt = this.db.prepare(`SELECT value FROM memory_meta WHERE key = ?`)
    this.upsertMetaStmt = this.db.prepare(`
      INSERT INTO memory_meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `)
    this.hasVectorModelStmt = this.db.prepare(`
      SELECT 1 AS ok
      FROM memory_vectors
      WHERE model = ?
      LIMIT 1
    `)
    this.upsertDocumentStmt = this.db.prepare(`
      INSERT INTO documents (kind, doc_key, content, updated_at)
      VALUES (?, ?, ?, unixepoch())
      ON CONFLICT(kind, doc_key) DO UPDATE SET
        content = excluded.content,
        updated_at = unixepoch()
    `)
    this.upsertProfileStmt = this.db.prepare(`
      INSERT INTO profiles (key, value, confidence, first_seen, last_seen, source_episode_id, mention_count)
      VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(key) DO UPDATE SET
        mention_count = profiles.mention_count + 1,
        value = CASE WHEN profiles.mention_count + 1 >= 3 THEN excluded.value ELSE profiles.value END,
        confidence = CASE WHEN profiles.mention_count + 1 >= 3 THEN MAX(profiles.confidence, excluded.confidence) ELSE profiles.confidence END,
        last_seen = excluded.last_seen,
        source_episode_id = COALESCE(excluded.source_episode_id, profiles.source_episode_id)
    `)
    this.bumpProfileRetrievalStmt = this.db.prepare(`
      UPDATE profiles
      SET retrieval_count = retrieval_count + 1,
          last_retrieved_at = ?
      WHERE key = ?
    `)
    this.upsertFactStmt = this.db.prepare(`
      INSERT INTO facts (fact_type, slot, claim_key, workstream, text, confidence, first_seen, last_seen, source_episode_id, status, mention_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1)
      ON CONFLICT(fact_type, text) DO UPDATE SET
        slot = COALESCE(excluded.slot, facts.slot),
        claim_key = COALESCE(excluded.claim_key, facts.claim_key),
        workstream = COALESCE(excluded.workstream, facts.workstream),
        confidence = MAX(facts.confidence, excluded.confidence),
        last_seen = excluded.last_seen,
        source_episode_id = COALESCE(excluded.source_episode_id, facts.source_episode_id),
        status = 'active',
        mention_count = facts.mention_count + 1
    `)
    this.getFactRowByClaimKeyStmt = this.db.prepare(`
      SELECT id, fact_type, slot, claim_key, workstream, text, confidence
      FROM facts
      WHERE fact_type = ? AND claim_key = ? AND status = 'active'
      ORDER BY confidence DESC, mention_count DESC, last_seen DESC
      LIMIT 1
    `)
    this.updateFactByIdStmt = this.db.prepare(`
      UPDATE facts
      SET slot = ?, claim_key = ?, workstream = ?, text = ?, confidence = ?, last_seen = ?,
          source_episode_id = COALESCE(?, source_episode_id), status = 'active',
          mention_count = mention_count + 1
      WHERE id = ?
    `)
    this.bumpFactSeenStmt = this.db.prepare(`
      UPDATE facts
      SET last_seen = ?, mention_count = mention_count + 1
      WHERE id = ?
    `)
    this.staleFactSlotStmt = this.db.prepare(`
      UPDATE facts
      SET status = 'stale'
      WHERE slot = ?
        AND text != ?
        AND status = 'active'
    `)
    this.getFactIdStmt = this.db.prepare(`
      SELECT id FROM facts WHERE fact_type = ? AND text = ?
    `)
    this.deleteFactFtsStmt = this.db.prepare(`DELETE FROM facts_fts WHERE rowid = ?`)
    this.insertFactFtsStmt = this.db.prepare(`INSERT INTO facts_fts(rowid, text) VALUES (?, ?)`)
    this.upsertTaskStmt = this.db.prepare(`
      INSERT INTO tasks (title, task_key, details, workstream, stage, evidence_level, status, priority, confidence, first_seen, last_seen, source_episode_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(title) DO UPDATE SET
        task_key = COALESCE(excluded.task_key, tasks.task_key),
        details = excluded.details,
        workstream = COALESCE(excluded.workstream, tasks.workstream),
        stage = excluded.stage,
        evidence_level = excluded.evidence_level,
        status = excluded.status,
        priority = excluded.priority,
        confidence = MAX(tasks.confidence, excluded.confidence),
        last_seen = excluded.last_seen,
        source_episode_id = COALESCE(excluded.source_episode_id, tasks.source_episode_id)
    `)
    this.getTaskRowByKeyStmt = this.db.prepare(`
      SELECT id, title, status, stage, evidence_level
      FROM tasks
      WHERE task_key = ?
      ORDER BY confidence DESC, last_seen DESC
      LIMIT 1
    `)
    this.updateTaskByIdStmt = this.db.prepare(`
      UPDATE tasks
      SET title = ?, task_key = ?, details = ?, workstream = ?, stage = ?, evidence_level = ?,
          status = ?, priority = ?, confidence = MAX(confidence, ?), last_seen = ?,
          source_episode_id = COALESCE(?, source_episode_id)
      WHERE id = ?
    `)
    this.getTaskRowStmt = this.db.prepare(`
      SELECT id, status, stage, evidence_level FROM tasks WHERE title = ?
    `)
    this.getTaskIdStmt = this.db.prepare(`
      SELECT id FROM tasks WHERE title = ?
    `)
    this.deleteTaskFtsStmt = this.db.prepare(`DELETE FROM tasks_fts WHERE rowid = ?`)
    this.insertTaskFtsStmt = this.db.prepare(`INSERT INTO tasks_fts(rowid, title, details) VALUES (?, ?, ?)`)
    this.insertTaskEventStmt = this.db.prepare(`
      INSERT INTO task_events (task_id, ts, event_kind, stage, evidence_level, status, note, source_episode_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.getTaskEventsStmt = this.db.prepare(`
      SELECT ts, event_kind, stage, evidence_level, status, note
      FROM task_events
      WHERE task_id = ?
      ORDER BY ts ASC, id ASC
    `)
    this.updateTaskProjectionStmt = this.db.prepare(`
      UPDATE tasks
      SET stage = ?, evidence_level = ?, status = ?
      WHERE id = ?
    `)
    this.clearInterestsStmt = this.db.prepare(`DELETE FROM interests`)
    this.insertInterestStmt = this.db.prepare(`
      INSERT INTO interests (name, score, count, last_seen)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        score = excluded.score,
        count = excluded.count,
        last_seen = excluded.last_seen
    `)
    this.upsertSignalStmt = this.db.prepare(`
      INSERT INTO signals (kind, value, score, first_seen, last_seen, source_episode_id)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind, value) DO UPDATE SET
        score = MIN(1.5, MAX(signals.score, excluded.score) + 0.05),
        last_seen = excluded.last_seen,
        source_episode_id = COALESCE(excluded.source_episode_id, signals.source_episode_id)
    `)
    this.getSignalIdStmt = this.db.prepare(`
      SELECT id FROM signals WHERE kind = ? AND value = ?
    `)
    this.deleteSignalFtsStmt = this.db.prepare(`DELETE FROM signals_fts WHERE rowid = ?`)
    this.insertSignalFtsStmt = this.db.prepare(`INSERT INTO signals_fts(rowid, kind, value) VALUES (?, ?, ?)`)
    this.upsertEntityLinkStmt = this.db.prepare(`
      INSERT INTO entity_links (entity_id, linked_type, linked_id, source_episode_id, strength)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(entity_id, linked_type, linked_id) DO UPDATE SET
        source_episode_id = COALESCE(excluded.source_episode_id, entity_links.source_episode_id),
        strength = MAX(entity_links.strength, excluded.strength)
    `)
    this.listEntityLinksStmt = this.db.prepare(`
      SELECT entity_id, linked_type, linked_id, strength
      FROM entity_links
      WHERE entity_id = ?
      ORDER BY strength DESC, linked_type ASC, linked_id ASC
    `)
    this.upsertPropositionStmt = this.db.prepare(`
      INSERT INTO propositions (
        subject_key, proposition_kind, text, occurred_on, confidence, first_seen, last_seen,
        source_episode_id, source_fact_id, status, mention_count
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1)
      ON CONFLICT(subject_key, proposition_kind, text) DO UPDATE SET
        confidence = MAX(propositions.confidence, excluded.confidence),
        occurred_on = COALESCE(excluded.occurred_on, propositions.occurred_on),
        last_seen = excluded.last_seen,
        source_episode_id = COALESCE(excluded.source_episode_id, propositions.source_episode_id),
        source_fact_id = COALESCE(excluded.source_fact_id, propositions.source_fact_id),
        status = 'active',
        mention_count = propositions.mention_count + 1
    `)
    this.findPropositionStmt = this.db.prepare(`
      SELECT id, subject_key, proposition_kind, text, occurred_on, confidence
      FROM propositions
      WHERE subject_key = ? AND proposition_kind = ? AND text = ?
    `)
    this.listSiblingPropositionsStmt = this.db.prepare(`
      SELECT id, text, occurred_on
      FROM propositions
      WHERE subject_key = ?
        AND proposition_kind = ?
        AND status = 'active'
        AND id != ?
    `)
    this.markPropositionSupersededStmt = this.db.prepare(`
      UPDATE propositions
      SET status = 'superseded',
          superseded_by = ?,
          last_seen = ?
      WHERE id = ?
    `)
    this.bumpPropositionRetrievalStmt = this.db.prepare(`
      UPDATE propositions
      SET retrieval_count = retrieval_count + 1,
          last_retrieved_at = ?
      WHERE id = ?
    `)
    this.deletePropositionFtsStmt = this.db.prepare(`DELETE FROM propositions_fts WHERE rowid = ?`)
    this.insertPropositionFtsStmt = this.db.prepare(`INSERT INTO propositions_fts(rowid, text) VALUES (?, ?)`)
    this.markFactsStaleStmt = this.db.prepare(`
      UPDATE facts
      SET status = 'stale'
      WHERE status = 'active'
        AND fact_type = ?
        AND last_seen IS NOT NULL
        AND julianday('now') - julianday(last_seen) > ?
        AND mention_count < 3
    `)
    this.reviveFactsStmt = this.db.prepare(`
      UPDATE facts
      SET status = 'active'
      WHERE status = 'stale'
        AND fact_type = ?
        AND text = ?
    `)
    this.markTasksStaleStmt = this.db.prepare(`
      UPDATE tasks
      SET status = 'stale'
      WHERE status IN ('active', 'in_progress', 'paused')
        AND last_seen IS NOT NULL
        AND julianday('now') - julianday(last_seen) > 45
        AND confidence < 0.75
    `)
    this.bumpFactRetrievalStmt = this.db.prepare(`
      UPDATE facts
      SET retrieval_count = retrieval_count + 1,
          last_retrieved_at = ?
      WHERE id = ?
    `)
    this.bumpTaskRetrievalStmt = this.db.prepare(`
      UPDATE tasks
      SET retrieval_count = retrieval_count + 1,
          last_retrieved_at = ?
      WHERE id = ?
    `)
    this.bumpSignalRetrievalStmt = this.db.prepare(`
      UPDATE signals
      SET retrieval_count = retrieval_count + 1,
          last_retrieved_at = ?
      WHERE id = ?
    `)
    this.upsertVectorStmt = this.db.prepare(`
      INSERT INTO memory_vectors (entity_type, entity_id, model, dims, vector_json, content_hash, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, unixepoch())
      ON CONFLICT(entity_type, entity_id, model) DO UPDATE SET
        dims = excluded.dims,
        vector_json = excluded.vector_json,
        content_hash = excluded.content_hash,
        updated_at = unixepoch()
    `)
    this.getVectorStmt = this.db.prepare(`
      SELECT entity_type, entity_id, model, dims, vector_json, content_hash
      FROM memory_vectors
      WHERE entity_type = ? AND entity_id = ? AND model = ?
    `)
    this.listDenseFactRowsStmt = this.db.prepare(`
      SELECT 'fact' AS type, f.fact_type AS subtype, f.id AS entity_id, f.workstream AS workstream, f.text AS content,
             unixepoch(f.last_seen) AS updated_at, f.retrieval_count AS retrieval_count,
             f.confidence AS quality_score,
             e.source_ref AS source_ref, e.ts AS source_ts, e.kind AS source_kind, e.backend AS source_backend, mv.vector_json AS vector_json
      FROM memory_vectors mv
      JOIN facts f ON f.id = mv.entity_id
      LEFT JOIN episodes e ON e.id = f.source_episode_id
      WHERE mv.entity_type = 'fact'
        AND mv.model = ?
        AND f.status = 'active'
    `)
    this.listDenseTaskRowsStmt = this.db.prepare(`
      SELECT 'task' AS type, t.stage AS subtype, t.id AS entity_id, t.workstream AS workstream,
             trim(t.title || CASE WHEN t.details IS NOT NULL AND t.details != '' THEN ' — ' || t.details ELSE '' END) AS content,
             unixepoch(t.last_seen) AS updated_at, t.retrieval_count AS retrieval_count,
             t.confidence AS quality_score,
             t.stage AS stage, t.evidence_level AS evidence_level, t.status AS status,
             e.source_ref AS source_ref, e.ts AS source_ts, e.kind AS source_kind, e.backend AS source_backend, mv.vector_json AS vector_json
      FROM memory_vectors mv
      JOIN tasks t ON t.id = mv.entity_id
      LEFT JOIN episodes e ON e.id = t.source_episode_id
      WHERE mv.entity_type = 'task'
        AND mv.model = ?
        AND t.status IN ('active', 'in_progress', 'paused')
    `)
    this.listDenseSignalRowsStmt = this.db.prepare(`
      SELECT 'signal' AS type, s.kind AS subtype, s.id AS entity_id, s.value AS content,
             unixepoch(s.last_seen) AS updated_at, s.retrieval_count AS retrieval_count,
             s.score AS quality_score,
             e.source_ref AS source_ref, e.ts AS source_ts, e.kind AS source_kind, e.backend AS source_backend, mv.vector_json AS vector_json
      FROM memory_vectors mv
      JOIN signals s ON s.id = mv.entity_id
      LEFT JOIN episodes e ON e.id = s.source_episode_id
      WHERE mv.entity_type = 'signal'
        AND mv.model = ?
    `)
    this.listDensePropositionRowsStmt = this.db.prepare(`
      SELECT 'proposition' AS type, p.proposition_kind AS subtype, p.id AS entity_id, p.text AS content,
             unixepoch(p.last_seen) AS updated_at, p.retrieval_count AS retrieval_count,
             p.confidence AS quality_score,
             e.source_ref AS source_ref, e.ts AS source_ts, e.kind AS source_kind, e.backend AS source_backend, mv.vector_json AS vector_json
      FROM memory_vectors mv
      JOIN propositions p ON p.id = mv.entity_id
      LEFT JOIN episodes e ON e.id = p.source_episode_id
      WHERE mv.entity_type = 'proposition'
        AND mv.model = ?
        AND p.status = 'active'
    `)
    this.listDenseEpisodeRowsStmt = this.db.prepare(`
      SELECT 'episode' AS type, e.role AS subtype, e.id AS entity_id, e.content AS content,
             e.created_at AS updated_at, 0 AS retrieval_count,
             e.source_ref AS source_ref, e.ts AS source_ts, e.kind AS source_kind, e.backend AS source_backend, mv.vector_json AS vector_json
      FROM memory_vectors mv
      JOIN episodes e ON e.id = mv.entity_id
      WHERE mv.entity_type = 'episode'
        AND mv.model = ?
    `)
  }

  getMetaValue(key, fallback = null) {
    const row = this.getMetaStmt.get(key)
    return row?.value ?? fallback
  }

  setMetaValue(key, value) {
    const serialized =
      typeof value === 'string'
        ? value
        : JSON.stringify(value)
    this.upsertMetaStmt.run(key, serialized)
  }

  syncEmbeddingMetadata(extra = {}) {
    this.setMetaValue('embedding.current_model', getEmbeddingModelId())
    this.setMetaValue('embedding.current_dims', String(getEmbeddingDims()))
    this.setMetaValue('embedding.index_version', '2')
    this.setMetaValue('embedding.updated_at', new Date().toISOString())
    if (extra.vectorModel) this.setMetaValue('embedding.vector_model', extra.vectorModel)
    if (extra.vectorDims) this.setMetaValue('embedding.vector_dims', String(extra.vectorDims))
    if (extra.reason) this.setMetaValue('embedding.last_reason', extra.reason)
    if (extra.reindexRequired != null) this.setMetaValue('embedding.reindex_required', extra.reindexRequired ? '1' : '0')
    if (extra.reindexReason) this.setMetaValue('embedding.reindex_reason', extra.reindexReason)
    if (extra.reindexCompleted) {
      this.setMetaValue('embedding.reindex_required', '0')
      this.setMetaValue('embedding.reindex_reason', '')
    }
  }

  noteVectorWrite(model, dims) {
    const switchEvent = consumeProviderSwitchEvent()
    this.syncEmbeddingMetadata({
      vectorModel: model,
      vectorDims: dims,
      reason: switchEvent ? `vector_write_after_${switchEvent.phase}_switch` : 'vector_write',
      reindexRequired: switchEvent ? 1 : 0,
      reindexReason: switchEvent
        ? `${switchEvent.previousModelId} -> ${switchEvent.currentModelId} (${switchEvent.phase}: ${switchEvent.reason})`
        : '',
    })
  }

  backfillCanonicalKeys() {
    const factRows = this.db.prepare(`
      SELECT id, fact_type, slot, workstream, text
      FROM facts
      WHERE claim_key IS NULL OR claim_key = ''
    `).all()
    for (const row of factRows) {
      const claimKey = deriveClaimKey(row.fact_type, row.slot, row.text, row.workstream)
      this.db.prepare(`UPDATE facts SET claim_key = ? WHERE id = ?`).run(claimKey, row.id)
    }

    const taskRows = this.db.prepare(`
      SELECT id, title, workstream
      FROM tasks
      WHERE task_key IS NULL OR task_key = ''
    `).all()
    for (const row of taskRows) {
      const taskKey = deriveTaskKey(row.title, row.workstream)
      this.db.prepare(`UPDATE tasks SET task_key = ? WHERE id = ?`).run(taskKey, row.id)
    }
  }

  deriveSubjectKey(text, propositionKind = 'fact') {
    const clean = cleanMemoryText(text)
    if (!clean) return propositionKind
    try {
      const entities = this.db.prepare(`
        SELECT name
        FROM entities
        ORDER BY length(name) DESC, id ASC
      `).all()
      for (const entity of entities) {
        if (entity?.name && clean.toLowerCase().includes(String(entity.name).toLowerCase())) {
          return String(entity.name)
        }
      }
    } catch { /* ignore */ }
    const tokens = propositionSubjectTokens(clean)
    if (tokens.length === 0) return propositionKind
    return tokens.slice(0, 2).join('-')
  }

  upsertPropositions(items = [], seenAt = null, sourceEpisodeId = null, sourceFactId = null) {
    const seenKeys = new Set()
    for (const item of items) {
      const text = cleanMemoryText(item?.text)
      const propositionKind = normalizeFactSlot(item?.propositionKind) || 'fact'
      if (!text) continue
      const subjectKey = normalizeWorkstream(item?.subjectKey) || normalizeWorkstream(this.deriveSubjectKey(text, propositionKind)) || propositionKind
      const occurredOn = item?.occurredOn ?? extractExplicitDate(text) ?? (seenAt ? String(seenAt).slice(0, 10) : null)
      const confidence = Number(item?.confidence ?? 0.6)
      const dedupeKey = `${subjectKey}:${propositionKind}:${text}`
      if (seenKeys.has(dedupeKey)) continue
      seenKeys.add(dedupeKey)
      this.upsertPropositionStmt.run(
        subjectKey,
        propositionKind,
        text,
        occurredOn,
        confidence,
        seenAt,
        seenAt,
        sourceEpisodeId,
        sourceFactId,
      )
      const row = this.findPropositionStmt.get(subjectKey, propositionKind, text)
      if (!row?.id) continue
      this.deletePropositionFtsStmt.run(row.id)
      this.insertPropositionFtsStmt.run(row.id, text)
      const siblings = this.listSiblingPropositionsStmt.all(subjectKey, propositionKind, row.id)
      for (const sibling of siblings) {
        const siblingDate = sibling?.occurred_on ? new Date(String(sibling.occurred_on)).getTime() : 0
        const rowDate = occurredOn ? new Date(String(occurredOn)).getTime() : 0
        const lexicalOverlap = (() => {
          const left = new Set(tokenizeMemoryText(text))
          const right = new Set(tokenizeMemoryText(String(sibling?.text ?? '')))
          const overlap = [...left].filter(token => right.has(token)).length
          return left.size > 0 ? overlap / left.size : 0
        })()
        if (String(sibling?.text ?? '') === text) continue
        if (rowDate && siblingDate && rowDate < siblingDate) continue
        if (lexicalOverlap < 0.35) continue
        this.markPropositionSupersededStmt.run(row.id, seenAt ?? new Date().toISOString(), sibling.id)
      }
      this.linkMemoryToEntities(text, 'proposition', row.id, sourceEpisodeId)
    }
  }

  linkMemoryToEntities(text, linkedType, linkedId, sourceEpisodeId = null) {
    const clean = cleanMemoryText(text)
    if (!clean || !linkedType || !Number.isFinite(Number(linkedId))) return
    let entities = []
    try {
      entities = this.db.prepare(`
        SELECT id, name
        FROM entities
        ORDER BY length(name) DESC, id ASC
      `).all()
    } catch {
      return
    }
    const lowered = clean.toLowerCase()
    for (const entity of entities) {
      const name = String(entity?.name ?? '').trim()
      if (!name) continue
      if (!lowered.includes(name.toLowerCase())) continue
      const strength = Math.min(1.5, Math.max(0.6, name.length / 20))
      this.upsertEntityLinkStmt.run(entity.id, linkedType, Number(linkedId), sourceEpisodeId, strength)
    }
  }

  rebuildEntityLinks() {
    this.clearEntityLinksStmt.run()

    const factRows = this.db.prepare(`SELECT id, text, source_episode_id FROM facts WHERE status = 'active'`).all()
    for (const row of factRows) this.linkMemoryToEntities(row.text, 'fact', row.id, row.source_episode_id)

    const taskRows = this.db.prepare(`
      SELECT id,
             trim(title || CASE WHEN details IS NOT NULL AND details != '' THEN ' — ' || details ELSE '' END) AS content,
             source_episode_id
      FROM tasks
      WHERE status IN ('active', 'in_progress', 'paused', 'done')
    `).all()
    for (const row of taskRows) this.linkMemoryToEntities(row.content, 'task', row.id, row.source_episode_id)

    const propositionRows = this.db.prepare(`SELECT id, text, source_episode_id FROM propositions WHERE status = 'active'`).all()
    for (const row of propositionRows) this.linkMemoryToEntities(row.text, 'proposition', row.id, row.source_episode_id)

    const episodeRows = this.db.prepare(`
      SELECT id, content
      FROM episodes
      WHERE role = 'user'
        AND kind = 'message'
    `).all()
    for (const row of episodeRows) this.linkMemoryToEntities(row.content, 'episode', row.id, row.id)
  }

  resolveQueryEntityScope(query = '') {
    const clean = cleanMemoryText(query)
    if (!clean) return []
    try {
      const entities = this.db.prepare(`
        SELECT id, name, entity_type, description, source_episode_id
        FROM entities
        ORDER BY length(name) DESC, last_seen DESC, id ASC
      `).all()
      const lowered = clean.toLowerCase()
      const rows = entities.filter(entity => {
        const name = String(entity?.name ?? '').trim().toLowerCase()
        if (!name) return false
        return lowered.includes(name)
      }).slice(0, 8)
      const seen = new Set()
      return rows.filter(row => {
        if (seen.has(row.id)) return false
        seen.add(row.id)
        return true
      })
    } catch {
      return []
    }
  }

  getEntityScopedResults(queryEntities = [], limit = 6) {
    const results = []
    const seen = new Set()
    if (queryEntities.length >= 2) {
      const entityIds = queryEntities.map(entity => Number(entity.id)).filter(Number.isFinite)
      const relations = this.db.prepare(`
        SELECT 'relation' AS type, r.relation_type AS subtype, r.id AS entity_id,
               trim(se.name || ' -> ' || te.name || CASE WHEN r.description IS NOT NULL AND r.description != '' THEN ' — ' || r.description ELSE '' END) AS content,
               unixepoch(r.last_seen) AS updated_at, 0 AS retrieval_count,
               r.confidence AS quality_score, r.source_episode_id AS source_episode_id,
               ep.kind AS source_kind, ep.backend AS source_backend
        FROM relations r
        JOIN entities se ON se.id = r.source_entity_id
        JOIN entities te ON te.id = r.target_entity_id
        LEFT JOIN episodes ep ON ep.id = r.source_episode_id
        WHERE r.status = 'active'
          AND r.source_entity_id IN (${entityIds.map(() => '?').join(', ')})
          AND r.target_entity_id IN (${entityIds.map(() => '?').join(', ')})
        ORDER BY r.confidence DESC, r.last_seen DESC
        LIMIT ?
      `).all(...entityIds, ...entityIds, Math.max(2, limit))
      for (const relation of relations) {
        const key = `${relation.type}:${relation.entity_id}`
        if (seen.has(key)) continue
        seen.add(key)
        results.push({ ...relation, score: -9.7 })
      }
    }
    if (queryEntities.length === 1) {
      const entityId = Number(queryEntities[0].id)
      const relations = this.db.prepare(`
        SELECT 'relation' AS type, r.relation_type AS subtype, r.id AS entity_id,
               trim(se.name || ' -> ' || te.name || CASE WHEN r.description IS NOT NULL AND r.description != '' THEN ' — ' || r.description ELSE '' END) AS content,
               unixepoch(r.last_seen) AS updated_at, 0 AS retrieval_count,
               r.confidence AS quality_score, r.source_episode_id AS source_episode_id,
               ep.kind AS source_kind, ep.backend AS source_backend
        FROM relations r
        JOIN entities se ON se.id = r.source_entity_id
        JOIN entities te ON te.id = r.target_entity_id
        LEFT JOIN episodes ep ON ep.id = r.source_episode_id
        WHERE r.status = 'active'
          AND (r.source_entity_id = ? OR r.target_entity_id = ?)
        ORDER BY r.confidence DESC, r.last_seen DESC
        LIMIT ?
      `).all(entityId, entityId, Math.max(2, limit))
      for (const relation of relations) {
        const key = `${relation.type}:${relation.entity_id}`
        if (seen.has(key)) continue
        seen.add(key)
        results.push({ ...relation, score: -9.65 })
      }
    }
    for (const entity of queryEntities) {
      const links = this.listEntityLinksStmt.all(entity.id).slice(0, Math.max(3, limit))
      for (const link of links) {
        let row = null
        if (link.linked_type === 'fact') row = this._getEntityMeta('fact', link.linked_id, getEmbeddingModelId())
        else if (link.linked_type === 'task') row = this._getEntityMeta('task', link.linked_id, getEmbeddingModelId())
        else if (link.linked_type === 'proposition') row = this._getEntityMeta('proposition', link.linked_id, getEmbeddingModelId())
        else if (link.linked_type === 'episode') row = this._getEntityMeta('episode', link.linked_id, getEmbeddingModelId())
        if (!row) continue
        const key = `${row.type}:${row.entity_id}`
        if (seen.has(key)) continue
        seen.add(key)
        results.push({
          ...row,
          score: -9.4,
          scoped_entity_id: entity.id,
          scoped_entity_name: entity.name,
        })
        if (results.length >= limit) return results
      }
    }
    return results
  }

  getRuleScopedResults(query = '', limit = 6) {
    const clean = cleanMemoryText(query)
    if (!clean || !isRuleQuery(clean)) return []
    const tokens = propositionSubjectTokens(clean).slice(0, 8)
    if (tokens.length === 0) return []
    const patterns = tokens.map(token => `%${token}%`)
    const results = []
    try {
      results.push(...this.db.prepare(`
        SELECT 'fact' AS type, fact_type AS subtype, CAST(id AS TEXT) AS ref, text AS content,
               unixepoch(last_seen) AS updated_at, id AS entity_id, retrieval_count,
               confidence AS quality_score, source_episode_id
        FROM facts
        WHERE status = 'active'
          AND fact_type = 'constraint'
          AND (${patterns.map(() => 'text LIKE ?').join(' OR ')})
        ORDER BY confidence DESC, mention_count DESC, last_seen DESC
        LIMIT ?
      `).all(...patterns, Math.max(3, limit)))
    } catch { /* ignore */ }
    try {
      results.push(...this.db.prepare(`
        SELECT 'proposition' AS type, proposition_kind AS subtype, CAST(id AS TEXT) AS ref, text AS content,
               unixepoch(last_seen) AS updated_at, id AS entity_id, retrieval_count,
               confidence AS quality_score, source_episode_id, source_fact_id
        FROM propositions
        WHERE status = 'active'
          AND (${patterns.map(() => 'text LIKE ?').join(' OR ')})
        ORDER BY confidence DESC, mention_count DESC, last_seen DESC
        LIMIT ?
      `).all(...patterns, Math.max(3, limit)))
    } catch { /* ignore */ }
    return results
      .sort((left, right) => Number(right.quality_score ?? 0) - Number(left.quality_score ?? 0))
      .slice(0, limit)
      .map(item => ({ ...item, score: -9.6 }))
  }

  /**
   * Retrieve a stored vector from memory_vectors, or compute and store it.
   * @param {string} entityType - 'fact', 'task', 'signal', 'episode'
   * @param {number} entityId - row id
   * @param {string} text - text to embed if no stored vector found
   * @returns {number[]} embedding vector
   */
  async getStoredVector(entityType, entityId, text) {
    const lookupModel = getEmbeddingModelId()
    const existing = this.getVectorStmt.get(entityType, entityId, lookupModel)
    if (existing?.vector_json) {
      try {
        const parsed = JSON.parse(existing.vector_json)
        if (Array.isArray(parsed) && parsed.length > 0) return parsed
      } catch { /* fall through to embed */ }
    }
    const vector = await embedText(String(text).slice(0, 320))
    if (Array.isArray(vector) && vector.length > 0) {
      const activeModel = getEmbeddingModelId()
      const contentHash = hashEmbeddingInput(text)
      this.upsertVectorStmt.run(entityType, entityId, activeModel, vector.length, JSON.stringify(vector), contentHash)
      this._syncToVecTable(entityType, entityId, vector)
      this.noteVectorWrite(activeModel, vector.length)
    }
    return vector
  }

  rebuildDerivedIndexes() {
    this.clearFactsFtsStmt.run()
    this.clearTasksFtsStmt.run()
    this.clearSignalsFtsStmt.run()
    this.clearPropositionsFtsStmt.run()

    const facts = this.db.prepare(`SELECT id, text FROM facts`).all()
    for (const row of facts) {
      try { this.deleteFactFtsStmt.run(row.id) } catch { /* best effort rebuild */ }
      try { this.insertFactFtsStmt.run(row.id, row.text) } catch { /* best effort rebuild */ }
    }

    const tasks = this.db.prepare(`SELECT id, title, details FROM tasks`).all()
    for (const row of tasks) {
      try { this.deleteTaskFtsStmt.run(row.id) } catch { /* best effort rebuild */ }
      try { this.insertTaskFtsStmt.run(row.id, row.title, row.details ?? '') } catch { /* best effort rebuild */ }
    }

    const signals = this.db.prepare(`SELECT id, kind, value FROM signals`).all()
    for (const row of signals) {
      try {
        this.insertSignalFtsStmt.run(row.id, row.kind, row.value)
      } catch { /* best-effort rebuild */ }
    }

    const propositions = this.db.prepare(`SELECT id, text FROM propositions WHERE status = 'active'`).all()
    for (const row of propositions) {
      try { this.deletePropositionFtsStmt.run(row.id) } catch { /* best effort rebuild */ }
      try { this.insertPropositionFtsStmt.run(row.id, row.text) } catch { /* best effort rebuild */ }
    }

  }

  appendEpisode(entry) {
    const clean = cleanMemoryText(entry.content)
    if (!clean) return null
    const ts = entry.ts || new Date().toISOString()
    const dayKey = ts.slice(0, 10)
    const sourceRef = entry.sourceRef || null
    this.insertEpisodeStmt.run(
      ts,
      dayKey,
      entry.backend || 'claude2bot',
      entry.channelId || null,
      entry.userId || null,
      entry.userName || null,
      entry.sessionId || null,
      entry.role,
      entry.kind || 'message',
      clean,
      sourceRef,
    )

    const episodeId = sourceRef ? this.getEpisodeBySourceStmt.get(sourceRef)?.id : null
    const finalEpisodeId = episodeId ?? this.db.prepare('SELECT last_insert_rowid() AS id').get().id
    if (finalEpisodeId) {
      try {
        this.insertEpisodeFtsStmt.run(finalEpisodeId, clean)
      } catch { /* duplicate rowid import */ }
      const shouldCandidate =
        entry.role === 'user' &&
        entry.kind === 'message'
      const score = shouldCandidate ? candidateScore(clean, entry.role) : 0
      if (score > 0) {
        this.insertCandidateStmt.run(finalEpisodeId, ts, dayKey, entry.role, clean, score)
      }

      // Inline embedding: immediately make this episode searchable via dense search
      if (shouldCandidate && clean.length >= 10 && clean.length <= 500 && !looksLowSignal(clean)) {
        this._embedEpisodeAsync(finalEpisodeId, clean)
      }
    }
    return finalEpisodeId ?? null
  }

  _embedEpisodeAsync(episodeId, content) {
    const lookupModel = getEmbeddingModelId()
    const contentHash = hashEmbeddingInput(content)
    const existing = this.getVectorStmt.get('episode', episodeId, lookupModel)
    if (existing?.content_hash === contentHash) return
    // Persist to DB queue for crash recovery
    try {
      this.db.prepare('INSERT OR IGNORE INTO pending_embeds (entity_type, entity_id, content) VALUES (?, ?, ?)').run('episode', episodeId, content.slice(0, 320))
    } catch {}
    // Process asynchronously
    const task = async () => {
      const vector = await embedText(content.slice(0, 320))
      if (!Array.isArray(vector) || vector.length === 0) return
      const activeModel = getEmbeddingModelId()
      this.upsertVectorStmt.run('episode', episodeId, activeModel, vector.length, JSON.stringify(vector), contentHash)
      this._syncToVecTable('episode', episodeId, vector)
      this.noteVectorWrite(activeModel, vector.length)
      try { this.db.prepare('DELETE FROM pending_embeds WHERE entity_type = ? AND entity_id = ?').run('episode', episodeId) } catch {}
    }
    if (!this._embedQueue) this._embedQueue = Promise.resolve()
    this._embedQueue = this._embedQueue.then(task).catch(() => {})
  }

  async processPendingEmbeds() {
    const pending = this.db.prepare('SELECT entity_type, entity_id, content FROM pending_embeds ORDER BY id LIMIT 50').all()
    if (pending.length === 0) return 0
    let processed = 0
    for (const item of pending) {
      const vector = await embedText(item.content.slice(0, 320))
      if (!Array.isArray(vector) || vector.length === 0) continue
      const activeModel = getEmbeddingModelId()
      const contentHash = hashEmbeddingInput(item.content)
      this.upsertVectorStmt.run(item.entity_type, item.entity_id, activeModel, vector.length, JSON.stringify(vector), contentHash)
      this._syncToVecTable(item.entity_type, item.entity_id, vector)
      this.noteVectorWrite(activeModel, vector.length)
      this.db.prepare('DELETE FROM pending_embeds WHERE entity_type = ? AND entity_id = ?').run(item.entity_type, item.entity_id)
      processed += 1
    }
    if (processed > 0) process.stderr.write(`[memory] recovered ${processed} pending embeds\n`)
    return processed
  }

  ingestTranscriptFile(transcriptPath) {
    if (!existsSync(transcriptPath)) return 0
    const lines = readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean)
    let count = 0
    let index = 0
    for (const line of lines) {
      index += 1
      try {
        const parsed = JSON.parse(line)
        const role = parsed.message?.role
        if (role !== 'user' && role !== 'assistant') continue
        const text = firstTextContent(parsed.message?.content)
        if (!text.trim()) continue
        const clean = cleanMemoryText(text)
        if (!clean || clean.includes('[Request interrupted by user]')) continue
        const ts = parsed.timestamp ?? parsed.ts ?? new Date(statSync(transcriptPath).mtimeMs).toISOString()
        const sessionId = parsed.sessionId ?? ''
        const sourceRef = `transcript:${sessionId || resolve(transcriptPath)}:${index}:${role}`
        const id = this.appendEpisode({
          ts,
          backend: 'claude-session',
          channelId: null,
          userId: role === 'user' ? 'session:user' : 'session:assistant',
          userName: role,
          sessionId: sessionId || null,
          role,
          kind: 'transcript',
          content: clean,
          sourceRef,
        })
        if (id) count += 1
      } catch { /* skip malformed lines */ }
    }
    return count
  }

  ingestTranscriptFiles(paths) {
    let total = 0
    for (const filePath of paths) {
      total += this.ingestTranscriptFile(filePath)
    }
    return total
  }

  getEpisodesForDate(dayKey) {
    return this.db.prepare(`
      SELECT id, ts, role, content
      FROM episodes
      WHERE day_key = ?
      ORDER BY ts, id
    `).all(dayKey)
  }

  getEpisodeDayKey(episodeId) {
    return this.db.prepare(`
      SELECT day_key
      FROM episodes
      WHERE id = ?
    `).get(episodeId)?.day_key ?? null
  }

  getProfileRecallRows(query = '', limit = 5) {
    const clean = String(query ?? '').trim()
    const queryLike = `%${clean}%`
    const rows = clean
      ? this.db.prepare(`
          SELECT 'profile' AS type, key AS subtype, value AS content, confidence, last_seen
          FROM profiles
          WHERE status = 'active'
            AND (key LIKE ? OR value LIKE ?)
          ORDER BY confidence DESC, last_seen DESC
          LIMIT ?
        `).all(queryLike, queryLike, limit)
      : this.db.prepare(`
          SELECT 'profile' AS type, key AS subtype, value AS content, confidence, last_seen
          FROM profiles
          WHERE status = 'active'
          ORDER BY confidence DESC, last_seen DESC
          LIMIT ?
        `).all(limit)

    const signalRows = clean
      ? this.db.prepare(`
          SELECT 'signal' AS type, kind AS subtype, value AS content, score AS confidence, last_seen
          FROM signals
          WHERE kind IN ('language', 'tone', 'response_style')
            AND value LIKE ?
          ORDER BY score DESC, last_seen DESC
          LIMIT ?
        `).all(queryLike, Math.max(1, Math.ceil(limit / 2)))
      : this.db.prepare(`
          SELECT 'signal' AS type, kind AS subtype, value AS content, score AS confidence, last_seen
          FROM signals
          WHERE kind IN ('language', 'tone', 'response_style')
          ORDER BY score DESC, last_seen DESC
          LIMIT ?
        `).all(Math.max(1, Math.ceil(limit / 2)))

    return [...rows, ...signalRows].slice(0, limit)
  }

  getPolicyRecallRows(query = '', limit = 5, options = {}) {
    const factTypes = ['constraint', 'preference', 'decision', 'fact']
    const clean = String(query ?? '').trim()
    const queryLike = `%${clean}%`
    const { startDate = null, endDate = null } = options
    const timeClause = startDate && endDate ? ` AND last_seen >= ? AND last_seen <= ?` : ''
    const params = [
      ...factTypes,
      ...(clean ? [queryLike] : []),
      ...(startDate && endDate ? [startDate, `${endDate}T23:59:59`] : []),
      limit,
    ]
    return this.db.prepare(`
      SELECT 'fact' AS type, fact_type AS subtype, text AS content, confidence, last_seen, source_episode_id
      FROM facts
      WHERE status = 'active'
        AND fact_type IN (${factTypes.map(() => '?').join(', ')})
        ${clean ? 'AND text LIKE ?' : ''}
        ${timeClause}
      ORDER BY confidence DESC, retrieval_count DESC, mention_count DESC, last_seen DESC
      LIMIT ?
    `).all(...params)
  }

  getEntityRecallRows(query = '', limit = 5) {
    const clean = String(query ?? '').trim()
    const queryLike = `%${clean}%`
    return this.db.prepare(`
      SELECT 'entity' AS type, entity_type AS subtype, name AS content, description, last_seen
      FROM entities
      WHERE ${clean ? '(name LIKE ? OR description LIKE ?)' : '1=1'}
      ORDER BY last_seen DESC, id DESC
      LIMIT ?
    `).all(...(clean ? [queryLike, queryLike, limit] : [limit]))
  }

  getRelationRecallRows(query = '', limit = 5) {
    const clean = String(query ?? '').trim()
    const queryLike = `%${clean}%`
    return this.db.prepare(`
      SELECT 'relation' AS type, r.relation_type AS subtype,
             trim(se.name || ' -> ' || te.name || CASE WHEN r.description IS NOT NULL AND r.description != '' THEN ' — ' || r.description ELSE '' END) AS content,
             r.confidence, r.last_seen
      FROM relations r
      JOIN entities se ON se.id = r.source_entity_id
      JOIN entities te ON te.id = r.target_entity_id
      WHERE r.status = 'active'
        ${clean ? "AND (se.name LIKE ? OR te.name LIKE ? OR r.relation_type LIKE ? OR COALESCE(r.description, '') LIKE ?)" : ''}
      ORDER BY r.confidence DESC, r.last_seen DESC
      LIMIT ?
    `).all(...(clean ? [queryLike, queryLike, queryLike, queryLike, limit] : [limit]))
  }

  async verifyMemoryClaim(query, options = {}) {
    const clean = String(query ?? '').trim()
    if (!clean) return []
    const verifyLimit = Math.max(1, Math.min(Number(options.limit ?? 3), 5))
    const queryVector = options.queryVector ?? await embedText(clean)
    const ftsQuery = String(options.ftsQuery ?? '').trim()
    const matchesById = new Map()

    const registerMatch = (fact, extras = {}) => {
      const id = Number(fact.id ?? extras.id ?? 0)
      if (!id) return
      const previous = matchesById.get(id) ?? {}
      const merged = { ...previous, ...fact, ...extras, type: 'fact' }
      const normalizedQuery = clean.toLowerCase()
      const normalizedText = cleanMemoryText(merged.text ?? merged.content ?? '').toLowerCase()
      const queryTokens = tokenizeMemoryText(clean)
      const lexicalHits = queryTokens.filter(token => normalizedText.includes(token)).length
      const lexicalOverlap = queryTokens.length > 0 ? lexicalHits / queryTokens.length : 0
      const literalMatch = normalizedText.includes(normalizedQuery)
      const similarity = Number(merged.similarity ?? previous.similarity ?? 0)
      const exactBoost = literalMatch ? 0.18 : 0
      const lexicalBoost = Math.min(0.45, lexicalOverlap * 0.45)
      const semanticBoost = Math.min(0.55, Math.max(0, similarity) * 0.55)
      const verifyScore = Number(Math.min(1, semanticBoost + lexicalBoost + exactBoost).toFixed(3))
      const accepted = literalMatch
        || verifyScore >= 0.72
        || (similarity >= 0.92)
        || (similarity >= 0.8 && lexicalOverlap >= 0.18)
      matchesById.set(id, {
        ...merged,
        lexical_overlap: lexicalOverlap,
        literal_match: literalMatch,
        verify_score: verifyScore,
        accepted,
      })
    }

    if (this.vecEnabled && Array.isArray(queryVector) && queryVector.length > 0) {
      try {
        const hex = vecToHex(queryVector)
        const knnRows = this.db.prepare(
          `SELECT rowid, distance FROM vec_memory WHERE embedding MATCH X'${hex}' ORDER BY distance LIMIT ?`
        ).all(verifyLimit * 3)
        for (const knn of knnRows) {
          const { entityType, entityId } = this._vecRowToEntity(knn.rowid)
          if (entityType !== 'fact') continue
          const fact = this.db.prepare(
            `SELECT id, text, confidence, mention_count, last_seen, status FROM facts WHERE id = ? AND status = 'active'`
          ).get(entityId)
          if (fact) registerMatch(fact, { similarity: Number((1 - knn.distance).toFixed(3)), source: 'vector' })
        }
      } catch { /* ignore vec failure */ }
    }

    if (ftsQuery) {
      try {
        const ftsMatches = this.db.prepare(`
          SELECT f.id, f.text, f.confidence, f.mention_count, f.last_seen, f.status
          FROM facts_fts
          JOIN facts f ON f.id = facts_fts.rowid
          WHERE facts_fts MATCH ? AND f.status = 'active'
          ORDER BY bm25(facts_fts)
          LIMIT ?
        `).all(ftsQuery, verifyLimit * 2)
        for (const fact of ftsMatches) registerMatch(fact, { source: 'fts' })
      } catch { /* ignore FTS failure */ }
    }

    return Array.from(matchesById.values())
      .sort((a, b) => {
        const verifyDelta = Number(b.verify_score ?? 0) - Number(a.verify_score ?? 0)
        if (verifyDelta !== 0) return verifyDelta
        const lexicalDelta = Number(b.lexical_overlap ?? 0) - Number(a.lexical_overlap ?? 0)
        if (lexicalDelta !== 0) return lexicalDelta
        return Number(b.confidence ?? b.similarity ?? 0) - Number(a.confidence ?? a.similarity ?? 0)
      })
      .slice(0, verifyLimit)
  }

  async getEpisodeRecallRows(options = {}) {
    const {
      query = '',
      startDate,
      endDate,
      limit = 5,
      queryVector = null,
      ftsQuery = '',
    } = options
    const clean = String(query ?? '').trim()
    const queryLimit = Math.max(1, Number(limit))
    let episodes = []

    if (this.vecEnabled && Array.isArray(queryVector) && queryVector.length > 0) {
      try {
        const hex = vecToHex(queryVector)
        const knnRows = this.db.prepare(
          `SELECT rowid, distance FROM vec_memory WHERE embedding MATCH X'${hex}' ORDER BY distance LIMIT ?`
        ).all(queryLimit * 5)
        for (const knn of knnRows) {
          const { entityType, entityId } = this._vecRowToEntity(knn.rowid)
          if (entityType !== 'episode') continue
          const ep = this.db.prepare(`
            SELECT id, ts, day_key, role, kind, content, source_ref, backend AS source_backend
            FROM episodes
            WHERE id = ? AND day_key >= ? AND day_key <= ?
              AND kind NOT IN ('schedule-inject', 'event-inject')
          `).get(entityId, startDate, endDate)
          if (ep) episodes.push({ ...ep, similarity: 1 - knn.distance })
        }
      } catch { /* ignore vec failure */ }
    }

    if (episodes.length === 0 && clean) {
      try {
        episodes = this.db.prepare(`
          SELECT e.id, e.ts, e.day_key, e.role, e.kind, e.content, e.source_ref, e.backend AS source_backend, bm25(episodes_fts) AS score
          FROM episodes_fts
          JOIN episodes e ON e.id = episodes_fts.rowid
          WHERE episodes_fts MATCH ? AND e.day_key >= ? AND e.day_key <= ?
            AND e.kind NOT IN ('schedule-inject', 'event-inject')
          ORDER BY score
          LIMIT ?
        `).all(ftsQuery, startDate, endDate, queryLimit * 2)
      } catch { /* ignore FTS failure */ }
    }

    if (episodes.length === 0 && !clean) {
      episodes = this.db.prepare(`
        SELECT e.id, e.ts, e.day_key, e.role, e.kind, e.content, e.source_ref, e.backend AS source_backend
        FROM episodes e
        WHERE e.day_key >= ? AND e.day_key <= ?
          AND e.kind NOT IN ('schedule-inject', 'event-inject')
        ORDER BY e.ts DESC
        LIMIT ?
      `).all(startDate, endDate, queryLimit)
    }

    const seen = new Set()
    return episodes.filter(row => {
      const id = Number(row.id ?? row.entity_id ?? 0)
      if (!id || seen.has(id)) return false
      seen.add(id)
      return true
    }).slice(0, queryLimit)
  }

  async bulkVerifyHints(hints = [], options = {}) {
    const details = []
    let confirmed = 0
    let outdated = 0
    let unknown = 0

    for (const rawHint of hints) {
      const clean = String(rawHint ?? '').trim()
      if (!clean) {
        unknown += 1
        details.push({ hint: clean, status: '?' })
        continue
      }
      const ftsQuery = clean.replace(/['"]/g, '')
      const matches = await this.verifyMemoryClaim(clean, { limit: 1, ftsQuery })
      const bestMatch = matches[0]
      if (bestMatch) {
        const status = bestMatch.status === 'active' && bestMatch.accepted !== false ? '✓' : '✗'
        if (status === '✓') confirmed += 1
        else outdated += 1
        details.push({
          hint: clean,
          status,
          fact: String(bestMatch.text ?? bestMatch.content ?? ''),
          confidence: Number(bestMatch.confidence ?? bestMatch.similarity ?? 0).toFixed(2),
          mention_count: Number(bestMatch.mention_count ?? 0),
        })
      } else {
        unknown += 1
        details.push({ hint: clean, status: '?' })
      }
    }

    return {
      summary: `✓ confirmed(${confirmed}) ✗ outdated(${outdated}) ? unknown(${unknown})`,
      details,
    }
  }

  getRecallShortcutRows(kind = 'all', limit = 5, options = {}) {
    const queryLimit = Math.max(1, Number(limit))
    const { startDate = null, endDate = null } = options
    const timeClause = startDate && endDate ? ` AND last_seen >= ? AND last_seen <= ?` : ''
    const timeParams = startDate && endDate ? [startDate, `${endDate}T23:59:59`] : []
    let rows = []

    if (kind === 'all' || kind === 'facts') {
      rows.push(...this.db.prepare(`
        SELECT 'fact' AS type, fact_type AS subtype, text AS content, confidence, mention_count, last_seen, status
        FROM facts
        WHERE status = 'active'${timeClause}
        ORDER BY confidence DESC, mention_count DESC, last_seen DESC
        LIMIT ?
      `).all(...timeParams, kind === 'all' ? Math.ceil(queryLimit / 2) : queryLimit))
    }
    if (kind === 'all' || kind === 'tasks') {
      rows.push(...this.db.prepare(`
        SELECT 'task' AS type, stage AS subtype, title AS content, confidence, last_seen, status, priority
        FROM tasks
        WHERE status IN ('active', 'in_progress', 'paused')${timeClause}
        ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, last_seen DESC
        LIMIT ?
      `).all(...timeParams, kind === 'all' ? Math.ceil(queryLimit / 3) : queryLimit))
    }
    if (kind === 'all' || kind === 'signals') {
      rows.push(...this.db.prepare(`
        SELECT 'signal' AS type, kind AS subtype, value AS content, score AS confidence, last_seen
        FROM signals${startDate && endDate ? ' WHERE last_seen >= ? AND last_seen <= ?' : ''}
        ORDER BY score DESC, last_seen DESC
        LIMIT ?
      `).all(...timeParams, kind === 'all' ? Math.ceil(queryLimit / 3) : queryLimit))
    }
    if (kind === 'all' || kind === 'profiles') {
      rows.push(...this.getProfileRecallRows('', kind === 'all' ? Math.ceil(queryLimit / 3) : queryLimit))
    }
    if (kind === 'all' || kind === 'episodes') {
      rows.push(...this.db.prepare(`
        SELECT 'episode' AS type, role AS subtype, content, ts AS last_seen
        FROM episodes
        WHERE role = 'user'
          AND kind NOT IN ('schedule-inject', 'event-inject')
          AND content NOT LIKE 'You are consolidating%'
          AND LENGTH(content) >= 10
          ${startDate && endDate ? 'AND day_key >= ? AND day_key <= ?' : ''}
        ORDER BY ts DESC
        LIMIT ?
      `).all(...(startDate && endDate ? [startDate, endDate, kind === 'all' ? Math.ceil(queryLimit / 3) : queryLimit] : [kind === 'all' ? Math.ceil(queryLimit / 3) : queryLimit])))
    }
    if (kind === 'all' || kind === 'entities') {
      rows.push(...this.getEntityRecallRows('', kind === 'all' ? Math.ceil(queryLimit / 4) : queryLimit))
    }
    if (kind === 'all' || kind === 'relations') {
      rows.push(...this.getRelationRecallRows('', kind === 'all' ? Math.ceil(queryLimit / 4) : queryLimit))
    }

    return rows
  }

  getEpisodesSince(timestamp) {
    const ts = typeof timestamp === 'number'
      ? new Date(timestamp).toISOString()
      : String(timestamp)
    return this.db.prepare(`
      SELECT id, ts, role, kind, content
      FROM episodes
      WHERE ts > ?
      ORDER BY ts, id
    `).all(ts)
  }

  countEpisodes() {
    return this.db.prepare(`SELECT count(*) AS n FROM episodes`).get().n
  }

  getCandidatesForDate(dayKey) {
    return this.db.prepare(`
      SELECT mc.id, mc.episode_id, mc.ts, mc.role, mc.content, mc.score
      FROM memory_candidates mc
      JOIN episodes e ON e.id = mc.episode_id
      WHERE mc.day_key = ?
        AND mc.status = 'pending'
        AND e.role = 'user'
        AND e.kind = 'message'
      ORDER BY mc.score DESC, mc.ts ASC
    `).all(dayKey)
  }

  getPendingCandidateDays(limit = 7, minCount = 1) {
    return this.db.prepare(`
      SELECT mc.day_key, count(*) AS n
      FROM memory_candidates mc
      JOIN episodes e ON e.id = mc.episode_id
      WHERE mc.status = 'pending'
        AND e.role = 'user'
        AND e.kind = 'message'
      GROUP BY mc.day_key
      HAVING count(*) >= ?
      ORDER BY mc.day_key DESC
      LIMIT ?
    `).all(minCount, limit)
  }

  getDecayRows(kind = 'fact') {
    if (kind === 'fact') {
      return this.db.prepare(`
        SELECT id, mention_count, retrieval_count, last_seen
        FROM facts
        WHERE status = 'active'
      `).all()
    }
    if (kind === 'task') {
      return this.db.prepare(`
        SELECT id, retrieval_count, last_seen
        FROM tasks
        WHERE status = 'active'
      `).all()
    }
    if (kind === 'signal') {
      return this.db.prepare(`
        SELECT id, retrieval_count, last_seen
        FROM signals
        WHERE status = 'active'
      `).all()
    }
    return []
  }

  markRowsDeprecated(kind = 'fact', ids = [], seenAt = null) {
    const normalizedIds = [...new Set(ids.map(id => Number(id)).filter(Number.isFinite))]
    if (normalizedIds.length === 0 || !seenAt) return 0
    const placeholders = normalizedIds.map(() => '?').join(', ')
    if (kind === 'fact') {
      return Number(this.db.prepare(`
        UPDATE facts
        SET status = 'deprecated', last_seen = ?
        WHERE id IN (${placeholders})
      `).run(seenAt, ...normalizedIds).changes ?? 0)
    }
    if (kind === 'task') {
      return Number(this.db.prepare(`
        UPDATE tasks
        SET status = 'deprecated', last_seen = ?
        WHERE id IN (${placeholders})
      `).run(seenAt, ...normalizedIds).changes ?? 0)
    }
    if (kind === 'signal') {
      return Number(this.db.prepare(`
        UPDATE signals
        SET status = 'deprecated', last_seen = ?
        WHERE id IN (${placeholders})
      `).run(seenAt, ...normalizedIds).changes ?? 0)
    }
    return 0
  }

  listDeprecatedIds(kind = 'fact', olderThan = '') {
    if (!olderThan) return []
    if (kind === 'fact') {
      return this.db.prepare(`
        SELECT id
        FROM facts
        WHERE status = 'deprecated' AND last_seen < ?
      `).all(olderThan).map(row => Number(row.id)).filter(Number.isFinite)
    }
    if (kind === 'task') {
      return this.db.prepare(`
        SELECT id
        FROM tasks
        WHERE status = 'deprecated' AND last_seen < ?
      `).all(olderThan).map(row => Number(row.id)).filter(Number.isFinite)
    }
    if (kind === 'signal') {
      return this.db.prepare(`
        SELECT id
        FROM signals
        WHERE status = 'deprecated' AND last_seen < ?
      `).all(olderThan).map(row => Number(row.id)).filter(Number.isFinite)
    }
    return []
  }

  deleteRowsByIds(kind = 'fact', ids = []) {
    const normalizedIds = [...new Set(ids.map(id => Number(id)).filter(Number.isFinite))]
    if (normalizedIds.length === 0) return 0
    const placeholders = normalizedIds.map(() => '?').join(', ')
    if (kind === 'fact') {
      for (const id of normalizedIds) this.deleteFactFtsStmt.run(id)
      this.db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'fact' AND entity_id IN (${placeholders})`).run(...normalizedIds)
      return Number(this.db.prepare(`DELETE FROM facts WHERE id IN (${placeholders})`).run(...normalizedIds).changes ?? 0)
    }
    if (kind === 'task') {
      for (const id of normalizedIds) this.deleteTaskFtsStmt.run(id)
      this.db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'task' AND entity_id IN (${placeholders})`).run(...normalizedIds)
      this.db.prepare(`DELETE FROM task_events WHERE task_id IN (${placeholders})`).run(...normalizedIds)
      return Number(this.db.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`).run(...normalizedIds).changes ?? 0)
    }
    if (kind === 'signal') {
      for (const id of normalizedIds) this.deleteSignalFtsStmt.run(id)
      this.db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'signal' AND entity_id IN (${placeholders})`).run(...normalizedIds)
      return Number(this.db.prepare(`DELETE FROM signals WHERE id IN (${placeholders})`).run(...normalizedIds).changes ?? 0)
    }
    return 0
  }

  resetEmbeddingIndex(options = {}) {
    this.clearVectorsStmt.run()
    try { this.db.prepare('DELETE FROM pending_embeds').run() } catch { /* ignore */ }
    if (this.vecEnabled) {
      try {
        this.db.exec('DROP TABLE IF EXISTS vec_memory')
        this.db.exec(`CREATE VIRTUAL TABLE vec_memory USING vec0(embedding float[${getEmbeddingDims()}])`)
      } catch { /* ignore vec reset failure */ }
    }
    this.syncEmbeddingMetadata({
      reason: options.reason ?? 'reset_embedding_index',
      reindexRequired: 1,
      reindexReason: options.reindexReason ?? 'embedding index reset',
    })
  }

  vacuumDatabase() {
    try {
      this.db.exec('VACUUM')
      return true
    } catch {
      return false
    }
  }

  getRecentCandidateDays(limit = 7) {
    return this.db.prepare(`
      SELECT mc.day_key, count(*) AS n
      FROM memory_candidates mc
      JOIN episodes e ON e.id = mc.episode_id
      WHERE e.role = 'user'
        AND e.kind = 'message'
      GROUP BY mc.day_key
      ORDER BY mc.day_key DESC
      LIMIT ?
    `).all(limit)
  }

  countPendingCandidates(dayKey = null) {
    if (dayKey) {
      return this.db.prepare(`
        SELECT count(*) AS n
        FROM memory_candidates mc
        JOIN episodes e ON e.id = mc.episode_id
        WHERE mc.status = 'pending'
          AND mc.day_key = ?
          AND e.role = 'user'
          AND e.kind = 'message'
      `).get(dayKey).n
    }
    return this.db.prepare(`
      SELECT count(*) AS n
      FROM memory_candidates mc
      JOIN episodes e ON e.id = mc.episode_id
      WHERE mc.status = 'pending'
        AND e.role = 'user'
        AND e.kind = 'message'
    `).get().n
  }

  rebuildCandidates() {
    this.clearCandidatesStmt.run()
    const rows = this.db.prepare(`
      SELECT id, ts, day_key, role, kind, content
      FROM episodes
      ORDER BY ts, id
    `).all()
    let created = 0
    for (const row of rows) {
      const clean = cleanMemoryText(row.content)
      if (!clean) continue
      const shouldCandidate =
        row.role === 'user' &&
        row.kind === 'message'
      const score = shouldCandidate ? candidateScore(clean, row.role) : 0
      if (score > 0) {
        this.insertCandidateStmt.run(row.id, row.ts, row.day_key, row.role, clean, score)
        created += 1
      }
    }
    return created
  }

  resetConsolidatedMemory() {
    this.clearFactsStmt.run()
    this.clearTasksStmt.run()
    this.clearSignalsStmt.run()
    this.clearPropositionsStmt.run()
    this.clearFactsFtsStmt.run()
    this.clearTasksFtsStmt.run()
    this.clearSignalsFtsStmt.run()
    this.clearPropositionsFtsStmt.run()
    this.clearVectorsStmt.run()
    this.db.prepare(`UPDATE memory_candidates SET status = 'pending'`).run()
  }

  resetConsolidatedMemoryForDays(dayKeys = []) {
    const keys = [...new Set(dayKeys.map(key => String(key).trim()).filter(Boolean))]
    if (keys.length === 0) return

    const placeholders = keys.map(() => '?').join(', ')
    const episodeIds = this.db.prepare(`
      SELECT id
      FROM episodes
      WHERE day_key IN (${placeholders})
    `).all(...keys).map(row => Number(row.id)).filter(Number.isFinite)

    if (episodeIds.length > 0) {
      const episodePlaceholders = episodeIds.map(() => '?').join(', ')

      const factIds = this.db.prepare(`
        SELECT id FROM facts WHERE source_episode_id IN (${episodePlaceholders})
      `).all(...episodeIds).map(row => Number(row.id)).filter(Number.isFinite)
      if (factIds.length > 0) {
        const factPlaceholders = factIds.map(() => '?').join(', ')
        for (const id of factIds) this.deleteFactFtsStmt.run(id)
        this.db.prepare(`DELETE FROM facts WHERE id IN (${factPlaceholders})`).run(...factIds)
        this.db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'fact' AND entity_id IN (${factPlaceholders})`).run(...factIds)
      }

      const taskIds = this.db.prepare(`
        SELECT id FROM tasks WHERE source_episode_id IN (${episodePlaceholders})
      `).all(...episodeIds).map(row => Number(row.id)).filter(Number.isFinite)
      if (taskIds.length > 0) {
        const taskPlaceholders = taskIds.map(() => '?').join(', ')
        for (const id of taskIds) this.deleteTaskFtsStmt.run(id)
        this.db.prepare(`DELETE FROM tasks WHERE id IN (${taskPlaceholders})`).run(...taskIds)
        this.db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'task' AND entity_id IN (${taskPlaceholders})`).run(...taskIds)
      }

      const signalIds = this.db.prepare(`
        SELECT id FROM signals WHERE source_episode_id IN (${episodePlaceholders})
      `).all(...episodeIds).map(row => Number(row.id)).filter(Number.isFinite)
      if (signalIds.length > 0) {
        const signalPlaceholders = signalIds.map(() => '?').join(', ')
        for (const id of signalIds) this.deleteSignalFtsStmt.run(id)
        this.db.prepare(`DELETE FROM signals WHERE id IN (${signalPlaceholders})`).run(...signalIds)
        this.db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'signal' AND entity_id IN (${signalPlaceholders})`).run(...signalIds)
      }

      const propositionIds = this.db.prepare(`
        SELECT id FROM propositions WHERE source_episode_id IN (${episodePlaceholders})
      `).all(...episodeIds).map(row => Number(row.id)).filter(Number.isFinite)
      if (propositionIds.length > 0) {
        const propositionPlaceholders = propositionIds.map(() => '?').join(', ')
        for (const id of propositionIds) this.deletePropositionFtsStmt.run(id)
        this.db.prepare(`DELETE FROM propositions WHERE id IN (${propositionPlaceholders})`).run(...propositionIds)
        this.db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'proposition' AND entity_id IN (${propositionPlaceholders})`).run(...propositionIds)
      }
    }

    this.db.prepare(`
      UPDATE memory_candidates
      SET status = 'pending'
      WHERE day_key IN (${placeholders})
    `).run(...keys)
  }

  pruneConsolidatedMemoryOutsideDays(dayKeys = []) {
    const keys = [...new Set(dayKeys.map(key => String(key).trim()).filter(Boolean))]
    if (keys.length === 0) return

    const placeholders = keys.map(() => '?').join(', ')
    const keepEpisodeIds = this.db.prepare(`
      SELECT id
      FROM episodes
      WHERE day_key IN (${placeholders})
    `).all(...keys).map(row => Number(row.id)).filter(Number.isFinite)

    if (keepEpisodeIds.length === 0) return
    const keepPlaceholders = keepEpisodeIds.map(() => '?').join(', ')

    const staleFactIds = this.db.prepare(`
      SELECT id FROM facts
      WHERE source_episode_id IS NOT NULL
        AND source_episode_id NOT IN (${keepPlaceholders})
    `).all(...keepEpisodeIds).map(row => Number(row.id)).filter(Number.isFinite)
    if (staleFactIds.length > 0) {
      const staleFactPlaceholders = staleFactIds.map(() => '?').join(', ')
      for (const id of staleFactIds) this.deleteFactFtsStmt.run(id)
      this.db.prepare(`DELETE FROM facts WHERE id IN (${staleFactPlaceholders})`).run(...staleFactIds)
      this.db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'fact' AND entity_id IN (${staleFactPlaceholders})`).run(...staleFactIds)
    }

    const staleTaskIds = this.db.prepare(`
      SELECT id FROM tasks
      WHERE source_episode_id IS NOT NULL
        AND source_episode_id NOT IN (${keepPlaceholders})
    `).all(...keepEpisodeIds).map(row => Number(row.id)).filter(Number.isFinite)
    if (staleTaskIds.length > 0) {
      const staleTaskPlaceholders = staleTaskIds.map(() => '?').join(', ')
      for (const id of staleTaskIds) this.deleteTaskFtsStmt.run(id)
      this.db.prepare(`DELETE FROM tasks WHERE id IN (${staleTaskPlaceholders})`).run(...staleTaskIds)
      this.db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'task' AND entity_id IN (${staleTaskPlaceholders})`).run(...staleTaskIds)
    }

    const staleSignalIds = this.db.prepare(`
      SELECT id FROM signals
      WHERE source_episode_id IS NOT NULL
        AND source_episode_id NOT IN (${keepPlaceholders})
    `).all(...keepEpisodeIds).map(row => Number(row.id)).filter(Number.isFinite)
    if (staleSignalIds.length > 0) {
      const staleSignalPlaceholders = staleSignalIds.map(() => '?').join(', ')
      for (const id of staleSignalIds) this.deleteSignalFtsStmt.run(id)
      this.db.prepare(`DELETE FROM signals WHERE id IN (${staleSignalPlaceholders})`).run(...staleSignalIds)
      this.db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'signal' AND entity_id IN (${staleSignalPlaceholders})`).run(...staleSignalIds)
    }

    const stalePropositionIds = this.db.prepare(`
      SELECT id FROM propositions
      WHERE source_episode_id IS NOT NULL
        AND source_episode_id NOT IN (${keepPlaceholders})
    `).all(...keepEpisodeIds).map(row => Number(row.id)).filter(Number.isFinite)
    if (stalePropositionIds.length > 0) {
      const stalePropositionPlaceholders = stalePropositionIds.map(() => '?').join(', ')
      for (const id of stalePropositionIds) this.deletePropositionFtsStmt.run(id)
      this.db.prepare(`DELETE FROM propositions WHERE id IN (${stalePropositionPlaceholders})`).run(...stalePropositionIds)
      this.db.prepare(`DELETE FROM memory_vectors WHERE entity_type = 'proposition' AND entity_id IN (${stalePropositionPlaceholders})`).run(...stalePropositionIds)
    }

    this.db.prepare(`
      DELETE FROM profiles
      WHERE source_episode_id IS NOT NULL
        AND source_episode_id NOT IN (${keepPlaceholders})
    `).run(...keepEpisodeIds)
  }

  markCandidateIdsConsolidated(candidateIds = []) {
    const ids = [...new Set(candidateIds.map(id => Number(id)).filter(Number.isFinite))]
    if (ids.length === 0) return 0
    const placeholders = ids.map(() => '?').join(', ')
    const stmt = this.db.prepare(`
      UPDATE memory_candidates
      SET status = 'consolidated'
      WHERE status = 'pending'
        AND id IN (${placeholders})
    `)
    const result = stmt.run(...ids)
    return Number(result.changes ?? 0)
  }

  markCandidatesConsolidated(dayKey) {
    return Number(this.db.prepare(`
      UPDATE memory_candidates
      SET status = 'consolidated'
      WHERE day_key = ? AND status = 'pending'
    `).run(dayKey).changes ?? 0)
  }

  upsertDocument(kind, docKey, content) {
    const clean = cleanMemoryText(content)
    if (!clean) return
    this.upsertDocumentStmt.run(kind, docKey, clean)
  }

  upsertProfiles(profiles = [], seenAt = null, sourceEpisodeId = null) {
    for (const profile of profiles) {
      const key = normalizeProfileKey(profile?.key)
      const value = cleanMemoryText(profile?.value)
      const confidence = Number(profile?.confidence ?? 0.6)
      if (!shouldKeepProfileValue(key, value)) continue
      this.upsertProfileStmt.run(key, value, confidence, seenAt, seenAt, sourceEpisodeId)
    }
  }

  projectTaskState(taskId) {
    const events = this.getTaskEventsStmt.all(taskId)
    if (!events.length) return null

    let stage = 'planned'
    let evidenceLevel = 'claimed'
    let status = 'active'
    let bestStageRank = taskStageRank(stage)
    let bestEvidenceRank = taskEvidenceRank(evidenceLevel)

    for (const event of events) {
      const nextStage = normalizeTaskStage(event.stage, event.note ?? '')
      const nextEvidence = normalizeEvidenceLevel(event.evidence_level, event.note ?? '')
      const nextStatus = normalizeTaskStatus(event.status, event.note ?? '')

      const stageRank = taskStageRank(nextStage)
      if (stageRank >= bestStageRank) {
        bestStageRank = stageRank
        stage = nextStage
      }

      const evidenceRank = taskEvidenceRank(nextEvidence)
      if (evidenceRank >= bestEvidenceRank) {
        bestEvidenceRank = evidenceRank
        evidenceLevel = nextEvidence
      }

      status = nextStatus
    }

    if (stage === 'done') status = 'done'
    return { stage, evidenceLevel, status }
  }

  async upsertFacts(facts = [], seenAt = null, sourceEpisodeId = null, options = {}) {
    const deprecateOnHighSimilarity = Boolean(options.deprecateOnHighSimilarity)
    for (const fact of facts) {
      const text = cleanMemoryText(fact?.text)
      const factType = normalizeFactType(fact?.type)
      const confidence = Number(fact?.confidence ?? 0.6)
      if (!text || !factType || !shouldKeepFact(factType, text, confidence)) continue
      const slot = normalizeFactSlot(fact?.slot)
      const workstream = normalizeWorkstream(fact?.workstream)
      const claimKey = deriveClaimKey(factType, slot, text, workstream)

      // Semantic dedup: check if a similar active fact already exists
      const existingExact = this.getFactIdStmt.get(factType, text)
      const existingByKey = !existingExact && claimKey ? this.getFactRowByClaimKeyStmt.get(factType, claimKey) : null
      if (existingByKey?.id) {
        this.updateFactByIdStmt.run(
          slot || null,
          claimKey || null,
          workstream || null,
          text,
          confidence,
          seenAt,
          sourceEpisodeId,
          existingByKey.id,
        )
        this.deleteFactFtsStmt.run(existingByKey.id)
        this.insertFactFtsStmt.run(existingByKey.id, text)
        this.linkMemoryToEntities(text, 'fact', existingByKey.id, sourceEpisodeId)
        this.upsertPropositions([
          {
            subjectKey: fact?.subject_key,
            propositionKind: propositionKindForFact(factType, slot),
            text,
            occurredOn: extractExplicitDate(text),
            confidence,
          },
        ], seenAt, sourceEpisodeId, existingByKey.id)
        if (slot) this.staleFactSlotStmt.run(slot, text)
        continue
      }
      if (!existingExact) {
        const newVector = await embedText(text)
        if (Array.isArray(newVector) && newVector.length > 0) {
          const activeModel = getEmbeddingModelId()
          const samTypeFacts = this.db.prepare(`
            SELECT f.id, f.text, f.confidence, mv.vector_json
            FROM facts f
            JOIN memory_vectors mv ON mv.entity_type = 'fact' AND mv.entity_id = f.id AND mv.model = ?
            WHERE f.fact_type = ? AND f.status = 'active'
          `).all(activeModel, factType)

          let merged = false
          for (const existing of samTypeFacts) {
            try {
              const existingVector = JSON.parse(existing.vector_json)
              const similarity = cosineSimilarity(newVector, existingVector)
              if (similarity >= 0.85) {
                if (deprecateOnHighSimilarity) {
                  // Deprecate mode: mark old fact as deprecated, insert new one below
                  this.db.prepare(`UPDATE facts SET status = 'deprecated', superseded_by = NULL WHERE id = ?`).run(existing.id)
                } else {
                  // Merge: update existing fact if new one has higher confidence, bump mention
                  if (confidence > existing.confidence) {
                    this.db.prepare(`
                      UPDATE facts SET text = ?, confidence = ?, last_seen = ?, source_episode_id = COALESCE(?, source_episode_id), mention_count = mention_count + 1
                      WHERE id = ?
                    `).run(text, confidence, seenAt, sourceEpisodeId, existing.id)
                    this.deleteFactFtsStmt.run(existing.id)
                    this.insertFactFtsStmt.run(existing.id, text)
                  } else {
                    this.db.prepare(`
                      UPDATE facts SET last_seen = ?, mention_count = mention_count + 1
                      WHERE id = ?
                    `).run(seenAt, existing.id)
                  }
                  merged = true
                  break
                }
              }
            } catch { /* ignore parse errors */ }
          }
          if (merged) continue
        }
      }

      this.reviveFactsStmt.run(factType, text)
      this.upsertFactStmt.run(
        factType,
        slot || null,
        claimKey || null,
        workstream || null,
        text,
        confidence,
        seenAt,
        seenAt,
        sourceEpisodeId,
      )
      const row = this.getFactIdStmt.get(factType, text)
      if (row?.id) {
        this.deleteFactFtsStmt.run(row.id)
        this.insertFactFtsStmt.run(row.id, text)
        this.linkMemoryToEntities(text, 'fact', row.id, sourceEpisodeId)
        this.upsertPropositions([
          {
            subjectKey: fact?.subject_key,
            propositionKind: propositionKindForFact(factType, slot),
            text,
            occurredOn: extractExplicitDate(text),
            confidence,
          },
        ], seenAt, sourceEpisodeId, row.id)
      }
      if (slot) {
        this.staleFactSlotStmt.run(slot, text)
      } else if (row?.id) {
        // Contradiction detection for slot-less facts:
        // Reuse existing vectors (no extra embedText call) to find similar facts and supersede
        try {
          const newVecRow = this.getVectorStmt.get('fact', row.id, getEmbeddingModelId())
          if (newVecRow?.vector_json) {
            const newVector = JSON.parse(newVecRow.vector_json)
            const sameFacts = this.db.prepare(`
              SELECT f.id, f.text, mv.vector_json
              FROM facts f
              JOIN memory_vectors mv ON mv.entity_type = 'fact' AND mv.entity_id = f.id AND mv.model = ?
              WHERE f.fact_type = ? AND f.status = 'active' AND f.id != ?
            `).all(getEmbeddingModelId(), factType, row.id)
            for (const old of sameFacts) {
              try {
                const oldVector = JSON.parse(old.vector_json)
                const sim = cosineSimilarity(newVector, oldVector)
                if (sim > 0.75 && old.text !== text) {
                  this.db.prepare(`UPDATE facts SET status = 'superseded', superseded_by = ? WHERE id = ?`).run(row.id, old.id)
                }
              } catch {}
            }
          }
        } catch {}
      }
      const profileKey = profileKeyForFact(factType, text, slot)
      if (profileKey) {
        this.upsertProfileStmt.run(profileKey, text, confidence, seenAt, seenAt, sourceEpisodeId)
      }
    }
    for (const kind of ['decision', 'preference', 'constraint', 'fact']) {
      this.markFactsStaleStmt.run(kind, staleCutoffDays(kind))
    }
  }

  upsertTasks(tasks = [], seenAt = null, sourceEpisodeId = null) {
    for (const task of tasks) {
      const title = cleanMemoryText(task?.title)
      if (!title) continue
      const details = composeTaskDetails(task)
      const workstream = normalizeWorkstream(task?.workstream)
      const taskKey = deriveTaskKey(title, workstream)
      const stage = normalizeTaskStage(task?.stage, details)
      const evidenceLevel = normalizeEvidenceLevel(task?.evidence_level, details)
      const prev = this.getTaskRowByKeyStmt.get(taskKey) ?? this.getTaskRowStmt.get(title)
      if (prev?.id && prev.title && prev.title !== title) {
        this.updateTaskByIdStmt.run(
          title,
          taskKey,
          details || null,
          workstream || null,
          stage,
          evidenceLevel,
          normalizeTaskStatus(task?.status, details),
          normalizeTaskPriority(task?.priority),
          Number(task?.confidence ?? 0.6),
          seenAt,
          sourceEpisodeId,
          prev.id,
        )
        this.deleteTaskFtsStmt.run(prev.id)
        this.insertTaskFtsStmt.run(prev.id, title, details)
        this.linkMemoryToEntities(`${title} ${details ?? ''}`, 'task', prev.id, sourceEpisodeId)
        this.insertTaskEventStmt.run(
          prev.id,
          seenAt,
          'projection_update',
          stage,
          evidenceLevel,
          normalizeTaskStatus(task?.status, details),
          details || null,
          sourceEpisodeId,
        )
        continue
      }
      this.upsertTaskStmt.run(
        title,
        taskKey,
        details || null,
        workstream || null,
        stage,
        evidenceLevel,
        normalizeTaskStatus(task?.status, details),
        normalizeTaskPriority(task?.priority),
        Number(task?.confidence ?? 0.6),
        seenAt,
        seenAt,
        sourceEpisodeId,
      )
      const row = this.getTaskIdStmt.get(title)
      if (row?.id) {
        this.deleteTaskFtsStmt.run(row.id)
        this.insertTaskFtsStmt.run(row.id, title, details)
        this.linkMemoryToEntities(`${title} ${details ?? ''}`, 'task', row.id, sourceEpisodeId)
        const changed =
          !prev ||
          prev.status !== normalizeTaskStatus(task?.status, details) ||
          prev.stage !== stage ||
          prev.evidence_level !== evidenceLevel
        if (changed) {
          this.insertTaskEventStmt.run(
            row.id,
            seenAt ?? new Date().toISOString(),
            prev ? 'state_update' : 'task_created',
            stage,
            evidenceLevel,
            normalizeTaskStatus(task?.status, details),
            details || null,
            sourceEpisodeId,
          )
          const projected = this.projectTaskState(row.id)
          if (projected) {
            this.updateTaskProjectionStmt.run(projected.stage, projected.evidenceLevel, projected.status, row.id)
          }
        }
      }
    }
    this.markTasksStaleStmt.run()
  }

  replaceInterests(interests = []) {
    this.clearInterestsStmt.run()
    for (const item of interests) {
      if (!item?.name) continue
      this.insertInterestStmt.run(
        String(item.name).trim(),
        Number(item.score ?? item.count ?? 1),
        Number(item.count ?? Math.max(1, Math.round(Number(item.score ?? 1) * 10))),
        item.last_seen ?? item.last ?? null,
      )
    }
  }

  upsertSignals(signals = [], sourceEpisodeId = null, seenAt = null) {
    const seenKeys = new Set()
    for (const signal of signals) {
      if (!signal?.kind || !signal?.value) continue
      const kind = normalizeSignalKind(signal.kind)
      const value = String(signal.value).trim()
      const normalizedValue = cleanMemoryText(value)
      const score = Number(signal.score ?? 0.5)
      if (!shouldKeepSignal(kind, normalizedValue, score)) continue
      if (!normalizedValue) continue
      const dedupeKey = `${kind}:${normalizedValue.toLowerCase()}`
      if (seenKeys.has(dedupeKey)) continue
      seenKeys.add(dedupeKey)
      this.upsertSignalStmt.run(
        kind,
        normalizedValue,
        score,
        seenAt,
        seenAt,
        sourceEpisodeId,
      )
      const row = this.getSignalIdStmt.get(kind, normalizedValue)
      if (row?.id) {
        this.deleteSignalFtsStmt.run(row.id)
        this.insertSignalFtsStmt.run(row.id, kind, normalizedValue)
      }
      const profileKey = profileKeyForSignal(kind, normalizedValue)
      if (profileKey) {
        this.upsertProfileStmt.run(profileKey, normalizedValue, score, seenAt, seenAt, sourceEpisodeId)
      }
    }
  }

  upsertEntities(entities = [], seenAt = null, sourceEpisodeId = null) {
    for (const entity of entities) {
      const name = cleanMemoryText(entity?.name)
      const entityType = String(entity?.type ?? 'thing').toLowerCase().trim()
      const description = cleanMemoryText(entity?.description ?? '')
      if (!name || name.length < 2) continue
      try {
        this.db.prepare(`
          INSERT INTO entities (name, entity_type, description, first_seen, last_seen, source_episode_id)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(name, entity_type) DO UPDATE SET
            description = COALESCE(excluded.description, entities.description),
            last_seen = excluded.last_seen,
            source_episode_id = COALESCE(excluded.source_episode_id, entities.source_episode_id)
        `).run(name, entityType, description || null, seenAt, seenAt, sourceEpisodeId)
      } catch {}
    }
  }

  upsertRelations(relations = [], seenAt = null, sourceEpisodeId = null) {
    for (const rel of relations) {
      const sourceName = cleanMemoryText(rel?.source)
      const targetName = cleanMemoryText(rel?.target)
      const relType = String(rel?.type ?? 'related_to').toLowerCase().trim()
      const description = cleanMemoryText(rel?.description ?? '')
      const confidence = Number(rel?.confidence ?? 0.7)
      if (!sourceName || !targetName || sourceName.length < 2 || targetName.length < 2) continue
      try {
        const sourceEntity = this.db.prepare('SELECT id FROM entities WHERE name = ?').get(sourceName)
        const targetEntity = this.db.prepare('SELECT id FROM entities WHERE name = ?').get(targetName)
        if (!sourceEntity || !targetEntity) continue
        this.db.prepare(`
          INSERT INTO relations (source_entity_id, target_entity_id, relation_type, description, confidence, first_seen, last_seen, source_episode_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(source_entity_id, target_entity_id, relation_type) DO UPDATE SET
            description = COALESCE(excluded.description, relations.description),
            confidence = MAX(relations.confidence, excluded.confidence),
            last_seen = excluded.last_seen,
            source_episode_id = COALESCE(excluded.source_episode_id, relations.source_episode_id)
        `).run(sourceEntity.id, targetEntity.id, relType, description || null, confidence, seenAt, seenAt, sourceEpisodeId)
      } catch {}
    }
  }

  getEntityGraph(entityName) {
    const entity = this.db.prepare('SELECT * FROM entities WHERE name = ?').get(entityName)
    if (!entity) return null
    const outgoing = this.db.prepare(`
      SELECT r.relation_type, e.name AS target, e.entity_type AS target_type, r.description, r.confidence
      FROM relations r JOIN entities e ON e.id = r.target_entity_id
      WHERE r.source_entity_id = ? AND r.status = 'active'
    `).all(entity.id)
    const incoming = this.db.prepare(`
      SELECT r.relation_type, e.name AS source, e.entity_type AS source_type, r.description, r.confidence
      FROM relations r JOIN entities e ON e.id = r.source_entity_id
      WHERE r.target_entity_id = ? AND r.status = 'active'
    `).all(entity.id)
    return { entity, outgoing, incoming }
  }

  syncHistoryFromFiles() {
    ensureDir(this.historyDir)

    for (const docKey of ['identity', 'ongoing', 'context']) {
      const filePath = join(this.historyDir, `${docKey}.md`)
      if (!existsSync(filePath)) continue
      this.upsertDocument(docKey, docKey, readFileSync(filePath, 'utf8'))
    }

    const interestsPath = join(this.historyDir, 'interests.json')
    if (existsSync(interestsPath)) {
      try {
        const parsed = JSON.parse(readFileSync(interestsPath, 'utf8'))
        const items = Object.entries(parsed).map(([name, value]) => ({
          name,
          score: typeof value?.count === 'number' ? value.count : 1,
          count: typeof value?.count === 'number' ? value.count : 1,
          last_seen: value?.last ?? null,
        }))
        this.replaceInterests(items)
      } catch { /* ignore malformed interests */ }
    }
  }

  backfillProject(workspacePath, options = {}) {
    const limit = Number(options.limit ?? 50)
    const projectDir = join(homedir(), '.claude', 'projects', workspaceToProjectSlug(workspacePath))
    if (!existsSync(projectDir)) return 0
    const files = readdirSync(projectDir)
      .filter(file => file.endsWith('.jsonl') && !file.startsWith('agent-'))
      .map(file => ({
        path: join(projectDir, file),
        mtime: statSync(join(projectDir, file)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit)
      .map(item => item.path)
      .reverse()
    return this.ingestTranscriptFiles(files)
  }

  buildContextText() {
    const parts = []

    // ## Bot — bot.md + tone/style signals
    const botMdPath = join(this.dataDir, 'bot.md')
    let botContent = ''
    try { botContent = readFileSync(botMdPath, 'utf8').trim() } catch {}
    const toneSignals = this.db.prepare(`
      SELECT kind, value, score FROM signals
      WHERE kind IN ('tone', 'response_style', 'personality') AND status = 'active'
      ORDER BY score DESC LIMIT 3
    `).all()
    if (botContent || toneSignals.length) {
      parts.push('## Bot')
      if (botContent) parts.push(botContent)
      if (toneSignals.length) {
        const seen = new Set()
        const dedupedSignals = toneSignals.filter(s => {
          if (seen.has(s.kind)) return false
          seen.add(s.kind)
          return true
        })
        parts.push(dedupedSignals.map(s => `- ${s.kind}: ${s.value}`).join('\n'))
      }
    }

    // ## User — profiles DB
    const profiles = this.db.prepare(`
      SELECT key, value, confidence FROM profiles
      WHERE status = 'active'
      ORDER BY confidence DESC LIMIT 10
    `).all().filter(profile => shouldKeepProfileValue(profile.key, profile.value))
    if (profiles.length) {
      parts.push(`## User\n${profiles.map(p => `- ${p.key}: ${p.value}`).join('\n')}`)
    }

    // ## Core Memory — preference/constraint facts
    const coreFacts = this.db.prepare(`
      SELECT fact_type, text
      FROM facts
      WHERE status = 'active'
        AND fact_type IN ('preference', 'constraint')
      ORDER BY confidence DESC, retrieval_count DESC, mention_count DESC, last_seen DESC
      LIMIT 6
    `).all()
    if (coreFacts.length > 0) {
      parts.push(`## Core Memory\n${coreFacts.map(item => `- [${item.fact_type}] ${item.text}`).join('\n')}`)
    }

    // ## Decisions — decision/fact facts
    const durableFacts = this.db.prepare(`
      SELECT fact_type, text
      FROM facts
      WHERE status = 'active'
        AND fact_type IN ('decision', 'fact')
      ORDER BY confidence DESC, retrieval_count DESC, mention_count DESC, last_seen DESC
      LIMIT 6
    `).all()
    if (durableFacts.length > 0) {
      const grouped = new Map()
      for (const row of durableFacts) {
        const bucket = grouped.get(row.fact_type) ?? []
        bucket.push(row)
        grouped.set(row.fact_type, bucket)
      }
      const lines = []
      for (const [factType, values] of grouped.entries()) {
        const label = factType[0].toUpperCase() + factType.slice(1)
        lines.push(`### ${label}\n${values.map(value => `- ${value.text}`).join('\n')}`)
      }
      parts.push(`## Decisions\n${lines.join('\n\n')}`)
    }

    // ## Ongoing — active tasks
    const tasks = this.db.prepare(`
      SELECT title, details, status, priority, confidence, last_seen, retrieval_count, stage, evidence_level
      FROM tasks
      WHERE status IN ('active', 'in_progress', 'paused')
      ORDER BY
        CASE priority WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
        retrieval_count DESC,
        last_seen DESC
      LIMIT 8
    `).all()
    if (tasks.length > 0) {
      const lines = tasks.map(task => {
        const detail = task.details ? ` — ${task.details}` : ''
        return `- [${task.status}/${task.stage}/${task.evidence_level}] ${task.title}${detail}`
      })
      parts.push(`## Ongoing\n${lines.join('\n')}`)
    } else {
      const ongoing = this.db.prepare(`
        SELECT content FROM documents WHERE kind = 'ongoing' AND doc_key = 'ongoing'
      `).get()
      if (ongoing?.content) parts.push(`## Ongoing\n${ongoing.content}`)
    }

    // ## Signals — top signals with decay
    const signals = this.db.prepare(`
      SELECT kind, value, score, last_seen, retrieval_count
      FROM signals
      WHERE status = 'active'
      ORDER BY score DESC, retrieval_count DESC, last_seen DESC
      LIMIT 8
    `).all()
    const activeSignals = signals
      .filter(s => !['tone', 'response_style', 'personality'].includes(s.kind))
      .map(item => ({
        ...item,
        effectiveScore: decaySignalScore(item.score, item.last_seen, item.kind),
      }))
      .filter(item => item.effectiveScore >= 0.35)
      .filter((item, index, arr) => arr.findIndex(candidate => candidate.kind === item.kind) === index)
      .slice(0, 5)
    if (activeSignals.length > 0) {
      parts.push(`## Signals\n${activeSignals.map(item => `- [${item.kind}] ${item.value}`).join('\n')}`)
    }

    // ## Recent — direct recent episode slices first, stored summaries only as fallback/supplement
    const recentSections = []
    const recentSectionKeys = new Set()
    const recentRows = this.db.prepare(`
      SELECT day_key, ts, role, content
      FROM episodes
      WHERE kind = 'message'
        AND content NOT LIKE 'You are consolidating%'
        AND content NOT LIKE 'You are improving%'
        AND content NOT LIKE 'You are analyzing%'
      ORDER BY day_key DESC, ts ASC, id ASC
      LIMIT 40
    `).all()
    const grouped = new Map()
    for (const row of recentRows) {
      const dayKey = String(row.day_key ?? '').trim()
      if (!dayKey) continue
      if (!grouped.has(dayKey) && grouped.size >= 2) continue
      const bucket = grouped.get(dayKey) ?? []
      bucket.push(row)
      grouped.set(dayKey, bucket)
    }
    for (const [dayKey, rows] of Array.from(grouped.entries())) {
      const lines = rows
        .slice(-4)
        .map(row => `- ${row.role === 'user' ? 'u' : 'a'}: ${cleanMemoryText(row.content).slice(0, 180)}`)
      if (lines.length === 0) continue
      recentSections.push(`### ${dayKey}\n${lines.join('\n')}`)
      recentSectionKeys.add(dayKey)
    }
    if (recentSections.length < 2) {
      const dailyDocs = this.db.prepare(`
        SELECT doc_key, content
        FROM documents
        WHERE kind = 'daily'
        ORDER BY doc_key DESC
        LIMIT 2
      `).all()
      for (const row of dailyDocs) {
        const docKey = String(row.doc_key ?? '').trim()
        const content = String(row.content ?? '').trim()
        if (!docKey || !content || recentSectionKeys.has(docKey)) continue
        recentSections.push(`### ${docKey}\n${content}`)
        recentSectionKeys.add(docKey)
        if (recentSections.length >= 2) break
      }
    }
    if (recentSections.length < 2) {
      const dailyDir = join(this.historyDir, 'daily')
      if (existsSync(dailyDir)) {
        const files = readdirSync(dailyDir)
          .filter(name => name.endsWith('.md'))
          .sort()
          .slice(-2)
          .reverse()
        for (const name of files) {
          const docKey = name.replace(/\.md$/, '')
          if (recentSectionKeys.has(docKey)) continue
          try {
            const content = readFileSync(join(dailyDir, name), 'utf8').trim()
            if (!content) continue
            recentSections.push(`### ${docKey}\n${content}`)
            recentSectionKeys.add(docKey)
            if (recentSections.length >= 2) break
          } catch { /* ignore unreadable summary */ }
        }
      }
    }
    if (recentSections.length > 0) {
      parts.push(`## Recent\n${recentSections.join('\n\n')}`)
    }

    // Fallback — all sections empty → recent dialogues
    if (parts.length === 0) {
      const recentEpisodes = this.db.prepare(`
        SELECT DISTINCT role, content
        FROM episodes
        WHERE kind = 'message'
        ORDER BY ts DESC, id DESC
        LIMIT 12
      `).all().reverse()
      if (recentEpisodes.length > 0) {
        const body = recentEpisodes
          .map(row => `${row.role === 'user' ? 'u' : 'a'}: ${row.content}`)
          .join('\n')
        parts.push(`## Recent Dialogues\n${body}`)
      }
    }

    return parts.join('\n\n').trim()
  }

  writeContextFile() {
    const contextPath = join(this.historyDir, 'context.md')
    ensureDir(this.historyDir)
    const content = this.buildContextText()
    writeFileSync(contextPath, `<!-- Auto-generated by memory store -->\n\n${content}\n`)
    return contextPath
  }

  async warmupEmbeddings() {
    await warmupEmbeddingProvider()
  }

  getEmbeddableItems(options = {}) {
    const perTypeLimit = options.all
      ? 1000000000
      : Math.max(1, Number(options.perTypeLimit ?? 64))
    const items = []

    const factRows = this.db.prepare(`
      SELECT id, fact_type AS subtype, slot, workstream, text AS content
      FROM facts
      WHERE status = 'active'
      ORDER BY last_seen DESC, id DESC
      LIMIT ?
    `).all(perTypeLimit)
    for (const row of factRows) {
      items.push({
        key: embeddingItemKey('fact', row.id),
        entityType: 'fact',
        entityId: row.id,
        subtype: row.subtype,
        slot: row.slot,
        workstream: row.workstream,
        content: row.content,
      })
    }

    const taskRows = this.db.prepare(`
      SELECT id, status, priority, stage, evidence_level, workstream,
             trim(title || CASE WHEN details IS NOT NULL AND details != '' THEN ' — ' || details ELSE '' END) AS content
      FROM tasks
      WHERE status IN ('active', 'in_progress', 'paused')
      ORDER BY last_seen DESC, id DESC
      LIMIT ?
    `).all(perTypeLimit)
    for (const row of taskRows) {
      items.push({
        key: embeddingItemKey('task', row.id),
        entityType: 'task',
        entityId: row.id,
        status: row.status,
        priority: row.priority,
        stage: row.stage,
        evidenceLevel: row.evidence_level,
        workstream: row.workstream,
        content: row.content,
      })
    }

    const signalRows = this.db.prepare(`
      SELECT id, kind AS subtype, value AS content
      FROM signals
      ORDER BY last_seen DESC, id DESC
      LIMIT ?
    `).all(Math.max(8, Math.floor(perTypeLimit * 0.75)))
    for (const row of signalRows) {
      items.push({
        key: embeddingItemKey('signal', row.id),
        entityType: 'signal',
        entityId: row.id,
        subtype: row.subtype,
        content: row.content,
      })
    }

    const propositionRows = this.db.prepare(`
      SELECT id, proposition_kind AS subtype, text AS content
      FROM propositions
      WHERE status = 'active'
      ORDER BY last_seen DESC, id DESC
      LIMIT ?
    `).all(Math.max(8, Math.floor(perTypeLimit * 0.75)))
    for (const row of propositionRows) {
      items.push({
        key: embeddingItemKey('proposition', row.id),
        entityType: 'proposition',
        entityId: row.id,
        subtype: row.subtype,
        content: row.content,
      })
    }

    const episodeLimit = Math.max(8, Math.floor(perTypeLimit / 2))
    const episodeRows = this.db.prepare(`
      SELECT id, role AS subtype, day_key AS ref, content
      FROM episodes
      WHERE role = 'user'
        AND kind NOT IN ('schedule-inject', 'event-inject')
        AND LENGTH(content) BETWEEN 10 AND 500
        AND content NOT LIKE 'You are consolidating%'
        AND content NOT LIKE 'You are improving%'
        AND content NOT LIKE 'Answer using live%'
        AND content NOT LIKE 'Use the ai_search%'
        AND content NOT LIKE 'Say only%'
        AND ts >= datetime('now', '-7 days')
      ORDER BY ts DESC, id DESC
      LIMIT ?
    `).all(episodeLimit)
    for (const row of episodeRows) {
      items.push({
        key: embeddingItemKey('episode', row.id),
        entityType: 'episode',
        entityId: row.id,
        subtype: row.subtype,
        ref: row.ref,
        content: row.content,
      })
    }

    return items
  }

  async ensureEmbeddings(options = {}) {
    const candidates = this.getEmbeddableItems(options)
    const contextMap = options.contextMap instanceof Map ? options.contextMap : new Map()

    let updated = 0
    for (const item of candidates) {
      const lookupModel = getEmbeddingModelId()
      const contextText = contextMap.get(item.key)
      const embedInput = contextText
        ? cleanMemoryText(`${contextText}\n${item.content}`)
        : contextualizeEmbeddingInput(item)
      if (!embedInput) continue
      const contentHash = hashEmbeddingInput(embedInput)
      const existing = this.getVectorStmt.get(item.entityType, item.entityId, lookupModel)
      if (existing?.content_hash === contentHash) continue
      const vector = await embedText(embedInput)
      if (!Array.isArray(vector) || vector.length === 0) continue
      const activeModel = getEmbeddingModelId()
      this.upsertVectorStmt.run(
        item.entityType,
        item.entityId,
        activeModel,
        vector.length,
        JSON.stringify(vector),
        contentHash,
      )
      this._syncToVecTable(item.entityType, item.entityId, vector)
      this.noteVectorWrite(activeModel, vector.length)
      updated += 1
    }
    this._pruneOldEpisodeVectors()
    return updated
  }

  _syncToVecTable(entityType, entityId, vector) {
    if (!this.vecEnabled) return
    const rowid = this._vecRowId(entityType, entityId)
    try {
      const hex = vecToHex(vector)
      this.db.exec(`INSERT OR REPLACE INTO vec_memory(rowid, embedding) VALUES (${rowid}, X'${hex}')`)
    } catch { /* ignore */ }
  }

  _vecRowId(entityType, entityId) {
    // Pack entity type + id into a single integer rowid
    const typePrefix = { fact: 1, task: 2, signal: 3, episode: 4, proposition: 5 }
    return (typePrefix[entityType] ?? 9) * 10000000 + Number(entityId)
  }

  _vecRowToEntity(rowid) {
    const typeMap = { 1: 'fact', 2: 'task', 3: 'signal', 4: 'episode', 5: 'proposition' }
    const typeNum = Math.floor(rowid / 10000000)
    return { entityType: typeMap[typeNum] ?? 'unknown', entityId: rowid % 10000000 }
  }

  _pruneOldEpisodeVectors() {
    // TTL: remove episode vectors older than 30 days
    try {
      const cutoff = this.db.prepare(`
        SELECT id FROM episodes
        WHERE ts < datetime('now', '-30 days')
          AND id IN (SELECT entity_id FROM memory_vectors WHERE entity_type = 'episode')
      `).all()
      for (const { id } of cutoff) {
        this.db.prepare('DELETE FROM memory_vectors WHERE entity_type = ? AND entity_id = ?').run('episode', id)
        if (this.vecEnabled) {
          const rowid = this._vecRowId('episode', id)
          try { this.db.exec(`DELETE FROM vec_memory WHERE rowid = ${rowid}`) } catch {}
        }
      }
      if (cutoff.length > 0) {
        process.stderr.write(`[memory] pruned ${cutoff.length} old episode vectors\n`)
      }
    } catch { /* ignore */ }
  }

  async classifyQueryIntent(query, queryVector = null) {
    const clean = cleanMemoryText(query)
    if (!clean) {
      return {
        primary: 'decision',
        scores: { profile: 0, task: 0, decision: 0, policy: 0, security: 0, event: 0, history: 0 },
      }
    }

    const vector = queryVector ?? await embedText(clean)
    const prototypeVectors = await getIntentPrototypeVectors()
    const scores = {
      profile: 0,
      task: 0,
      decision: 0,
      policy: 0,
      security: 0,
      event: 0,
      history: 0,
    }

    for (const [intent, vectors] of prototypeVectors.entries()) {
      let best = 0
      for (const candidate of vectors) {
        best = Math.max(best, cosineSimilarity(vector, candidate))
      }
      scores[intent] = best
    }

    applyLexicalIntentHints(clean, scores)
    const scopedEntities = this.resolveQueryEntityScope(clean)
    if (scopedEntities.length >= 2) {
      scores.decision = Number((scores.decision + 0.34).toFixed(4))
      scores.profile = Math.max(0, scores.profile - 0.12)
      scores.security = Math.max(0, scores.security - 0.1)
      scores.task = Math.max(0, scores.task - 0.08)
    } else if (scopedEntities.length === 1 && isRelationQuery(clean)) {
      scores.decision = Number((scores.decision + 0.18).toFixed(4))
      scores.profile = Math.max(0, scores.profile - 0.08)
      scores.security = Math.max(0, scores.security - 0.08)
    }

    const temporal = parseTemporalHint(clean)
    if (temporal) {
      scores.event += 0.28
      scores.history += 0.14
    }

    const primary = Object.entries(scores)
      .sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'decision'

    return { primary, scores }
  }

  async buildRecentFocusVector(options = {}) {
    const maxEpisodes = Math.max(1, Number(options.maxEpisodes ?? 8))
    const sinceDays = Math.max(1, Number(options.sinceDays ?? 3))
    const channelId = String(options.channelId ?? '').trim()
    const userId = String(options.userId ?? '').trim()
    let rows = []

    if (channelId) {
      rows = this.db.prepare(`
        SELECT id, content
        FROM episodes
        WHERE role = 'user'
          AND kind NOT IN ('schedule-inject', 'event-inject')
          AND channel_id = ?
          AND ts >= datetime('now', ?)
        ORDER BY ts DESC, id DESC
        LIMIT ?
      `).all(channelId, `-${sinceDays} days`, maxEpisodes)
    }

    if (rows.length === 0 && userId) {
      rows = this.db.prepare(`
        SELECT id, content
        FROM episodes
        WHERE role = 'user'
          AND kind NOT IN ('schedule-inject', 'event-inject')
          AND user_id = ?
          AND ts >= datetime('now', ?)
        ORDER BY ts DESC, id DESC
        LIMIT ?
      `).all(userId, `-${sinceDays} days`, maxEpisodes)
    }

    if (rows.length === 0) {
      rows = this.db.prepare(`
        SELECT id, content
        FROM episodes
        WHERE role = 'user'
          AND kind NOT IN ('schedule-inject', 'event-inject')
          AND ts >= datetime('now', ?)
        ORDER BY ts DESC, id DESC
        LIMIT ?
      `).all(`-${sinceDays} days`, maxEpisodes)
    }

    if (rows.length === 0) return []
    const vectors = await Promise.all(
      rows.map(row => this.getStoredVector('episode', row.id, cleanMemoryText(row.content))),
    )
    return averageVectors(vectors)
  }

  async rankIntentSeedItems(rows, query = '', queryVector = null, options = {}) {
    if (!rows.length) return []
    const vector = query ? (queryVector ?? await embedText(query)) : null
    const tokens = new Set(tokenizeMemoryText(query))
    const minSimilarity = Number(options.minSimilarity ?? 0)

    const scored = await Promise.all(rows.map(async row => {
      const content = cleanMemoryText(row.content ?? '')
      const contentTokens = tokenizeMemoryText(`${row.subtype ?? ''} ${content}`)
      const overlapCount = contentTokens.reduce((count, token) => count + (tokens.has(token) ? 1 : 0), 0)
      const entityType = row.type ?? 'fact'
      const entityId = Number(row.entity_id ?? 0)
      const rowVector = (vector && entityId > 0)
        ? await this.getStoredVector(entityType, entityId, `${row.subtype ?? ''} ${content}`)
        : (vector ? await embedText(String(`${row.subtype ?? ''} ${content}`).slice(0, 320)) : [])
      const semanticSimilarity = vector
        ? cosineSimilarity(vector, rowVector)
        : 0
      return {
        ...row,
        semanticSimilarity,
        overlapCount,
        seedRank: semanticSimilarity * 4 + overlapCount * 2 + Number(row.quality_score ?? 0.5),
      }
    }))

    return scored
      .filter(item => item.overlapCount > 0 || item.semanticSimilarity >= minSimilarity || minSimilarity <= 0)
      .sort((a, b) => Number(b.seedRank) - Number(a.seedRank))
  }

  async getSeedResultsForIntent(intent, query = '', queryVector = null, limit = 4) {
    const seedLimit = Math.max(1, Number(limit))
    const candidatePool = Math.max(seedLimit * 6, 18)
    const includeDoneTasks = isDoneTaskQuery(query)
    const preferDirectRelation = isRelationQuery(query) && !(/\b(weakness|problem|issue)\b/.test(query.toLowerCase()) || /약점|문제/.test(query))
    const directRows = []
    if (query && preferDirectRelation) {
      try {
        const tokens = propositionSubjectTokens(query).slice(0, 6)
        const likePatterns = tokens.map(token => `%${token}%`)
        const hasTokenSearch = likePatterns.length > 0
        directRows.push(...this.db.prepare(`
          SELECT 'entity' AS type, entity_type AS subtype, CAST(id AS TEXT) AS ref, name AS content,
                 unixepoch(last_seen) AS updated_at, id AS entity_id, 0.8 AS quality_score, 0 AS retrieval_count
          FROM entities
          WHERE ${hasTokenSearch ? likePatterns.map(() => `(name LIKE ? OR COALESCE(description, '') LIKE ?)`).join(' OR ') : '1 = 0'}
          ORDER BY last_seen DESC, id DESC
          LIMIT ?
        `).all(...likePatterns.flatMap(pattern => [pattern, pattern]), Math.max(4, seedLimit * 2)))
        directRows.push(...this.db.prepare(`
          SELECT 'relation' AS type, relation_type AS subtype, CAST(r.id AS TEXT) AS ref,
                 trim(se.name || ' -> ' || te.name || CASE WHEN r.description IS NOT NULL AND r.description != '' THEN ' — ' || r.description ELSE '' END) AS content,
                 unixepoch(r.last_seen) AS updated_at, r.id AS entity_id, r.confidence AS quality_score, 0 AS retrieval_count
          FROM relations r
          JOIN entities se ON se.id = r.source_entity_id
          JOIN entities te ON te.id = r.target_entity_id
          WHERE ${hasTokenSearch ? likePatterns.map(() => `(se.name LIKE ? OR te.name LIKE ? OR r.relation_type LIKE ? OR COALESCE(r.description, '') LIKE ?)`).join(' OR ') : '1 = 0'}
          ORDER BY r.confidence DESC, r.last_seen DESC
          LIMIT ?
        `).all(...likePatterns.flatMap(pattern => [pattern, pattern, pattern, pattern]), Math.max(4, seedLimit * 2)))
      } catch { /* ignore */ }
    }
    if (intent === 'profile') {
      const profiles = this.db.prepare(`
        SELECT 'profile' AS type, key AS subtype, key || ': ' || value AS content,
               unixepoch(last_seen) AS updated_at, 0 AS entity_id,
               confidence AS quality_score, retrieval_count
        FROM profiles
        WHERE status = 'active'
        ORDER BY confidence DESC, mention_count DESC, last_seen DESC
        LIMIT ?
      `).all(Math.max(6, seedLimit * 2))
      const facts = this.db.prepare(`
        SELECT 'fact' AS type, fact_type AS subtype, CAST(id AS TEXT) AS ref, text AS content,
               unixepoch(last_seen) AS updated_at, id AS entity_id,
               confidence AS quality_score, retrieval_count
        FROM facts
        WHERE status = 'active'
          AND fact_type IN ('preference', 'constraint')
        ORDER BY confidence DESC, retrieval_count DESC, mention_count DESC, last_seen DESC
        LIMIT ?
      `).all(candidatePool)
      const signals = this.db.prepare(`
        SELECT 'signal' AS type, kind AS subtype, CAST(id AS TEXT) AS ref, value AS content,
               unixepoch(last_seen) AS updated_at, id AS entity_id,
               score AS quality_score, retrieval_count
        FROM signals
        WHERE kind IN ('language', 'tone')
        ORDER BY score DESC, retrieval_count DESC, last_seen DESC
        LIMIT ?
      `).all(Math.max(4, seedLimit * 2))
      const propositions = this.db.prepare(`
        SELECT 'proposition' AS type, proposition_kind AS subtype, CAST(id AS TEXT) AS ref, text AS content,
               unixepoch(last_seen) AS updated_at, id AS entity_id, confidence AS quality_score, retrieval_count, source_fact_id
        FROM propositions
        WHERE status = 'active'
        ORDER BY confidence DESC, retrieval_count DESC, last_seen DESC
        LIMIT ?
      `).all(Math.max(4, seedLimit * 2))
      const ranked = await this.rankIntentSeedItems([...profiles, ...facts, ...signals, ...propositions, ...directRows], query, queryVector, { minSimilarity: 0.18 })
      return ranked.slice(0, seedLimit).map(item => ({ ...item, score: -9.2 }))
    }

    if (intent === 'task') {
      const tasks = this.db.prepare(`
        SELECT 'task' AS type, status AS subtype, CAST(id AS TEXT) AS ref,
               trim(title || CASE WHEN details IS NOT NULL AND details != '' THEN ' — ' || details ELSE '' END) AS content,
               unixepoch(last_seen) AS updated_at, id AS entity_id,
               confidence AS quality_score, retrieval_count
        FROM tasks
        WHERE status IN (${includeDoneTasks ? "'active', 'in_progress', 'paused', 'done'" : "'active', 'in_progress', 'paused'"})
        ORDER BY
          CASE
            WHEN ${includeDoneTasks ? "status = 'done'" : "0"} THEN 0
            WHEN priority = 'high' THEN 1
            WHEN priority = 'normal' THEN 2
            ELSE 3
          END,
          retrieval_count DESC,
          last_seen DESC
        LIMIT ?
      `).all(candidatePool)
      const ranked = await this.rankIntentSeedItems(tasks, query, queryVector, { minSimilarity: 0.12 })
      const ordered =
        includeDoneTasks
          ? [
              ...tasks.filter(item => item.subtype === 'done'),
              ...(ranked.length > 0 ? ranked : tasks),
            ]
          : (ranked.length > 0 ? ranked : tasks)
      return ordered
        .filter((item, index, arr) => arr.findIndex(candidate => `${candidate.type}:${candidate.entity_id}` === `${item.type}:${item.entity_id}`) === index)
        .slice(0, seedLimit)
        .map(item => ({ ...item, score: -9.1 }))
    }

    if (intent === 'decision' || intent === 'policy' || intent === 'security') {
      const facts = this.db.prepare(`
        SELECT 'fact' AS type, fact_type AS subtype, CAST(id AS TEXT) AS ref, text AS content,
               unixepoch(last_seen) AS updated_at, id AS entity_id,
               confidence AS quality_score, retrieval_count
        FROM facts
        WHERE status = 'active'
          AND fact_type IN ('decision', 'constraint')
        ORDER BY confidence DESC, retrieval_count DESC, mention_count DESC, last_seen DESC
        LIMIT ?
      `).all(candidatePool)
      const propositions = this.db.prepare(`
        SELECT 'proposition' AS type, proposition_kind AS subtype, CAST(id AS TEXT) AS ref, text AS content,
               unixepoch(last_seen) AS updated_at, id AS entity_id, confidence AS quality_score, retrieval_count, source_fact_id
        FROM propositions
        WHERE status = 'active'
        ORDER BY confidence DESC, retrieval_count DESC, last_seen DESC
        LIMIT ?
      `).all(candidatePool)
      const ranked = await this.rankIntentSeedItems([...facts, ...propositions, ...directRows], query, queryVector, { minSimilarity: 0.14 })
      return (ranked.length > 0 ? ranked : facts).slice(0, seedLimit).map(item => ({ ...item, score: -9.1 }))
    }

    if (intent === 'event' || intent === 'history') {
      const episodes = this.db.prepare(`
        SELECT 'episode' AS type, role AS subtype, CAST(id AS TEXT) AS ref, content,
               created_at AS updated_at, id AS entity_id, 0 AS retrieval_count
        FROM episodes
        WHERE role = 'user'
          AND kind NOT IN ('schedule-inject', 'event-inject')
          AND content NOT LIKE 'You are consolidating%'
          AND content NOT LIKE 'You are improving%'
          AND LENGTH(content) >= 10
        ORDER BY ts DESC
        LIMIT ?
      `).all(Math.max(candidatePool, seedLimit + 8))
      const propositions = this.db.prepare(`
        SELECT 'proposition' AS type, proposition_kind AS subtype, CAST(id AS TEXT) AS ref, text AS content,
               unixepoch(last_seen) AS updated_at, id AS entity_id, confidence AS quality_score, retrieval_count, source_fact_id
        FROM propositions
        WHERE status = 'active'
        ORDER BY last_seen DESC, retrieval_count DESC
        LIMIT ?
      `).all(Math.max(8, seedLimit * 3))
      const ranked = await this.rankIntentSeedItems([...episodes, ...propositions, ...directRows], query, queryVector, { minSimilarity: intent === 'event' ? 0.04 : 0.08 })
      return (ranked.length > 0 ? ranked : episodes).slice(0, seedLimit).map(item => ({ ...item, score: -8.0 }))
    }

    return []
  }

  searchRelevant(query, limit = 8) {
    const clean = cleanMemoryText(query)
    if (!clean) return []
    return this.combineRetrievalResults(clean, this.searchRelevantSparse(clean, limit * 2), [], limit)
  }

  async searchRelevantHybrid(query, limit = 8, options = {}) {
    const clean = cleanMemoryText(query)
    if (!clean) return []
    const queryVector = options.queryVector ?? await embedText(clean)
    const intent = options.intent ?? await this.classifyQueryIntent(clean, queryVector)
    const focusVector = options.focusVector ?? await this.buildRecentFocusVector({
      channelId: options.channelId,
      userId: options.userId,
    })
    const temporal = parseTemporalHint(clean)
    const queryEntities = options.queryEntities ?? this.resolveQueryEntityScope(clean)
    const dense = await this.searchRelevantDense(clean, limit * 2, queryVector, focusVector)
    const seeded = await this.getSeedResultsForIntent(intent.primary, clean, queryVector, Math.min(4, limit))
    const entityScoped = this.getEntityScopedResults(queryEntities, Math.min(6, limit * 2))
    const ruleScoped = this.getRuleScopedResults(clean, Math.min(5, limit * 2))
    const sparse = [...entityScoped, ...ruleScoped, ...seeded, ...this.searchRelevantSparse(clean, limit * 2)]

    // Temporal search: add date-matching episodes (deduplicated)
    if (temporal) {
      const seen = new Set(sparse.map(r => `${r.type}:${r.entity_id}`))
      try {
        const temporalEpisodes = this.db.prepare(`
          SELECT 'episode' AS type, role AS subtype, CAST(id AS TEXT) AS ref, content,
                 ? AS score, created_at AS updated_at, id AS entity_id, 0 AS retrieval_count
          FROM episodes
          WHERE day_key >= ? AND day_key <= ?
            AND role = 'user'
            AND kind NOT IN ('schedule-inject', 'event-inject')
            AND content NOT LIKE 'You are consolidating%'
            AND LENGTH(content) >= 10
          ORDER BY ts DESC
          LIMIT 6
        `).all(
          (intent.primary === 'event' || intent.primary === 'history') && temporal.exact ? -4.0 : -1.5,
          temporal.start,
          temporal.end,
        )
        for (const e of temporalEpisodes) {
          if (!seen.has(`episode:${e.entity_id}`)) { sparse.push(e); seen.add(`episode:${e.entity_id}`) }
        }
      } catch {}
    }

    if (temporal?.exact && (intent.primary === 'history' || intent.primary === 'event')) {
      const exactEpisodeLane = this.db.prepare(`
        SELECT 'episode' AS type, role AS subtype, CAST(id AS TEXT) AS ref, content,
               -12.0 AS score, created_at AS updated_at, id AS entity_id, 0 AS retrieval_count,
               NULL AS quality_score, source_ref, ts AS source_ts, kind AS source_kind, backend AS source_backend
        FROM episodes
        WHERE day_key = ?
          AND role = 'user'
          AND kind = 'message'
        ORDER BY ts ASC
        LIMIT ?
      `).all(temporal.start, Math.max(limit, 6))
      const seen = new Set(sparse.map(r => `${r.type}:${r.entity_id}`))
      for (const row of exactEpisodeLane) {
        if (seen.has(`episode:${row.entity_id}`)) continue
        sparse.unshift(row)
        seen.add(`episode:${row.entity_id}`)
      }
    }

    let combined = this.combineRetrievalResults(clean, sparse, dense, limit, intent, queryEntities)
    if (temporal?.exact && (intent.primary === 'history' || intent.primary === 'event')) {
      const exactDate = temporal.start
      const exactEpisodeResults = combined.filter(item => item.type === 'episode' && String(item.source_ts ?? item.updated_at ?? '').includes(exactDate))
      const otherResults = combined.filter(item => !(item.type === 'episode' && String(item.source_ts ?? item.updated_at ?? '').includes(exactDate)))
      combined = [...exactEpisodeResults, ...otherResults].slice(0, limit)
    }
    return combined
  }

  searchRelevantSparse(query, limit = 8) {
    const ftsQuery = buildFtsQuery(query)
    const shortTokens = getShortTokensForLike(query)
    const includeDoneTasks = isDoneTaskQuery(query)
    if (!ftsQuery && shortTokens.length === 0) return []
    const results = []
    const runFts = Boolean(ftsQuery)

    try {
      if (!runFts) throw 0
      const factHits = this.db.prepare(`
        SELECT 'fact' AS type, f.fact_type AS subtype, CAST(f.id AS TEXT) AS ref, f.workstream AS workstream, f.text AS content,
               bm25(facts_fts) AS score, unixepoch(f.last_seen) AS updated_at, f.id AS entity_id,
               f.confidence AS quality_score,
               f.retrieval_count AS retrieval_count,
               f.source_episode_id AS source_episode_id,
               e.source_ref AS source_ref,
               e.ts AS source_ts,
               e.kind AS source_kind,
               e.backend AS source_backend
        FROM facts_fts
        JOIN facts f ON f.id = facts_fts.rowid
        LEFT JOIN episodes e ON e.id = f.source_episode_id
        WHERE facts_fts MATCH ?
          AND f.status = 'active'
        ORDER BY score
        LIMIT ?
      `).all(ftsQuery, limit)
      results.push(...factHits)
    } catch { /* ignore */ }

    try {
      if (!runFts) throw 0
      const taskHits = this.db.prepare(`
        SELECT 'task' AS type, t.stage AS subtype, CAST(t.id AS TEXT) AS ref, t.workstream AS workstream,
               trim(t.title || CASE WHEN t.details IS NOT NULL AND t.details != '' THEN ' — ' || t.details ELSE '' END) AS content,
               bm25(tasks_fts) AS score, unixepoch(t.last_seen) AS updated_at, t.id AS entity_id,
               t.confidence AS quality_score,
               t.stage AS stage, t.evidence_level AS evidence_level, t.status AS status,
               t.retrieval_count AS retrieval_count,
               t.source_episode_id AS source_episode_id,
               e.source_ref AS source_ref,
               e.ts AS source_ts,
               e.kind AS source_kind,
               e.backend AS source_backend
        FROM tasks_fts
        JOIN tasks t ON t.id = tasks_fts.rowid
        LEFT JOIN episodes e ON e.id = t.source_episode_id
        WHERE tasks_fts MATCH ?
          AND t.status IN (${includeDoneTasks ? "'active', 'in_progress', 'paused', 'done'" : "'active', 'in_progress', 'paused'"})
        ORDER BY score
        LIMIT ?
      `).all(ftsQuery, limit)
      results.push(...taskHits)
    } catch { /* ignore */ }

    try {
      if (!runFts) throw 0
      const signalHits = this.db.prepare(`
        SELECT 'signal' AS type, s.kind AS subtype, CAST(s.id AS TEXT) AS ref,
               s.value AS content, bm25(signals_fts) AS score,
               unixepoch(s.last_seen) AS updated_at, s.id AS entity_id, s.retrieval_count AS retrieval_count,
               s.score AS quality_score,
               s.source_episode_id AS source_episode_id,
               e.source_ref AS source_ref,
               e.ts AS source_ts,
               e.kind AS source_kind,
               e.backend AS source_backend
        FROM signals_fts
        JOIN signals s ON s.id = signals_fts.rowid
        LEFT JOIN episodes e ON e.id = s.source_episode_id
        WHERE signals_fts MATCH ?
        ORDER BY score
        LIMIT ?
      `).all(ftsQuery, limit)
      results.push(...signalHits)
    } catch { /* ignore */ }

    try {
      if (!runFts) throw 0
      const propositionHits = this.db.prepare(`
        SELECT 'proposition' AS type, p.proposition_kind AS subtype, CAST(p.id AS TEXT) AS ref,
               p.text AS content, bm25(propositions_fts) AS score,
               unixepoch(p.last_seen) AS updated_at, p.id AS entity_id, p.retrieval_count AS retrieval_count,
               p.confidence AS quality_score,
               p.source_episode_id AS source_episode_id,
               p.source_fact_id AS source_fact_id,
               e.source_ref AS source_ref,
               e.ts AS source_ts,
               e.kind AS source_kind,
               e.backend AS source_backend
        FROM propositions_fts
        JOIN propositions p ON p.id = propositions_fts.rowid
        LEFT JOIN episodes e ON e.id = p.source_episode_id
        WHERE propositions_fts MATCH ?
          AND p.status = 'active'
        ORDER BY score
        LIMIT ?
      `).all(ftsQuery, limit)
      results.push(...propositionHits)
    } catch { /* ignore */ }

    try {
      if (!runFts) throw 0
      const episodeHits = this.db.prepare(`
        SELECT 'episode' AS type, e.role AS subtype, CAST(e.id AS TEXT) AS ref,
               e.content AS content, bm25(episodes_fts) AS score,
               e.created_at AS updated_at, e.id AS entity_id, 0 AS retrieval_count,
               NULL AS quality_score,
               e.source_ref AS source_ref,
               e.ts AS source_ts,
               e.kind AS source_kind,
               e.backend AS source_backend
        FROM episodes_fts
        JOIN episodes e ON e.id = episodes_fts.rowid
        WHERE episodes_fts MATCH ?
          AND e.role = 'user'
          AND e.kind NOT IN ('schedule-inject', 'event-inject')
          AND e.content NOT LIKE 'You are consolidating%'
          AND e.content NOT LIKE 'You are improving%'
          AND e.content NOT LIKE 'You are analyzing%'
          AND e.content NOT LIKE 'Answer using live%'
          AND e.content NOT LIKE 'Use the ai_search%'
          AND e.content NOT LIKE 'Say only%'
          AND e.content NOT LIKE 'Compress these summaries%'
          AND e.content NOT LIKE 'Summarize the conversation%'
          AND LENGTH(e.content) >= 10
        ORDER BY score
        LIMIT ?
      `).all(ftsQuery, Math.min(limit, 6))
      results.push(...episodeHits)
    } catch { /* ignore */ }

    // LIKE fallback for 2-char Korean tokens that trigram can't index
    if (shortTokens.length > 0 && results.length < limit) {
      const seen = new Set(results.map(r => `${r.type}:${r.entity_id}`))
      const likeConditions = shortTokens.map(() => 'f.text LIKE ?').join(' OR ')
      const likeParams = shortTokens.map(t => `%${t}%`)
      try {
        const likeFacts = this.db.prepare(`
          SELECT 'fact' AS type, f.fact_type AS subtype, CAST(f.id AS TEXT) AS ref, f.text AS content,
                 0 AS score, unixepoch(f.last_seen) AS updated_at, f.id AS entity_id,
                 f.confidence AS quality_score, f.retrieval_count AS retrieval_count,
                 f.source_episode_id AS source_episode_id,
                 e.source_ref AS source_ref, e.ts AS source_ts, e.kind AS source_kind, e.backend AS source_backend
          FROM facts f
          LEFT JOIN episodes e ON e.id = f.source_episode_id
          WHERE f.status = 'active' AND (${likeConditions})
          LIMIT ?
        `).all(...likeParams, Math.min(limit, 4))
        for (const hit of likeFacts) {
          if (seen.has(`fact:${hit.entity_id}`)) continue
          // score proportional to how many short tokens match
          const matchCount = shortTokens.filter(t => hit.content.includes(t)).length
          hit.score = -(matchCount / shortTokens.length) * 1.5
          results.push(hit)
        }
      } catch { /* ignore */ }
      try {
        const likeTasks = this.db.prepare(`
          SELECT 'task' AS type, t.stage AS subtype, CAST(t.id AS TEXT) AS ref,
                 trim(t.title || CASE WHEN t.details IS NOT NULL AND t.details != '' THEN ' — ' || t.details ELSE '' END) AS content,
                 0 AS score, unixepoch(t.last_seen) AS updated_at, t.id AS entity_id,
                 t.confidence AS quality_score, t.retrieval_count AS retrieval_count,
                 t.source_episode_id AS source_episode_id,
                 e.source_ref AS source_ref, e.ts AS source_ts, e.kind AS source_kind, e.backend AS source_backend
          FROM tasks t
          LEFT JOIN episodes e ON e.id = t.source_episode_id
          WHERE t.status IN (${includeDoneTasks ? "'active', 'in_progress', 'paused', 'done'" : "'active', 'in_progress', 'paused'"})
            AND (${shortTokens.map(() => '(t.title LIKE ? OR t.details LIKE ?)').join(' OR ')})
          LIMIT ?
        `).all(...shortTokens.flatMap(t => [`%${t}%`, `%${t}%`]), Math.min(limit, 4))
        for (const hit of likeTasks) {
          if (seen.has(`task:${hit.entity_id}`)) continue
          const matchCount = shortTokens.filter(t => hit.content.includes(t)).length
          hit.score = -(matchCount / shortTokens.length) * 1.5
          results.push(hit)
        }
      } catch { /* ignore */ }
    }

    return results
  }

  async searchRelevantDense(query, limit = 8, queryVector = null, focusVector = null) {
    const clean = cleanMemoryText(query)
    if (!clean) return []
    const vector = queryVector ?? await embedText(clean)
    if (!Array.isArray(vector) || vector.length === 0) return []
    const model = getEmbeddingModelId()
    const expectedDims = getEmbeddingDims()
    const vectorModel = this.getMetaValue('embedding.vector_model', '')
    const vectorDims = Number(this.getMetaValue('embedding.vector_dims', '0')) || 0
    const reindexRequired = this.getMetaValue('embedding.reindex_required', '0') === '1'
    const reindexReason = this.getMetaValue('embedding.reindex_reason', '')
    const hasCurrentModelVectors = Boolean(this.hasVectorModelStmt.get(model)?.ok)
    if (reindexRequired) {
      process.stderr.write(`[memory] dense retrieval disabled: embeddings require reindex (${reindexReason || 'provider/model switch'})\n`)
      return []
    }
    if (vectorModel && vectorModel !== model && !hasCurrentModelVectors) {
      process.stderr.write(`[memory] dense retrieval disabled: current model=${model} indexed model=${vectorModel}; rebuild embeddings required\n`)
      return []
    }
    if (expectedDims && vector.length !== expectedDims) {
      process.stderr.write(`[memory] dense retrieval disabled: query vector dims=${vector.length} expected=${expectedDims}\n`)
      return []
    }
    if (vectorDims && vector.length !== vectorDims && hasCurrentModelVectors) {
      process.stderr.write(`[memory] dense retrieval disabled: query vector dims=${vector.length} indexed dims=${vectorDims}\n`)
      return []
    }

    // sqlite-vec KNN path
    if (this.vecEnabled) {
      try {
        const hex = vecToHex(vector)
        const knnRows = this.db.prepare(`
          SELECT rowid, distance FROM vec_memory WHERE embedding MATCH X'${hex}' ORDER BY distance LIMIT ?
        `).all(limit * 3)

        const results = []
        for (const knn of knnRows) {
          const { entityType, entityId } = this._vecRowToEntity(knn.rowid)
          const meta = this._getEntityMeta(entityType, entityId, model)
          if (!meta) continue
          const similarity = 1 - knn.distance  // L2 distance → approximate similarity
          const focusSimilarity = Array.isArray(focusVector) ? (() => {
            try {
              const rv = JSON.parse(meta.vector_json)
              return rv.length === focusVector.length ? cosineSimilarity(focusVector, rv) : 0
            } catch { return 0 }
          })() : 0
          results.push({
            ...meta,
            ref: String(entityId),
            score: -similarity,
            focus_similarity: focusSimilarity,
          })
        }
        return results.sort((a, b) => Number(a.score) - Number(b.score)).slice(0, limit)
      } catch (e) {
        process.stderr.write(`[memory] vec KNN failed, falling back: ${e.message}\n`)
      }
    }

    // Fallback: JS cosine scan
    const rows = [
      ...this.listDenseFactRowsStmt.all(model),
      ...this.listDenseTaskRowsStmt.all(model),
      ...this.listDenseSignalRowsStmt.all(model),
      ...this.listDensePropositionRowsStmt.all(model),
      ...this.listDenseEpisodeRowsStmt.all(model),
    ]

    return rows
      .map(row => {
        try {
          const rowVector = JSON.parse(row.vector_json)
          const similarity = cosineSimilarity(vector, rowVector)
          const focusSimilarity =
            Array.isArray(focusVector) && focusVector.length === rowVector.length
              ? cosineSimilarity(focusVector, rowVector)
              : 0
          return {
            ...row,
            ref: String(row.entity_id),
            score: -similarity,
            focus_similarity: focusSimilarity,
          }
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => Number(a.score) - Number(b.score))
      .slice(0, limit)
  }

  _getEntityMeta(entityType, entityId, model) {
    try {
      if (entityType === 'fact') {
        return this.db.prepare(`
          SELECT 'fact' AS type, f.fact_type AS subtype, f.id AS entity_id, f.text AS content,
                 unixepoch(f.last_seen) AS updated_at, f.retrieval_count AS retrieval_count,
                 f.source_episode_id AS source_episode_id,
                 e.kind AS source_kind, e.backend AS source_backend,
                 mv.vector_json
          FROM facts f
          JOIN memory_vectors mv ON mv.entity_type = 'fact' AND mv.entity_id = f.id AND mv.model = ?
          LEFT JOIN episodes e ON e.id = f.source_episode_id
          WHERE f.id = ? AND f.status = 'active'
        `).get(model, entityId)
      }
      if (entityType === 'task') {
        return this.db.prepare(`
          SELECT 'task' AS type, t.stage AS subtype, t.id AS entity_id,
                 trim(t.title || CASE WHEN t.details != '' THEN ' — ' || t.details ELSE '' END) AS content,
                 unixepoch(t.last_seen) AS updated_at, t.retrieval_count AS retrieval_count,
                 t.source_episode_id AS source_episode_id,
                 e.kind AS source_kind, e.backend AS source_backend,
                 mv.vector_json
          FROM tasks t
          JOIN memory_vectors mv ON mv.entity_type = 'task' AND mv.entity_id = t.id AND mv.model = ?
          LEFT JOIN episodes e ON e.id = t.source_episode_id
          WHERE t.id = ? AND t.status IN ('active', 'in_progress', 'paused')
        `).get(model, entityId)
      }
      if (entityType === 'signal') {
        return this.db.prepare(`
          SELECT 'signal' AS type, s.kind AS subtype, s.id AS entity_id, s.value AS content,
                 unixepoch(s.last_seen) AS updated_at, s.retrieval_count AS retrieval_count,
                 s.source_episode_id AS source_episode_id,
                 e.kind AS source_kind, e.backend AS source_backend,
                 mv.vector_json
          FROM signals s
          JOIN memory_vectors mv ON mv.entity_type = 'signal' AND mv.entity_id = s.id AND mv.model = ?
          LEFT JOIN episodes e ON e.id = s.source_episode_id
          WHERE s.id = ?
        `).get(model, entityId)
      }
      if (entityType === 'proposition') {
        return this.db.prepare(`
          SELECT 'proposition' AS type, p.proposition_kind AS subtype, p.id AS entity_id, p.text AS content,
                 unixepoch(p.last_seen) AS updated_at, p.retrieval_count AS retrieval_count,
                 p.source_fact_id AS source_fact_id,
                 p.source_episode_id AS source_episode_id,
                 e.kind AS source_kind, e.backend AS source_backend,
                 mv.vector_json
          FROM propositions p
          JOIN memory_vectors mv ON mv.entity_type = 'proposition' AND mv.entity_id = p.id AND mv.model = ?
          LEFT JOIN episodes e ON e.id = p.source_episode_id
          WHERE p.id = ? AND p.status = 'active'
        `).get(model, entityId)
      }
      if (entityType === 'episode') {
        return this.db.prepare(`
          SELECT 'episode' AS type, e.role AS subtype, e.id AS entity_id, e.content,
                 e.created_at AS updated_at, 0 AS retrieval_count,
                 e.kind AS source_kind, e.backend AS source_backend,
                 mv.vector_json
          FROM episodes e JOIN memory_vectors mv ON mv.entity_type = 'episode' AND mv.entity_id = e.id AND mv.model = ?
          WHERE e.id = ?
        `).get(model, entityId)
      }
    } catch {}
    return null
  }

  combineRetrievalResults(query, sparseResults, denseResults, limit = 8, intent = null, queryEntities = []) {
    const now = Date.now()
    const merged = new Map()
    const queryTokens = new Set(tokenizeMemoryText(query))
    const queryTokenCount = queryTokens.size
    const primaryIntent = intent?.primary ?? 'decision'

    // Entity-filtered retrieval: find matching entities and collect their source episode IDs
    const scopedEntityIds = new Set(queryEntities.map(item => Number(item.id)).filter(Number.isFinite))
    const scopedEntityNames = new Set(queryEntities.map(item => String(item.name ?? '').toLowerCase()).filter(Boolean))

    const dedupKey = (item) => {
      const normalized = cleanMemoryText(String(item.content ?? '')).toLowerCase()
      const contentHash = createHash('sha1').update(normalized.slice(0, 240)).digest('hex').slice(0, 16)
      return `${item.type}:${item.subtype}:${contentHash}`
    }

    for (const item of sparseResults) {
      const key = dedupKey(item)
      merged.set(key, {
        ...item,
        sparse_score: Number(item.score),
        dense_score: null,
      })
    }

    for (const item of denseResults) {
      const key = dedupKey(item)
      const prev = merged.get(key)
      if (prev) {
        prev.dense_score = Number(item.score)
      } else {
        merged.set(key, {
          ...item,
          sparse_score: null,
          dense_score: Number(item.score),
        })
      }
    }

    const scored = [...merged.values()]
      .map(item => {
        const sparse = item.sparse_score ?? 0
        const dense = item.dense_score ?? 0
        const ageSeconds = item.updated_at ? Math.max(0, now / 1000 - Number(item.updated_at)) : 0
        // Ebbinghaus-inspired decay: rapid initial forgetting, then plateau
        // R = e^(-t/S) where S scales with retrieval_count (spaced repetition)
        const ageDays = ageSeconds / 86400
        const stabilityFactor = 1 + Math.min(5, Number(item.retrieval_count ?? 0)) * 0.8
        const recencyPenalty = Math.min(0.4, (1 - Math.exp(-ageDays / (stabilityFactor * 15))) * 0.4)
        const contentTokens = tokenizeMemoryText(`${item.subtype ?? ''} ${item.content}`)
        const overlapCount = contentTokens.reduce((count, token) => count + (queryTokens.has(token) ? 1 : 0), 0)
        const overlapRatio = queryTokenCount > 0 ? overlapCount / queryTokenCount : 0
        const overlapBoost =
          overlapCount > 0
            ? -Math.min(
                isPolicyIntent(primaryIntent) ? 0.42 :
                (primaryIntent === 'event' || primaryIntent === 'history') ? 0.34 :
                0.26,
                overlapRatio * (
                  isPolicyIntent(primaryIntent) ? 0.42 :
                  (primaryIntent === 'event' || primaryIntent === 'history') ? 0.34 :
                  0.26
                ),
              )
            : 0
        const retrievalBoost = -Math.min(0.08, Number(item.retrieval_count ?? 0) * 0.01)
        const focusBoost =
          primaryIntent === 'task' || primaryIntent === 'decision'
            ? -Math.min(0.14, Math.max(0, Number(item.focus_similarity ?? 0)) * 0.12)
            : 0
        const qualityBoost =
          item.type === 'fact' || item.type === 'task' || item.type === 'relation' || item.type === 'proposition'
            ? -Math.min(0.12, Math.max(0, Number(item.quality_score ?? 0.5) - 0.5) * 0.3)
            : item.type === 'signal' || item.type === 'profile' || item.type === 'entity'
              ? -Math.min(0.08, Math.max(0, Number(item.quality_score ?? 0.5) - 0.5) * 0.2)
              : 0
        const typeBoost =
          item.type === 'fact'
            ? (
                item.subtype === 'preference' ? -0.16 :
                item.subtype === 'constraint' ? -0.15 :
                item.subtype === 'decision' ? -0.11 :
                -0.09
              )
            : item.type === 'task' ? -0.10 :
            item.type === 'proposition' ? -0.12 :
            item.type === 'entity' ? -0.08 :
            item.type === 'relation' ? -0.1 :
            item.type === 'profile' ? -0.08 :
            item.type === 'signal'
              ? (
                  item.subtype === 'tone' ? -0.08 :
                  item.subtype === 'language' ? -0.08 :
                  -0.04
                )
              :
              item.type === 'episode' ? -0.04 :
              0
        const intentBoost =
          isProfileIntent(primaryIntent)
            ? (
                item.type === 'fact' && (item.subtype === 'preference' || item.subtype === 'constraint') ? -0.18 :
                item.type === 'proposition' ? -0.14 :
                item.type === 'signal' && (item.subtype === 'tone' || item.subtype === 'language') ? -0.14 :
                item.type === 'profile' ? -0.22 :
                item.type === 'task' ? 0.10 :
                item.type === 'episode' ? 0.12 :
                0
              )
            : primaryIntent === 'task'
              ? (
                  item.type === 'task' ? -0.18 :
                  item.type === 'proposition' ? -0.1 :
                  item.type === 'fact' && item.subtype === 'decision' ? -0.06 :
                  item.type === 'signal' ? 0.08 :
                  item.type === 'episode' ? 0.04 :
                  0
                )
              : isPolicyIntent(primaryIntent)
                ? (
                    item.type === 'fact' && item.subtype === 'constraint' ? -0.18 :
                    item.type === 'proposition' ? -0.14 :
                    item.type === 'fact' && item.subtype === 'decision' ? -0.10 :
                    item.type === 'relation' ? -0.08 :
                    item.type === 'entity' ? -0.06 :
                    item.type === 'signal' ? -0.04 :
                    item.type === 'task' ? 0.08 :
                    item.type === 'episode' ? 0.04 :
                    0
                  )
              : primaryIntent === 'event'
                ? (
                    item.type === 'episode' ? -0.22 :
                    item.type === 'proposition' ? -0.12 :
                    item.type === 'task' && item.source_episode_id != null ? -0.06 :
                    item.type === 'fact' && item.source_episode_id != null ? -0.04 :
                    item.type === 'signal' ? 0.08 :
                    0
                  )
              : primaryIntent === 'history'
                ? (
                    item.type === 'episode' ? -0.12 :
                    item.type === 'proposition' ? -0.12 :
                    item.type === 'entity' ? -0.1 :
                    item.type === 'relation' ? -0.1 :
                    item.type === 'task' ? -0.04 :
                    item.type === 'signal' ? 0.06 :
                    0
                  )
                : (
                    item.type === 'fact' && item.subtype === 'decision' ? -0.10 :
                    item.type === 'proposition' ? -0.12 :
                    item.type === 'fact' && item.subtype === 'constraint' ? -0.08 :
                    item.type === 'entity' ? -0.08 :
                    item.type === 'relation' ? -0.1 :
                    item.type === 'profile' ? -0.08 :
                    item.type === 'task' ? -0.05 :
                    0
                  )
        const densityPenalty =
          item.type === 'signal' && overlapCount === 0 ? 0.12 :
          item.type === 'episode' && overlapCount === 0 ? 0.10 :
          0
        // Entity boost: items linked to a matching entity get a score boost
        const entityBoost =
          scopedEntityIds.size > 0
            ? (
                item.type === 'entity' && scopedEntityIds.has(Number(item.entity_id)) ? -0.28 :
                item.type === 'relation' && [...scopedEntityNames].some(name => String(item.content ?? '').toLowerCase().includes(name)) ? -0.24 :
                item.scoped_entity_id && scopedEntityIds.has(Number(item.scoped_entity_id)) ? -0.26 :
                0
              )
            : 0
        const sourceTrustBoost = computeSourceTrustAdjustment(item, primaryIntent)
        return {
          ...item,
          content: compactRetrievalContent(item),
          overlapCount,
          weighted_score: sparse + dense + recencyPenalty + typeBoost + intentBoost + overlapBoost + retrievalBoost + focusBoost + qualityBoost + densityPenalty + entityBoost + sourceTrustBoost,
        }
      })
    const positiveCoreMatches = scored.filter(item =>
      Number(item.overlapCount) > 0 &&
      (item.type === 'fact' || item.type === 'task'),
    ).length
    const hasPositiveOverlap = scored.some(item => Number(item.overlapCount) > 0)
    const ranked = collapseClaimSurfaceDuplicates(scored, 'weighted_score')
      .map(item => {
        const overlapAdjustment =
          Number(item.overlapCount) > 0
            ? -Math.min(0.2, Number(item.overlapCount) * 0.06)
            : hasPositiveOverlap ? 0.28 : 0.08
        return {
          ...item,
          weighted_score: Number(item.weighted_score) + overlapAdjustment,
        }
      })
      .filter(item => {
        if (positiveCoreMatches < 2) return true
        if (Number(item.overlapCount) > 0) return true
        return item.type === 'signal'
      })
      .sort((a, b) => Number(a.weighted_score) - Number(b.weighted_score))

    const hasCoreResult = ranked.some(item => item.type === 'fact' || item.type === 'task')
    const conciseQuery = queryTokenCount <= 4
    const hasTaskCandidate = ranked.some(item => item.type === 'task')
    const typeCaps = getIntentTypeCaps(primaryIntent, { hasTaskCandidate, hasCoreResult, conciseQuery })
    const typeCounts = new Map()
    const selected = []
    const rerankThreshold = -0.5
    const rerankPool = collapseClaimSurfaceDuplicates(ranked.slice(0, Math.max(limit * 2, 10)), 'rerank_score')
      .map(item => {
        return {
          ...item,
          rerank_score: Number(item.weighted_score) + getIntentSubtypeBonus(primaryIntent, item),
        }
      })
      .filter(item => shouldKeepRerankItem(primaryIntent, item, { hasTaskCandidate }))
      .sort((a, b) => Number(a.rerank_score) - Number(b.rerank_score))

    for (const item of rerankPool) {
      const allowByOverlap = Number(item.overlapCount) > 0
      const allowBySparse =
        item.sparse_score != null &&
        Number(item.sparse_score) <= 0 &&
        (primaryIntent === 'decision' || isPolicyIntent(primaryIntent) || primaryIntent === 'event' || primaryIntent === 'history')
      if (Number(item.rerank_score) > rerankThreshold && !allowByOverlap && !allowBySparse) continue
      const type = String(item.type)
      const cap = typeCaps.get(type) ?? 2
      const count = typeCounts.get(type) ?? 0
      if (count >= cap) continue
      selected.push(item)
      typeCounts.set(type, count + 1)
      if (selected.length >= limit) break
    }
    return selected
  }

  recordRetrieval(results = []) {
    const now = new Date().toISOString()
    for (const item of results) {
      const entityId = Number(item?.entity_id)
      if (!Number.isFinite(entityId) || entityId <= 0) continue
      if (item.type === 'fact') {
        this.bumpFactRetrievalStmt.run(now, entityId)
      } else if (item.type === 'task') {
        this.bumpTaskRetrievalStmt.run(now, entityId)
      } else if (item.type === 'signal') {
        this.bumpSignalRetrievalStmt.run(now, entityId)
      } else if (item.type === 'proposition') {
        this.bumpPropositionRetrievalStmt.run(now, entityId)
      }
    }
  }

  async getCoreMemoryItems(query = '', intent = null, queryVector = null) {
    const queryTokens = new Set(tokenizeMemoryText(query))
    const primaryIntent = intent?.primary ?? 'decision'
    const vector = query ? (queryVector ?? await embedText(query)) : null
    // Profile hints removed — profiles are injected once at session start via context.md

    const coreFacts = this.db.prepare(`
      SELECT id, 'fact' AS type, fact_type AS subtype, text AS content, confidence, last_seen
      FROM facts
      WHERE status = 'active'
        AND fact_type IN ('preference', 'constraint')
      ORDER BY confidence DESC, retrieval_count DESC, mention_count DESC, last_seen DESC
      LIMIT 10
    `).all()

    const coreSignals = this.db.prepare(`
      SELECT id, 'signal' AS type, kind AS subtype, value AS content, score AS confidence, last_seen
      FROM signals
      WHERE kind IN ('language', 'tone')
      ORDER BY score DESC, retrieval_count DESC, last_seen DESC
      LIMIT 6
    `).all()
      .map(item => ({
        ...item,
        effectiveScore: decaySignalScore(item.confidence, item.last_seen, item.subtype),
      }))
      .filter(item => item.effectiveScore >= 0.45)

    const dedupe = new Set()
    const items = []
    const combined = [...coreFacts, ...coreSignals]
    const semanticScores = vector
      ? await Promise.all(combined.map(async item => {
          const entityType = item.type === 'fact' ? 'fact' : 'signal'
          const itemVector = await this.getStoredVector(entityType, item.id, `${item.subtype} ${item.content}`)
          return cosineSimilarity(vector, itemVector)
        }))
      : combined.map(() => 0)

    for (let i = 0; i < combined.length; i += 1) {
      const item = combined[i]
      const key = `${item.type}:${item.subtype}:${item.content}`
      if (dedupe.has(key)) continue
      dedupe.add(key)
      const contentTokens = tokenizeMemoryText(`${item.subtype} ${item.content}`)
      const overlapCount = contentTokens.reduce((count, token) => count + (queryTokens.has(token) ? 1 : 0), 0)
      const typeBoost =
        item.type === 'signal'
          ? (item.subtype === 'language' || item.subtype === 'tone' ? 2 : 1)
          : item.subtype === 'preference'
            ? 2
            : 1
      const intentBoost =
        isProfileIntent(primaryIntent)
          ? typeBoost
          : primaryIntent === 'task'
            ? (item.subtype === 'constraint' ? 1 : 0)
            : isPolicyIntent(primaryIntent)
              ? (item.subtype === 'constraint' ? 2 : item.subtype === 'preference' ? 1 : 0)
            : 0
      const semanticBoost = vector ? semanticScores[i] * 3 : 0
      items.push({
        ...item,
        overlapCount,
        rankScore: overlapCount * 3 + intentBoost + semanticBoost + Number(item.confidence ?? item.effectiveScore ?? 0.5),
      })
    }
    const limit =
      isProfileIntent(primaryIntent) ? 4 :
      isPolicyIntent(primaryIntent) ? 3 :
      primaryIntent === 'decision' ? 3 :
      primaryIntent === 'task' ? 1 :
      primaryIntent === 'history' ? 1 :
      2
    return items
      .filter(item => {
        // profile intent: all core memory relevant
        if (isProfileIntent(primaryIntent)) return true
        // others: require keyword overlap or semantic relevance
        return Number(item.overlapCount) > 0 || Number(item.rankScore) > 4.5
      })
      .sort((a, b) => Number(b.rankScore) - Number(a.rankScore))
      .slice(0, limit)
  }

  async getPriorityTasks(query = '', options = {}) {
    const queryVector = query ? await embedText(query) : []
    const focusVector = options.focusVector ?? await this.buildRecentFocusVector({
      channelId: options.channelId,
      userId: options.userId,
    })
    const workstreamHint = normalizeWorkstream(options.workstreamHint)
    const hintTokens = tokenizedWorkstream(workstreamHint)
    const includeDone = Boolean(options.includeDone) || isDoneTaskQuery(query)

    const rows = this.db.prepare(`
      SELECT id, title, details, workstream, status, priority, confidence, last_seen, retrieval_count, stage, evidence_level
      FROM tasks
      WHERE status IN (${includeDone ? "'active', 'in_progress', 'paused', 'done'" : "'active', 'in_progress', 'paused'"})
      ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, retrieval_count DESC, last_seen DESC
      LIMIT 12
    `).all()

    const scored = await Promise.all(rows.map(async row => {
      const content = cleanMemoryText(`${row.title} ${row.details ?? ''}`)
      const taskVector = await this.getStoredVector('task', row.id, content)
      const querySimilarity =
        Array.isArray(queryVector) && queryVector.length === taskVector.length
          ? cosineSimilarity(queryVector, taskVector)
          : 0
      const focusSimilarity =
        Array.isArray(focusVector) && focusVector.length === taskVector.length
          ? cosineSimilarity(focusVector, taskVector)
          : 0
      const priorityBoost =
        row.priority === 'high' ? 0.35 :
        row.priority === 'normal' ? 0.18 :
        0
      const statusBoost =
        includeDone && row.status === 'done' ? 1.0 :
        includeDone && (row.status === 'active' || row.status === 'in_progress') ? -0.2 :
        row.status === 'active' || row.status === 'in_progress' ? 0.08 :
        0
      const workstreamMatch =
        hintTokens.length > 0
          ? tokenizedWorkstream(row.workstream).filter(token => hintTokens.includes(token)).length
          : 0
      const recencyBoost = Math.min(0.18, Number(row.retrieval_count ?? 0) * 0.01)
      return {
        ...row,
        priority_score: querySimilarity * 4 + focusSimilarity * 3 + priorityBoost + statusBoost + workstreamMatch * 1.2 + recencyBoost + Number(row.confidence ?? 0.5),
      }
    }))

    return scored
      .sort((a, b) => Number(b.priority_score) - Number(a.priority_score))
      .slice(0, Math.max(1, Number(options.limit ?? 3)))
  }

  async buildInboundMemoryContext(query, options = {}) {
    const clean = cleanMemoryText(query)
    if (!clean || looksLowSignalQuery(clean)) return ''

    const totalStartedAt = Date.now()
    const stageTimings = []
    const measureStage = async (label, work) => {
      const startedAt = Date.now()
      try {
        return await work()
      } finally {
        stageTimings.push(`${label}=${Date.now() - startedAt}ms`)
      }
    }

    const limit = Number(options.limit ?? 6)
    const lines = []
    const seenHintKeys = new Set()
    const queryTokenCount = Math.max(1, tokenizeMemoryText(clean).length)
    const queryVector = await measureStage('embed_query', () => embedText(clean))
    const focusVector = await measureStage('build_focus', () => this.buildRecentFocusVector({
      channelId: options.channelId,
      userId: options.userId,
    }))
    const intent = await measureStage('classify_intent', () => this.classifyQueryIntent(clean, queryVector))
    const topTaskHint = this.db.prepare(`
      SELECT workstream
      FROM tasks
      WHERE status IN ('active', 'in_progress', 'paused')
        AND workstream IS NOT NULL
        AND workstream != ''
      ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, retrieval_count DESC, last_seen DESC
      LIMIT 1
    `).get()?.workstream ?? ''

    const pushHint = (item, overrides = {}) => {
      const rawText = String(overrides.text ?? item.content ?? item.text ?? item.value ?? '').trim()
      if (!rawText) return
      if (!shouldInjectHint(item, overrides, { queryTokenCount })) return
      const key = buildHintKey(item, overrides)
      if (!key) return
      if (seenHintKeys.has(key)) return
      seenHintKeys.add(key)
      lines.push(formatHintTag(item, overrides, { queryTokenCount, nowTs: totalStartedAt }))
    }

    const coreMemory = await measureStage('core_memory', () => this.getCoreMemoryItems(clean, intent, queryVector))
    if (coreMemory.length > 0) {
      for (const item of coreMemory) {
        pushHint(item)
      }
    }

    if (intent.primary === 'task') {
      const priorityTasks = await measureStage('priority_tasks', () => this.getPriorityTasks(clean, {
        channelId: options.channelId,
        userId: options.userId,
        focusVector,
        workstreamHint: topTaskHint,
        limit: 3,
      }))
      if (priorityTasks.length > 0) {
        for (const task of priorityTasks) {
          const detail = task.details ? ` — ${task.details}` : ''
          pushHint(task, { type: 'task', text: `${task.title}${detail}` })
        }
      }
    } else if (intent.primary === 'decision' || intent.primary === 'policy' || intent.primary === 'security') {
      const decisions = this.db.prepare(`
        SELECT fact_type, text, confidence, last_seen
        FROM facts
        WHERE status = 'active'
          AND fact_type IN ('decision', 'constraint')
        ORDER BY confidence DESC, retrieval_count DESC, mention_count DESC, last_seen DESC
        LIMIT 3
      `).all()
      if (decisions.length > 0) {
        for (const item of decisions) {
          pushHint(item, { type: 'fact' })
        }
      }
    }

    let relevant = await measureStage('hybrid_search', () => this.searchRelevantHybrid(clean, limit, {
      queryVector,
      intent,
      focusVector,
      channelId: options.channelId,
      userId: options.userId,
    }))
    // typeCaps in combineRetrievalResults already controls type distribution per intent
    // only apply minimal filtering for strongest-signal intents
    if (intent.primary === 'profile') {
      relevant = relevant.filter(item => item.type === 'fact' || item.type === 'signal')
    }
    relevant = relevant.slice(0, Math.max(3, limit - 1))

    if (relevant.length > 0) {
      this.recordRetrieval(relevant)
      for (const item of relevant) {
        pushHint(item)
      }

      const hasSignal = intent.primary === 'profile' && relevant.some(item => item.type === 'signal')
      if (hasSignal) {
        const seenSignals = new Set(
          relevant
            .filter(item => item.type === 'signal')
            .map(item => `${item.subtype}:${item.content}`),
        )
        const extraSignals = this.db.prepare(`
          SELECT kind, value, score, last_seen
          FROM signals
          ORDER BY score DESC, retrieval_count DESC, last_seen DESC
          LIMIT 3
        `).all()
          .map(item => ({
            ...item,
            effectiveScore: decaySignalScore(item.score, item.last_seen, item.kind),
          }))
          .filter(item => item.effectiveScore >= 0.45)
          .filter(item => !seenSignals.has(`${item.kind}:${item.value}`))
          .slice(0, 1)
        for (const signal of extraSignals) {
          pushHint(signal, { type: 'signal', confidence: signal.effectiveScore, text: signal.value })
        }
      }
    } else {
      const facts = this.db.prepare(`
        SELECT fact_type, text, confidence, last_seen
        FROM facts
        WHERE status = 'active'
        ORDER BY
          CASE fact_type
            WHEN 'preference' THEN 1
            WHEN 'constraint' THEN 2
            WHEN 'decision' THEN 3
            ELSE 4
          END,
          confidence DESC,
          mention_count DESC,
          last_seen DESC
        LIMIT 4
      `).all()
      for (const fact of facts) {
        const confidence = decayConfidence(fact.confidence, fact.last_seen)
        if (confidence < 0.25) continue
        pushHint(fact, { type: 'fact', confidence })
      }

      const tasks = this.db.prepare(`
        SELECT title, status, confidence, last_seen, stage
        FROM tasks
        WHERE status IN ('active', 'in_progress', 'paused')
        ORDER BY
          CASE priority WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
          last_seen DESC
        LIMIT 3
      `).all()
      for (const task of tasks) {
        const confidence = decayConfidence(task.confidence, task.last_seen)
        if (confidence < 0.25) continue
        pushHint(task, { type: 'task', text: task.title, confidence })
      }

      const signals = this.db.prepare(`
        SELECT kind, value, score, last_seen
        FROM signals
        ORDER BY score DESC, last_seen DESC
        LIMIT 3
      `).all()
      const activeSignals = signals
        .map(item => ({
          ...item,
          effectiveScore: decaySignalScore(item.score, item.last_seen, item.kind),
        }))
        .filter(item => item.effectiveScore >= 0.45)
      for (const signal of activeSignals) {
        pushHint(signal, { type: 'signal', confidence: signal.effectiveScore, text: signal.value })
      }
    }

    // Multi-turn context: add recent conversation topics
    if (lines.length > 0) {
      try {
        const recentTopics = this.db.prepare(`
          SELECT content FROM episodes
          WHERE role = 'user'
            AND kind = 'message'
            AND content NOT LIKE 'You are consolidating%'
            AND content NOT LIKE 'You are improving%'
            AND LENGTH(content) BETWEEN 10 AND 200
            AND ts >= datetime('now', '-1 day')
          ORDER BY ts DESC
          LIMIT 3
        `).all()
        if (recentTopics.length > 0) {
          lines.push('<recent>' + recentTopics.map(r => cleanMemoryText(r.content).slice(0, 40)).join(' / ') + '</recent>')
        }
      } catch {}
    }

    if (lines.length === 0) return ''
    const ctx = `<memory-context>\n${lines.join('\n')}\n</memory-context>`
    const totalMs = Date.now() - totalStartedAt
    process.stderr.write(
      `[memory-timing] q="${clean.slice(0, 40)}" total=${totalMs}ms ${stageTimings.join(' ')}\n`,
    )
    process.stderr.write(`[memory] recall q="${clean.slice(0, 40)}" intent=${intent.primary} hints=${lines.filter(l => l.startsWith('<hint ')).length}\n`)
    return ctx
  }
}

export function getMemoryStore(dataDir) {
  const key = resolve(dataDir)
  const existing = stores.get(key)
  if (existing) return existing
  const store = new MemoryStore(key)
  stores.set(key, store)
  return store
}
