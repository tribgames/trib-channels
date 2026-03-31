import { cleanMemoryText } from './memory-extraction.mjs'
import {
  isDoneTaskQuery,
  isHistoryQuery,
  isRelationQuery,
  isRuleQuery,
  parseTemporalHint,
} from './memory-query-plan.mjs'

export function normalizeProfileKey(key) {
  const value = String(key ?? '').trim().toLowerCase()
  return ['language', 'tone', 'address', 'response_style', 'timezone'].includes(value) ? value : ''
}

export function shouldKeepProfileValue(key, value) {
  const clean = cleanMemoryText(value)
  if (!key || !clean) return false
  if (key === 'timezone') return clean.length <= 64
  if (clean.length > 160) return false
  if (clean.length > 48 && /\b(?:on|as of)\s+\d{4}-\d{2}-\d{2}\b/i.test(clean)) return false
  if (clean.length > 48 && /\b(requested|asked|stated|reported|mentioned|clarified)\b/i.test(clean)) return false
  if (clean.length > 48 && /(요청|지시|말씀|언급|보고|설명)/.test(clean)) return false
  return true
}

export function profileKeyForFact(factType, text = '', slot = '') {
  const combined = `${slot} ${text}`.toLowerCase()
  if (factType === 'preference' && (/\b(address|call|name|nickname)\b/.test(combined) || /호칭|이름|닉네임/.test(combined))) return 'address'
  if (factType === 'preference' && (/\b(response style|response-style|style|tone)\b/.test(combined) || /말투|어투|응답 스타일|답변 스타일/.test(combined))) return 'response_style'
  if (factType === 'constraint' && (/\btimezone|time zone|local time\b/.test(combined) || /시간대|현지 시간/.test(combined))) return 'timezone'
  return ''
}

export function profileKeyForSignal(kind, value = '') {
  const combined = `${kind} ${value}`.toLowerCase()
  if (kind === 'language' || /\bkorean|english|japanese|chinese|language\b/.test(combined) || /한국어|영어|일본어|중국어|언어/.test(combined)) return 'language'
  if (kind === 'tone' || /\btone|style|formal|respectful|casual\b/.test(combined) || /존댓말|반말|격식|말투|어투/.test(combined)) return 'tone'
  return ''
}

export function detectProfileQuerySlot(text = '') {
  const clean = cleanMemoryText(text)
  const lowered = clean.toLowerCase()
  if (
    /\b(timezone|time zone|local time|device time|timestamp|locale)\b/.test(lowered) ||
    /시간대|타임존|로컬.*시간|디바이스.*시간|timestamp|locale/.test(clean) ||
    ((/로컬|디바이스/.test(clean)) && /시간/.test(clean))
  ) return 'timezone'
  if (/\b(language|korean|english|japanese|chinese)\b/.test(lowered) || /언어|한국어|영어|일본어|중국어/.test(clean)) return 'language'
  if (/\b(tone|style|formal|respectful|casual|honorific)\b/.test(lowered) || /말투|어투|존댓말|반말|격식/.test(clean)) return 'tone'
  if (/\b(address|call|nickname|name)\b/.test(lowered) || /호칭|닉네임|이름/.test(clean)) return 'address'
  if (/\b(response style|response-style|response mode)\b/.test(lowered) || /응답 스타일|답변 스타일/.test(clean)) return 'response_style'
  return ''
}

