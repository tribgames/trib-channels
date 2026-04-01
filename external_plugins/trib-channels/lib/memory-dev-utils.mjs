import { cleanMemoryText } from './memory-extraction.mjs'

export function normalizeDevWorkstream(value = '') {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

export function normalizeTaskScope(value = '') {
  const clean = String(value ?? '').trim().toLowerCase()
  if (clean === 'work' || clean === 'personal') return clean
  return ''
}

export function normalizeTaskActivity(value = '') {
  const clean = String(value ?? '').trim().toLowerCase()
  if (['coding', 'research', 'planning', 'communication', 'ops'].includes(clean)) return clean
  return ''
}

export function detectDevQueryBias(query = '') {
  const clean = cleanMemoryText(query)
  if (!clean) return 0
  const lower = clean.toLowerCase()
  let score = 0

  const enKeywords = [
    /\b(file|function|class|method|variable|module|component)\b/,
    /\b(bug|fix|patch|hotfix|debug|error|crash|exception)\b/,
    /\b(commit|branch|merge|rebase|pr|pull request|push)\b/,
    /\b(refactor|implement|deploy|build|compile|test)\b/,
    /\b(api|endpoint|schema|migration|query|index)\b/,
    /\b(import|export|require|dependency|package)\b/,
  ]

  const koKeywords = [
    /파일|함수|클래스|메서드|변수|모듈|컴포넌트/,
    /버그|수정|패치|디버그|에러|크래시|오류/,
    /커밋|브랜치|머지|리베이스|푸시/,
    /리팩토링|구현|배포|빌드|컴파일|테스트/,
    /스키마|마이그레이션|쿼리|인덱스/,
    /코드|심볼|엔티티|메모리 구조|리트리벌|검색 파이프라인/,
  ]

  const filePatterns = /\.(mjs|js|ts|tsx|jsx|py|cs|json|md|sql|yaml|yml|csv)\b/

  for (const re of enKeywords) if (re.test(lower)) score += 0.3
  for (const re of koKeywords) if (re.test(clean)) score += 0.3
  if (filePatterns.test(lower)) score += 0.5

  return Math.min(score, 1)
}

export function isDevWorkstream(workstream = '', text = '') {
  const normalized = normalizeDevWorkstream(workstream)
  if (normalized.startsWith('dev-')) return true
  if (normalized.startsWith('general-')) return false
  return detectDevQueryBias(`${workstream} ${text}`) >= 0.35
}

export function inferTaskScope(task = {}) {
  const explicit = normalizeTaskScope(task.scope)
  if (explicit) return explicit
  const workstream = normalizeDevWorkstream(task.workstream)
  if (workstream.startsWith('general-personal') || workstream.startsWith('personal-')) return 'personal'
  return 'work'
}

export function inferTaskActivity(task = {}) {
  const explicit = normalizeTaskActivity(task.activity)
  if (explicit) return explicit
  const text = cleanMemoryText(`${task.title ?? ''} ${task.details ?? ''}`)
  const lower = text.toLowerCase()
  if (/\b(code|coding|implement|fix|patch|refactor|debug|build|compile|test)\b/.test(lower) || /코드|구현|수정|패치|리팩토링|디버그|빌드|컴파일|테스트/.test(text)) return 'coding'
  if (/\b(research|investigate|review|survey|analyze)\b/.test(lower) || /조사|검토|리뷰|분석|확인/.test(text)) return 'research'
  if (/\b(plan|planning|design|direction|draft)\b/.test(lower) || /기획|설계|방향|초안|정리/.test(text)) return 'planning'
  if (/\b(reply|message|discuss|coordinate|communicat)\b/.test(lower) || /대화|메시지|커뮤니케이션|조율/.test(text)) return 'communication'
  if (/\b(deploy|release|ops|operate|monitor|runtime)\b/.test(lower) || /배포|릴리즈|운영|모니터링|런타임/.test(text)) return 'ops'
  return ''
}

export function isDevelopmentFacet(task = {}) {
  const scope = normalizeTaskScope(task.scope ?? task.taskScope ?? '')
  const activity = normalizeTaskActivity(task.activity ?? task.taskActivity ?? '')
  if (isDevWorkstream(task.workstream, `${task.title ?? ''} ${task.details ?? ''}`)) return true
  return scope === 'work' && ['coding', 'research', 'planning', 'ops'].includes(activity)
}

export function shouldIncludeDevWorklogTask(task = {}, options = {}) {
  const scope = normalizeTaskScope(task.scope ?? task.taskScope ?? '')
  const activity = normalizeTaskActivity(task.activity ?? task.taskActivity ?? '')
  const workstream = String(task.workstream ?? '').trim()
  const hasStructuredFacet = scope === 'work' && ['coding', 'research', 'planning', 'ops'].includes(activity)
  const hasStructuredState = Boolean(String(task.currentState ?? '').trim() || String(task.nextStep ?? '').trim())
  const maxAgeDays = Math.max(1, Number(options.maxAgeDays ?? 2))
  const lastSeenMs = task.last_seen ? new Date(task.last_seen).getTime() : 0
  const ageDays = lastSeenMs ? Math.max(0, (Date.now() - lastSeenMs) / 86400000) : Number.POSITIVE_INFINITY
  return hasStructuredFacet && hasStructuredState && Boolean(workstream) && ageDays <= maxAgeDays
}