export function applyLexicalIntentHints(clean, scores) {
  const lowered = clean.toLowerCase()
  const profileSlot = detectProfileQuerySlot(clean)
  const add = (intent, value) => {
    scores[intent] = Number((scores[intent] + value).toFixed(4))
  }

  if (profileSlot) {
    add('profile', profileSlot === 'timezone' ? 0.52 : 0.44)
    scores.history = Math.max(0, scores.history - 0.24)
    scores.event = Math.max(0, scores.event - 0.18)
    scores.task = Math.max(0, scores.task - 0.12)
  } else if (/\b(language|tone|style|address|honorific|timezone)\b/.test(lowered) || /한국어|영어|존댓말|반말|말투|어투|호칭|시간대/.test(clean)) {
    add('profile', /\btimezone\b/.test(lowered) || /시간대/.test(clean) ? 0.62 : 0.45)
    scores.event = Math.max(0, scores.event - 0.22)
    scores.history = Math.max(0, scores.history - 0.12)
    scores.task = Math.max(0, scores.task - 0.22)
  }
  if (/\b(profile|identity|source of truth|name|address)\b/.test(lowered) || /프로필|정체성|source of truth|호칭|이름/.test(clean)) {
    add('profile', 0.22)
    add('decision', 0.08)
  }
  if (/\b(storage|persistence|persist|store|stored|database|sqlite|path|backend|frontend|client|server|pair|pairing|boundary|ownership|integration point)\b/.test(lowered)
    || /저장|영속|보존|스토리지|DB|데이터베이스|sqlite|경로|백엔드|프론트|클라|서버|짝|쌍|경계|소유권|연결점/.test(clean)) {
    add('decision', 0.26)
    scores.profile = Math.max(0, scores.profile - 0.12)
  }
  if (/\b(prefer|preference|preferred|want|wanted|care about|value|prioritize)\b/.test(lowered) || /선호|원하|중시|우선/.test(clean)) {
    const explicitProfileCue = /\b(language|tone|style|address|honorific|timezone)\b/.test(lowered) || /한국어|영어|존댓말|반말|말투|어투|호칭|시간대/.test(clean)
    add('profile', explicitProfileCue ? 0.20 : 0.06)
    add('decision', explicitProfileCue ? 0.10 : 0.22)
    scores.history = Math.max(0, scores.history - 0.18)
    scores.event = Math.max(0, scores.event - 0.12)
  }
  if ((/\b(wanted|prefer|preferred)\b/.test(lowered) || /원했|선호/.test(clean)) && !parseTemporalHint(clean)) {
    add('profile', 0.14)
    add('decision', 0.08)
    scores.history = Math.max(0, scores.history - 0.14)
  }
  if (/\b(source of truth)\b/.test(lowered) || /source of truth/.test(clean)) {
    add('decision', 0.26)
  }
  if (/\b(remove|removed|delete|drop|separate)\b/.test(lowered) && /\b(identity|profile|storage|persistence)\b/.test(lowered)) {
    add('decision', 0.28)
  }
  if (/\b(task|tasks|work|working|todo|next step|in progress|current work|current task|active task|active work|ongoing work|being worked on|work items|backlog)\b/.test(lowered)
    || /작업|진행|진행중|할 일|할일|다음|핵심 작업|주요 작업|액티브|현재 작업|계속 하고|손대고|작업 목록|남은 작업|백로그/.test(clean)) {
    add('task', 0.42)
    scores.decision = Math.max(0, scores.decision - 0.10)
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
  if (isRelationQuery(clean) || /\b(project|service|tool|system|relation|integrates|uses|depends|client|server|frontend|backend|pair|pairing|boundary|ownership|integration point)\b/.test(lowered)
    || /관계|역할 분리|프로젝트|서비스|도구|시스템|어디에 쓰여|어디 쓰여|클라|서버|프론트|백엔드|짝|쌍|경계|소유권|연결점/.test(clean)) {
    add('decision', 0.38)
    scores.security = Math.max(0, scores.security - 0.08)
    scores.profile = Math.max(0, scores.profile - 0.12)
  }
  if (/\b(related|pairing|pair|connect|connected|integration point|role split|where used|used for|ownership)\b/.test(lowered) || /연결|관계|연결점|역할 분리|용도|소유권/.test(clean)) {
    add('decision', 0.40)
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
    if (/구현|동작|hooks|자동화|설정|위치|implement|config|where/.test(clean.toLowerCase())) {
      add('policy', 0.30)
    } else {
      add('event', 0.22)
    }
  }
  if (/\b(identity|secret|credential|api key|sensitive)\b/.test(lowered)) {
    scores.security = Math.max(0, scores.security - 0.08)
  }
  if (/\b(who does|who handles|external search|internal recall)\b/.test(lowered) || /누가 하고|누가 해|외부 검색|내부 리콜/.test(clean)) {
    add('decision', 0.24)
    scores.security = Math.max(0, scores.security - 0.08)
  }
}
