# claude2bot 개발/일반 업무 분리 메모리 시스템 — 최종 기획서 v2

> 2026-03-31 | Memory System v2 확장 — 개발 작업 메모리 분리

---

## 목차

1. [개요](#1-개요)
2. [목표](#2-목표)
3. [설계 원칙](#3-설계-원칙)
4. [분리 축: workstream 기반](#4-분리-축-workstream-기반)
5. [개발 작업 저장 구조](#5-개발-작업-저장-구조)
6. [검색/회상: dev bias routing](#6-검색회상-dev-bias-routing)
7. [누적 규칙: claim_key 기반](#7-누적-규칙-claim_key-기반)
8. [context.md Dev Worklog 섹션](#8-contextmd-dev-worklog-섹션)
9. [git 정보 반영](#9-git-정보-반영)
10. [current_state 규칙](#10-current_state-규칙)
11. [last_major_touch 대체](#11-last_major_touch-대체)
12. [구현 단계](#12-구현-단계)
13. [성공 지표](#13-성공-지표)
14. [기존 구조와의 관계](#14-기존-구조와의-관계)

---

## 1. 개요

claude2bot은 SQLite 기반 장기기억 시스템을 운영 중이다. 3-Cycle 자동 학습(cycle1 실시간 추출, cycle2 일간 통합, cycle3 주간 디케이), 7개 인텐트 분류, 하이브리드 5종 검색, 14팩터 리랭킹, Ebbinghaus 망각곡선을 갖추고 있다.

현재 메모리는 **하나의 풀**에 일반 대화, 업무 상태, 개발 작업, 버그 수정, 구조 결정이 함께 섞여 있다. 이 기획서는 개발 메모리와 일반 업무 메모리를 workstream 기반으로 분리하여, 각 영역의 회상 정확도를 높이는 설계를 정의한다.

### 현재 문제

| 문제 | 증상 | 원인 |
|------|------|------|
| 개발 이력 혼입 | 일반 업무 질의("오늘 일정 알려줘")에 코드 수정 이력이 끼어나옴 | 모든 메모리가 동일 풀, intent만으로 분리 불충분 |
| 개발 정보 매몰 | 개발 질의("memory.mjs 어디 수정했지")에 필요한 정보가 일반 메모리에 묻힘 | 파일/심볼 기반 검색 경로 없음 |
| 작업 단위 비가시성 | "무엇을 많이 수정했고 지금 상태가 어떤가"가 작업 단위로 보이지 않음 | task에 current_state/next_step 미활용, entity_links 미연결 |
| 세션 복구 비용 | 다음 세션에서 개발 흐름 이어받을 때 맥락 복구 비용이 큼 | context.md에 개발 상태 전용 섹션 없음 |

---

## 2. 목표

1. **다음 세션에서 "최근 무엇을 수정했는가" 바로 회상** — context.md Dev Worklog로 즉시 복구
2. **개발 질의에서 일반 업무 메모리 혼입 감소** — dev bias routing + workstream 필터
3. **일반 업무 질의에서 개발 디테일 과노출 감소** — dev workstream 자동 제외
4. **개발 관련 recall top-1 정확도 향상** — entity 기반 검색 강화
5. **current_state/next_step 회수율 향상** — task 필드 활용 + Dev Worklog 섹션

---

## 3. 설계 원칙

1. **테이블 추가 없음** — 기존 tasks, propositions, entities, entity_links, facts 재사용
2. **인텐트 체계 유지** — 8번째 intent 추가하지 않음, dev bias 보정만 적용
3. **검색 파이프라인 변경 최소** — 기존 `searchRelevantHybrid()` 위에 dev bias layer만 추가
4. **점진적 적용** — 3단계로 나누어 각 단계마다 검증 후 다음 단계 진행
5. **기존 검증 완료 구조 보존** — 5레이어 전처리, 하이브리드 5종 검색, Ebbinghaus 랭킹 그대로

---

## 4. 분리 축: workstream 기반

### 4.1 왜 task_type이 아닌 workstream인가

task_type 필드를 추가하면:
- 검색 시 `WHERE task_type = ?` 조건 분기
- 리랭크 시 type cap 조건 증가
- classifyQueryIntent에 type 기반 분기 추가
- 모든 upsert 경로에 task_type 판단 로직 필요

이미 facts와 tasks 테이블에 `workstream TEXT` 컬럼이 존재한다. 이를 활용하면 추가 스키마 변경 없이 분류가 가능하다.

### 4.2 workstream 네이밍 규칙

```
general/{카테고리}     — 일반 업무
dev/{프로젝트}/{영역}   — 개발 작업
```

**일반 업무 예시:**

| workstream | 설명 |
|------------|------|
| `general/일정` | 캘린더, 미팅, 약속 |
| `general/업무` | 비개발 업무, 관리, 커뮤니케이션 |
| `general/생활` | 일상, 취미, 건강 |

**개발 작업 예시:**

| workstream | 설명 |
|------------|------|
| `dev/claude2bot/memory` | claude2bot 메모리 시스템 |
| `dev/claude2bot/scheduler` | claude2bot 스케줄러 |
| `dev/claude2bot/mcp` | claude2bot MCP 도구 |
| `dev/projectaa/client` | ProjectAA 클라이언트 |
| `dev/projectaa/server` | ProjectAA 서버 |
| `dev/gamerscroll/crawler` | GamerScroll 크롤러 |
| `dev/homepage/frontend` | Homepage 프론트엔드 |

### 4.3 분류 규칙

```
workstream이 'dev/'로 시작하면 → 개발 메모리
그 외 → 일반 메모리
```

기존 `normalizeWorkstream()` 함수는 이미 소문자 변환 + 특수문자 정규화를 수행한다:

```javascript
// 기존 코드 (memory.mjs:254)
function normalizeWorkstream(value) {
  const clean = String(value ?? '').trim().toLowerCase()
  if (!clean) return ''
  return clean
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
}
```

추가 필요한 헬퍼:

```javascript
function isDevWorkstream(workstream) {
  return normalizeWorkstream(workstream).startsWith('dev-')
  // normalizeWorkstream이 '/'를 '-'로 변환하므로 'dev/'는 'dev-'가 됨
}
```

> **주의**: `normalizeWorkstream()`은 `/`를 `-`로 변환한다. 따라서 DB에 저장되는 실제 값은 `dev-claude2bot-memory` 형태이다. 네이밍 규칙의 `dev/claude2bot/memory`는 사람이 읽는 표기이고, 코드에서 비교할 때는 `dev-` 접두사로 판별한다.

### 4.4 workstream 할당 시점

cycle1(실시간 추출)에서 LLM이 fact/task를 추출할 때 workstream도 함께 추출한다:

```
추출 프롬프트에 추가:
- workstream: 이 항목이 속하는 작업 영역.
  - 코드 파일, 함수, 버그, 브랜치, PR 관련이면 "dev/{프로젝트명}/{영역}"
  - 일반 업무/일상이면 "general/{카테고리}"
  - 판단 불가 시 빈 문자열
```

기존에 workstream 없이 저장된 fact/task는 cycle2 교정 시 소급 할당한다.

---

## 5. 개발 작업 저장 구조

### 5.1 task 테이블 활용

기존 tasks 테이블 스키마 (변경 없음):

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL UNIQUE,
  task_key TEXT,
  details TEXT,              -- ← current_state + next_step 저장
  workstream TEXT,           -- ← dev/claude2bot/memory 등
  stage TEXT NOT NULL DEFAULT 'planned',
  evidence_level TEXT NOT NULL DEFAULT 'claimed',
  status TEXT NOT NULL DEFAULT 'active',
  priority TEXT NOT NULL DEFAULT 'normal',
  confidence REAL NOT NULL DEFAULT 0.5,
  first_seen TEXT,
  last_seen TEXT,
  source_episode_id INTEGER,
  task_key TEXT,
  retrieval_count INTEGER NOT NULL DEFAULT 0,
  last_retrieved_at TEXT
);
```

**개발 task의 details 필드 활용 규칙:**

```
details 필드에 structured text로 저장:

current_state: live subset pass, fixture history top-1 remains unstable
next_step: tune task/history top-1
```

- `current_state`: 반드시 한 줄 요약 (섹션 10 참조)
- `next_step`: 다음에 해야 할 일 한 줄
- cycle1 추출 시 LLM에 current_state/next_step 추출을 명시적으로 요청
- 기존 `composeTaskDetails()` 함수를 확장하여 파싱/포맷팅

**details 파싱 헬퍼:**

```javascript
function parseTaskDetails(details) {
  const text = String(details ?? '').trim()
  const currentState = text.match(/current_state:\s*(.+)/)?.[1]?.trim() ?? ''
  const nextStep = text.match(/next_step:\s*(.+)/)?.[1]?.trim() ?? ''
  const rest = text
    .replace(/current_state:\s*.+/, '')
    .replace(/next_step:\s*.+/, '')
    .trim()
  return { currentState, nextStep, description: rest }
}

function formatTaskDetails({ currentState, nextStep, description }) {
  const parts = []
  if (description) parts.push(description)
  if (currentState) parts.push(`current_state: ${currentState}`)
  if (nextStep) parts.push(`next_step: ${nextStep}`)
  return parts.join('\n')
}
```

### 5.2 entity + entity_links 활용

기존 entities 테이블 (변경 없음):

```sql
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
```

기존 entity_links 테이블 (변경 없음):

```sql
CREATE TABLE IF NOT EXISTS entity_links (
  id INTEGER PRIMARY KEY,
  entity_id INTEGER NOT NULL REFERENCES entities(id),
  linked_type TEXT NOT NULL,    -- 'task', 'fact', 'proposition'
  linked_id INTEGER NOT NULL,
  source_episode_id INTEGER,
  strength REAL NOT NULL DEFAULT 1,
  UNIQUE(entity_id, linked_type, linked_id)
);
```

**개발 entity_type 확장:**

현재 entity_type 기본값은 `'thing'`이다. 개발 작업을 위해 다음 값을 추가 사용한다:

| entity_type | 예시 name | 설명 |
|-------------|-----------|------|
| `file` | `memory.mjs` | 소스 파일 |
| `symbol` | `classifyQueryIntent` | 함수, 클래스, 변수 |
| `bug` | `transcript contamination` | 버그/이슈 |
| `branch` | `feat/dev-memory` | Git 브랜치 |
| `pr` | `#42` | Pull Request |

> entity_type은 TEXT 컬럼이므로 enum 제약 없이 새 값을 바로 사용할 수 있다. DDL 변경 불필요.

**entity_links 연결 패턴:**

```
entity(file, "memory.mjs")
  ├─ linked_type='task',        linked_id=task.id        (어떤 작업에서 건드렸는지)
  ├─ linked_type='proposition', linked_id=proposition.id  (어떤 변경 이력이 있는지)
  └─ linked_type='fact',        linked_id=fact.id         (관련 설계 결정)

entity(bug, "transcript contamination")
  ├─ linked_type='task',        linked_id=task.id
  └─ linked_type='proposition', linked_id=proposition.id  (수정 이력)

entity(branch, "feat/dev-memory")
  └─ linked_type='task',        linked_id=task.id
```

**files_touched, bugs_touched를 task JSON에 넣지 않는 이유:**
- entity_links를 통한 그래프 쿼리가 가능해짐
- 파일명으로 "이 파일을 건드린 모든 작업" 역방향 조회 가능
- task details가 비대해지지 않음
- 검색 시 entity 기반 필터링 가능

**entity 기반 조회 예시:**

```sql
-- "memory.mjs를 건드린 모든 작업"
SELECT t.*
FROM tasks t
JOIN entity_links el ON el.linked_type = 'task' AND el.linked_id = t.id
JOIN entities e ON e.id = el.entity_id
WHERE e.name = 'memory.mjs' AND e.entity_type = 'file'
ORDER BY t.last_seen DESC;

-- "특정 작업에서 건드린 모든 파일"
SELECT e.name, e.entity_type
FROM entities e
JOIN entity_links el ON el.entity_id = e.id
WHERE el.linked_type = 'task' AND el.linked_id = ?
  AND e.entity_type IN ('file', 'symbol', 'bug');

-- "특정 버그와 관련된 변경 이력"
SELECT p.*
FROM propositions p
JOIN entity_links el ON el.linked_type = 'proposition' AND el.linked_id = p.id
JOIN entities e ON e.id = el.entity_id
WHERE e.name = 'transcript contamination' AND e.entity_type = 'bug';
```

### 5.3 propositions 확장

기존 propositions 테이블 (변경 없음):

```sql
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
  UNIQUE(subject_key, proposition_kind, text)
);
```

**개발 전용 proposition_kind 추가:**

| proposition_kind | 설명 | 예시 |
|-----------------|------|------|
| `dev_change` | 코드 변경 + 버그 수정 요약 | "memory.mjs에서 episode kind 필터를 message로 변경하여 22배 bloat 해결" |
| `dev_decision` | 설계/구조 결정 | "task_type 필드 대신 workstream 기반 분류 채택" |
| `dev_milestone` | git/배포/릴리즈 시점 기록 | "commit d0c73ca: Memory v2 Phase 1 완료" |

> proposition_kind도 TEXT 컬럼이므로 새 값을 바로 사용할 수 있다. 기존 `propositionKindForFact()` 함수는 fact_type/slot에서 kind를 파생하는데, 개발 proposition은 cycle1에서 직접 kind를 지정하여 삽입한다.

**subject_key 규칙:**

- 개발 proposition의 subject_key는 workstream 값을 사용
- 예: `dev-claude2bot-memory` (normalizeWorkstream 적용 후)
- 이렇게 하면 `idx_propositions_subject` 인덱스를 활용한 workstream별 조회가 가능

**proposition 데이터 흐름:**

```
[사용자 대화]
  → cycle1 추출: "memory.mjs에서 episode kind='message' 필터 추가"
  → proposition 생성:
    subject_key = "dev-claude2bot-memory"
    proposition_kind = "dev_change"
    text = "episode kind 필터를 message로 변경하여 candidate 22배 bloat 해결"
    occurred_on = "2026-03-30"
  → entity_links 생성:
    entity(file, "memory.mjs") → proposition
    entity(bug, "candidate bloat") → proposition
```

### 5.4 facts 활용

기존 facts 테이블의 workstream 필드를 그대로 활용한다. 개발 관련 설계 결정/제약은 `dev/` workstream으로 저장:

```
fact_type: "decision"
workstream: "dev/claude2bot/memory"
text: "LLM CRUD 대신 코드 기반 CRUD 채택 — 벡터 유사도 + slot 충돌 + supersede"
claim_key: "decision:dev-claude2bot-memory:llm-crud-code-based"
```

---

## 6. 검색/회상: dev bias routing

### 6.1 왜 8번째 intent가 아닌 bias인가

현재 인텐트 체계 (7개):

```javascript
const scores = {
  profile: 0,   // 프로필/선호
  task: 0,      // 작업 상태
  decision: 0,  // 설계 결정
  policy: 0,    // 정책/규칙
  security: 0,  // 보안/자격증명
  event: 0,     // 과거 이벤트
  history: 0,   // 대화 이력
}
```

`development` intent를 추가하면:
- `INTENT_PROTOTYPES`에 프로토타입 벡터 세트 추가 필요
- 프로토타입 벡터가 기존 7개 intent의 코사인 유사도 공간을 교란
- `getIntentTypeCaps()`, `getIntentSubtypeBonus()`, `shouldKeepRerankItem()` 등 모든 리랭크 분기에 case 추가
- `DEFAULT_MEMORY_TUNING`에 development 관련 가중치 전부 추가
- 초기 프로토타입 벡터 품질 검증 비용

대신, 기존 `classifyQueryIntent()` 안에서 **dev keyword를 감지하고 기존 intent 점수를 보정**하는 방식을 채택한다.

### 6.2 dev keyword 감지

`classifyQueryIntent()` 내부에서 `applyLexicalIntentHints()` 호출 직후 dev bias를 적용한다:

```javascript
// classifyQueryIntent 내부, applyLexicalIntentHints(clean, scores) 이후

const devBias = detectDevQueryBias(clean)
if (devBias > 0) {
  scores.task    += devBias * 0.25     // 작업 상태 부스트
  scores.decision += devBias * 0.15    // 설계 결정 부스트
  scores.profile  = Math.max(0, scores.profile - devBias * 0.15)   // 프로필 억제
  scores.event    = Math.max(0, scores.event - devBias * 0.08)     // 이벤트 억제
}
```

**detectDevQueryBias 함수:**

```javascript
function detectDevQueryBias(query) {
  const lower = query.toLowerCase()
  let score = 0

  // 영어 키워드
  const enKeywords = [
    /\b(file|function|class|method|variable|module|component)\b/,
    /\b(bug|fix|patch|hotfix|debug|error|crash|exception)\b/,
    /\b(commit|branch|merge|rebase|pr|pull request|push)\b/,
    /\b(refactor|implement|deploy|build|compile|test)\b/,
    /\b(api|endpoint|schema|migration|query|index)\b/,
    /\b(import|export|require|dependency|package)\b/,
  ]

  // 한국어 키워드
  const koKeywords = [
    /파일|함수|클래스|메서드|변수|모듈|컴포넌트/,
    /버그|수정|패치|디버그|에러|크래시|오류/,
    /커밋|브랜치|머지|리베이스|푸시/,
    /리팩토링|구현|배포|빌드|컴파일|테스트/,
    /스키마|마이그레이션|쿼리|인덱스/,
  ]

  // 파일 확장자 패턴
  const filePatterns = /\.(mjs|js|ts|tsx|jsx|py|cs|json|md|sql|yaml|yml|csv)\b/

  for (const re of enKeywords) { if (re.test(lower)) score += 0.3 }
  for (const re of koKeywords) { if (re.test(lower)) score += 0.3 }
  if (filePatterns.test(lower)) score += 0.5

  return Math.min(score, 1.0)  // 0~1 범위로 클램프
}
```

### 6.3 workstream 필터 자동 적용

dev bias가 감지되면(devBias > 0.3), 검색 시 `workstream LIKE 'dev-%'` 필터를 자동 적용한다:

```javascript
// searchRelevantHybrid 내부
const devBias = detectDevQueryBias(clean)
const workstreamFilter = devBias > 0.3 ? 'dev-%' : null

// fact/task seed 쿼리에 workstream 조건 추가
if (workstreamFilter) {
  // dev 질의: dev workstream 우선, 일반도 낮은 가중치로 포함
  // → hard filter가 아닌 soft boost (dev workstream 결과에 +0.2 가산)
}
```

**soft boost 방식 채택 이유:**
- hard filter(`WHERE workstream LIKE 'dev-%'`)는 개발 관련이면서 workstream이 미할당된 기존 메모리를 놓침
- 대신 dev workstream 결과에 점수 가산하여 상위 노출시키되, 일반 결과도 하위에 포함

### 6.4 일반 질의 시 개발 메모리 억제

dev bias가 낮은 일반 질의(devBias < 0.1)에서는 리랭크 단계에서 `dev-` workstream 결과를 감점한다:

```javascript
// computeSecondStageRerankScore 확장
if (!isDevQuery && item.workstream?.startsWith('dev-')) {
  score *= 0.6  // 개발 메모리 40% 감점
}
```

### 6.5 향후 독립 intent 승격 경로

데이터가 충분히 쌓인 후(dev workstream proposition 100개+), development를 독립 intent로 승격할 수 있다:

1. dev_change, dev_decision, dev_milestone proposition 텍스트 수집
2. 프로토타입 벡터 6~9개 생성
3. `INTENT_PROTOTYPES.development` 추가
4. 리랭크 분기에 development case 추가
5. A/B 비교 후 확정

현 단계에서는 bias만으로 충분하며, 독립 intent는 Phase 3 이후 데이터 기반으로 결정한다.

---

## 7. 누적 규칙: claim_key 기반

### 7.1 동일 작업 판별

기존 `deriveClaimKey()` 함수가 fact의 고유 키를 생성한다:

```javascript
// 기존 코드 (memory.mjs:270)
function deriveClaimKey(factType, slot = '', text = '', workstream = '') {
  const normalizedType = normalizeFactType(factType)
  const normalizedSlot = normalizeFactSlot(slot)
  const normalizedWorkstream = normalizeWorkstream(workstream)
  const normalizedText = cleanMemoryText(text).toLowerCase()
  const canonicalValue = canonicalKeyTokens(normalizedText).join('-')
    || createHash('sha1').update(normalizedText).digest('hex').slice(0, 16)
  return [normalizedType, normalizedWorkstream, normalizedSlot || canonicalValue]
    .filter(Boolean).join(':').slice(0, 160)
}
```

task에도 동일한 패턴이 적용된다:

```javascript
// 기존 코드 (memory.mjs:284)
function deriveTaskKey(title = '', workstream = '') {
  const normalizedWorkstream = normalizeWorkstream(workstream)
  // ...
}
```

### 7.2 cycle1에서의 기존 작업 매칭

cycle1 실시간 추출 시, LLM에 **현재 활성 task 목록**을 함께 제공하여 "새 작업인지 기존 작업의 업데이트인지" 판단하게 한다:

```
cycle1 추출 프롬프트 추가 컨텍스트:

현재 활성 개발 작업:
1. [task_key: dev-claude2bot-memory:recall-memory] "recall_memory MCP 도구 구현" — in_progress
2. [task_key: dev-claude2bot-memory:cycle1-provider] "cycle1 provider 추상화" — planned

이 대화에서 추출한 항목이 기존 작업의 업데이트인 경우, 해당 task_key를 명시하세요.
새 작업인 경우, task_key를 비워두세요.
```

**활성 task 목록 조회:**

```sql
SELECT task_key, title, stage, status
FROM tasks
WHERE status IN ('active', 'in_progress', 'paused')
  AND workstream LIKE 'dev-%'
ORDER BY last_seen DESC
LIMIT 10;
```

### 7.3 누적 대상과 갱신 규칙

| 항목 | 누적 방식 | 갱신 규칙 |
|------|----------|----------|
| `dev_change` propositions | 계속 추가 (append) | 동일 subject_key + 동일 content hash → UNIQUE 충돌로 자동 skip |
| `dev_decision` propositions | 계속 추가 | superseded_by로 이전 결정 연결 |
| `dev_milestone` propositions | 계속 추가 | 시점별 기록이므로 중복 불가 |
| entity_links | upsert | strength 갱신, UNIQUE(entity_id, linked_type, linked_id) |
| task.details (current_state) | 덮어쓰기 | 최신 값이 항상 정확 |
| task.details (next_step) | 덮어쓰기 | 최신 값이 항상 정확 |
| task.stage | 덮어쓰기 | planned → in_progress → done |
| task.last_seen | 덮어쓰기 | upsert 시 자동 갱신 |

### 7.4 중복 방지 메커니즘

1. **파일명 정규화 dedupe**: entity(file, ...) 생성 시 경로 정규화
   ```javascript
   function normalizeFileName(name) {
     return String(name ?? '').trim()
       .replace(/^.*[\/\\]/, '')  // 경로 제거, 파일명만
       .toLowerCase()
   }
   ```

2. **변경 요약 content hash dedupe**: proposition 삽입 전 text의 SHA-1 앞 16자리 비교
   ```javascript
   function dedupePropositionKey(subjectKey, kind, text) {
     const hash = createHash('sha1')
       .update(cleanMemoryText(text).toLowerCase())
       .digest('hex').slice(0, 16)
     return `${subjectKey}:${kind}:${hash}`
   }
   ```

3. **UNIQUE 제약**: propositions 테이블의 `UNIQUE(subject_key, proposition_kind, text)` 제약이 최종 방어선

---

## 8. context.md Dev Worklog 섹션

### 8.1 현재 context.md 구조

```markdown
## Bot
## User
## Core Memory
## Decisions
## Ongoing
## Signals
## Recent
```

### 8.2 Dev Worklog 섹션 추가

`buildContextText()` 함수에 `## Dev Worklog` 섹션을 추가한다. 기존 `## Ongoing` 바로 아래에 위치:

```markdown
## Dev Worklog
- memory retrieval stabilization [dev/claude2bot/memory]
  - touched: memory.mjs, memory-retrievers.mjs
  - bugs: transcript contamination, profile-language ranking
  - state: live subset pass, fixture edge cases remain
  - next: tune task/history top-1

- cycle1 provider abstraction [dev/claude2bot/memory]
  - touched: memory-cycle.mjs, embedding-provider.mjs
  - state: planned
  - next: ollama HTTP API 연동
```

### 8.3 Dev Worklog 생성 쿼리

```javascript
buildDevWorklog() {
  // 1. dev workstream의 활성 task 조회
  const devTasks = this.db.prepare(`
    SELECT t.id, t.title, t.details, t.workstream, t.stage, t.status, t.last_seen
    FROM tasks t
    WHERE t.status IN ('active', 'in_progress', 'paused')
      AND t.workstream LIKE 'dev-%'
    ORDER BY
      CASE t.status WHEN 'in_progress' THEN 1 WHEN 'active' THEN 2 ELSE 3 END,
      t.last_seen DESC
    LIMIT 5
  `).all()

  if (devTasks.length === 0) return ''

  const lines = devTasks.map(task => {
    const { currentState, nextStep } = parseTaskDetails(task.details)
    const ws = task.workstream.replace(/-/g, '/')  // dev-claude2bot-memory → dev/claude2bot/memory

    // 2. 이 task에 연결된 entity 조회
    const entities = this.db.prepare(`
      SELECT e.name, e.entity_type
      FROM entities e
      JOIN entity_links el ON el.entity_id = e.id
      WHERE el.linked_type = 'task' AND el.linked_id = ?
      ORDER BY e.entity_type, e.last_seen DESC
    `).all(task.id)

    const files = entities.filter(e => e.entity_type === 'file').map(e => e.name)
    const bugs = entities.filter(e => e.entity_type === 'bug').map(e => e.name)

    const parts = [`- ${task.title} [${ws}]`]
    if (files.length > 0) parts.push(`  - touched: ${files.join(', ')}`)
    if (bugs.length > 0) parts.push(`  - bugs: ${bugs.join(', ')}`)
    if (currentState) parts.push(`  - state: ${currentState}`)
    if (nextStep) parts.push(`  - next: ${nextStep}`)

    return parts.join('\n')
  })

  return lines.join('\n\n')
}
```

### 8.4 buildContextText() 수정

```javascript
// buildContextText() 내부, ## Ongoing 섹션 이후에 추가:

// ## Dev Worklog — active dev tasks with entity context
const devWorklog = this.buildDevWorklog()
if (devWorklog) {
  parts.push(`## Dev Worklog\n${devWorklog}`)
}
```

### 8.5 세션 시작 시 즉시 개발 상태 복구

context.md는 session-start hook에서 주입된다. Dev Worklog 섹션이 포함되면, 새 세션 시작 시 Claude가 즉시 확인할 수 있다:

- "최근 무엇을 수정했는가" → Dev Worklog의 touched 필드
- "어떤 버그를 잡았는가" → Dev Worklog의 bugs 필드
- "현재 어떤 상태인가" → Dev Worklog의 state 필드
- "다음에 무엇을 해야 하는가" → Dev Worklog의 next 필드

---

## 9. git 정보 반영

### 9.1 원칙

git 자체를 메모리 본문으로 저장하지 않는다. raw diff, 긴 commit log, 해시만 단독 저장, 사소한 포맷 변경은 저장하지 않는다.

### 9.2 저장하는 것

git 정보는 **개발 작업의 상태 근거**로만 사용한다:

| git 이벤트 | 저장 형태 | 예시 |
|-----------|----------|------|
| commit | `dev_milestone` proposition | "commit d0c73ca: Memory v2 Phase 1 — 번역/rollup 제거 + 노이즈 정리" |
| branch 생성 | entity(branch, name) + entity_link → task | entity("feat/dev-memory", branch) → task |
| PR 생성/머지 | `dev_milestone` proposition + entity(pr, #N) | "PR #42 merged: dev memory separation" |
| 릴리즈/태그 | `dev_milestone` proposition | "v2.1.0 released: memory system v2" |

### 9.3 저장하지 않는 것

- raw diff (줄 단위 변경 내용)
- 긴 commit log 전문
- commit hash 단독 (의미 없음)
- 사소한 포맷 변경 (lint fix, typo 등)
- merge commit (내용 없는 병합)

### 9.4 dev_milestone 생성 시점

cycle1에서 대화 내용에 commit/push/deploy 언급이 있으면 자동으로 dev_milestone proposition을 생성한다. 또는 Phase 3에서 git hook 연동으로 자동 생성할 수 있다.

---

## 10. current_state 규칙

### 10.1 반드시 한 줄 요약

current_state는 task.details 필드 내에 `current_state: ` 접두사로 저장된다. 반드시 한 줄, 180자 이내로 유지한다.

**좋은 예시:**
- `live subset pass, fixture history top-1 remains unstable`
- `Phase 1 완료, Phase 2 recall_memory 구현 시작`
- `entity_links upsert 구현 완료, 검색 통합 대기`

**나쁜 예시:**
- `memory.mjs에서 classifyQueryIntent 함수를 수정하여 dev bias를 추가하고 searchRelevantHybrid에서 workstream 필터를 적용하도록 변경했으며 context.md에 Dev Worklog 섹션을 추가하는 작업이 진행 중` (너무 길고 상세)
- `작업 중` (너무 모호)

### 10.2 갱신 시점

| 시점 | 갱신 내용 |
|------|----------|
| cycle1 추출 | 대화 내용에서 상태 변화 감지 시 갱신 |
| cycle2 교정 | 하루 전체 대화를 보고 최종 상태로 교정 |
| 작업 완료 시 | status를 done으로 변경 + current_state를 완료 요약으로 갱신 |

### 10.3 cycle1 추출 프롬프트

```
개발 작업의 현재 상태를 한 줄로 요약하세요.
- 무엇이 작동하는지, 무엇이 남았는지를 중심으로
- 180자 이내
- 예: "live subset pass, fixture history top-1 remains unstable"
```

---

## 11. last_major_touch 대체

### 11.1 별도 필드 추가하지 않음

별도의 `last_major_touch` 필드를 추가하지 않는다. 기존 필드 조합으로 동일한 정보를 도출할 수 있다:

```
last_major_touch ≈ task.last_seen + task.evidence_level 조합
```

### 11.2 evidence_level 활용

tasks 테이블의 `evidence_level` 컬럼 (기존):

| evidence_level | 의미 |
|---------------|------|
| `claimed` | 대화에서 언급만 됨 |
| `observed` | 실제 코드 변경 확인됨 |
| `verified` | 테스트/빌드 통과 확인됨 |

**"최근 크게 건드린 작업" 쿼리:**

```sql
SELECT title, details, workstream, last_seen, evidence_level
FROM tasks
WHERE status IN ('active', 'in_progress')
  AND workstream LIKE 'dev-%'
  AND evidence_level IN ('observed', 'verified')
ORDER BY last_seen DESC
LIMIT 3;
```

evidence_level이 높고(observed/verified) last_seen이 최근인 task = 최근 크게 건드린 작업.

### 11.3 evidence_level 갱신 시점

| 이벤트 | evidence_level |
|--------|---------------|
| 대화에서 작업 언급 | `claimed` |
| 코드 파일 수정 감지 (entity(file) link 생성) | `observed` |
| commit/push 감지 (dev_milestone 생성) | `verified` |

---

## 12. 구현 단계

### Phase 1 (기반 구축)

| # | 작업 | 파일 | 상세 |
|---|------|------|------|
| 1-1 | `isDevWorkstream()` 헬퍼 추가 | memory.mjs | `normalizeWorkstream(ws).startsWith('dev-')` |
| 1-2 | workstream 네이밍 규칙 문서화 | cycle1 추출 프롬프트 | general/* vs dev/* 분류 지침 추가 |
| 1-3 | `parseTaskDetails()` / `formatTaskDetails()` 추가 | memory.mjs 또는 memory-text-utils.mjs | current_state, next_step 파싱 |
| 1-4 | cycle1 추출 프롬프트에 current_state, next_step 추출 지침 추가 | memory-cycle.mjs | 개발 task 추출 시 두 필드 명시적 요청 |
| 1-5 | entity_type에 file, symbol, bug, branch, pr 값 사용 시작 | memory-cycle.mjs | cycle1 추출 시 entity 생성 + entity_links 연결 |
| 1-6 | `buildDevWorklog()` 구현 | memory.mjs | Dev Worklog 섹션 생성 |
| 1-7 | `buildContextText()`에 Dev Worklog 섹션 추가 | memory.mjs | ## Ongoing 이후 ## Dev Worklog |

**Phase 1 완료 기준:**
- context.md에 Dev Worklog 섹션이 나타남
- 개발 task에 current_state/next_step이 저장됨
- entity_links를 통해 task ↔ file/bug 연결 가능

### Phase 2 (검색 강화)

| # | 작업 | 파일 | 상세 |
|---|------|------|------|
| 2-1 | `detectDevQueryBias()` 구현 | memory-query-plan.mjs 또는 memory-profile-utils.mjs | 한국어/영어 양방향 키워드 감지 |
| 2-2 | `classifyQueryIntent()`에 dev bias 적용 | memory.mjs | applyLexicalIntentHints 이후 호출 |
| 2-3 | 검색 시 dev workstream soft boost 적용 | memory.mjs (searchRelevantHybrid) | dev 질의 시 dev workstream 결과 가산 |
| 2-4 | 리랭크 시 일반 질의에서 dev 억제 | memory-ranking-utils.mjs | computeSecondStageRerankScore 확장 |
| 2-5 | proposition_kind에 dev_change, dev_decision, dev_milestone 추가 | memory-cycle.mjs | cycle1 추출 프롬프트 + upsert 경로 |
| 2-6 | claim_key 기반 누적 갱신 — 활성 task 목록을 cycle1에 주입 | memory-cycle.mjs | 기존 작업 매칭 로직 |
| 2-7 | `normalizeFileName()` dedupe 추가 | memory-text-utils.mjs | 파일 entity 정규화 |
| 2-8 | memory-tuning.mjs에 dev bias 가중치 추가 | memory-tuning.mjs | `devBias.queryThreshold`, `devBias.boostFactor` 등 |

**Phase 2 완료 기준:**
- 개발 질의 시 dev workstream 결과가 상위 노출
- 일반 질의 시 개발 디테일 혼입 감소
- dev_change/dev_decision/dev_milestone proposition이 정상 생성

### Phase 3 (고도화)

| # | 작업 | 파일 | 상세 |
|---|------|------|------|
| 3-1 | git 이벤트 연결 — dev_milestone 자동 생성 | memory-cycle.mjs 또는 별도 hook | commit/push 감지 시 proposition 생성 |
| 3-2 | 파일/심볼 기반 개발 recall 강화 | memory.mjs (recall_memory) | entity 기반 역방향 조회 지원 |
| 3-3 | 작업 종료 시 자동 snapshot 요약 | memory-cycle.mjs | task status=done 전환 시 최종 요약 proposition 생성 |
| 3-4 | development intent 독립 승격 평가 | memory.mjs | dev proposition 100개+ 시 프로토타입 벡터 생성 검토 |

**Phase 3 완료 기준:**
- git commit 시 자동 dev_milestone 기록
- "memory.mjs 수정 이력" 같은 파일 기반 recall이 정확히 작동
- 작업 완료 시 자동 요약이 생성되어 다음 세션에서 참조 가능

---

## 13. 성공 지표

### 13.1 정량 지표

| 지표 | 현재 (추정) | 목표 | 측정 방법 |
|------|-----------|------|----------|
| 개발 질의 recall top-1 정확도 | ~40% | 70%+ | fixture 기반 regression test |
| 일반 질의에 개발 메모리 혼입 비율 | ~30% | 10% 이하 | recall 결과에서 dev workstream 비율 측정 |
| 개발 질의에 일반 메모리 혼입 비율 | ~50% | 20% 이하 | recall 결과에서 non-dev workstream 비율 측정 |
| current_state 회수율 | 0% (미구현) | 80%+ | dev task 중 current_state 비어있지 않은 비율 |
| next_step 회수율 | 0% (미구현) | 70%+ | dev task 중 next_step 비어있지 않은 비율 |

### 13.2 정성 지표

- 다음 세션에서 "최근 무엇을 수정했는가" 질문에 즉시 정확한 답변
- "memory.mjs 어디 건드렸지" 같은 파일 기반 질문에 entity 경유 정확한 답변
- "오늘 일정 알려줘" 같은 일반 질문에 코드 수정 이력이 섞이지 않음
- context.md Dev Worklog로 개발 흐름 즉시 복구 (맥락 재구성 질문 0회)

### 13.3 측정 방법

기존 regression test 프레임워크 활용:
- `scripts/run-memory-fixture-regression.mjs` 에 dev 관련 fixture 추가
- 개발 질의 fixture: "memory.mjs 수정 이력", "최근 버그 수정", "cycle1 구현 상태"
- 일반 질의 fixture: "오늘 일정", "점심 뭐 먹을까", "이번 주 할 일"
- 각 fixture에서 recall top-5 중 workstream 분포 측정

---

## 14. 기존 구조와의 관계

### 14.1 테이블 변경 없음

| 테이블 | 변경 | 설명 |
|--------|------|------|
| episodes | 없음 | 에피소드 저장 구조 그대로 |
| memory_candidates | 없음 | candidate 스코어링 그대로 |
| facts | 없음 | workstream 컬럼 이미 존재, claim_key 이미 존재 |
| tasks | 없음 | workstream, task_key, details, stage, evidence_level 이미 존재 |
| entities | 없음 | entity_type TEXT — 새 값(file, symbol 등) 바로 사용 |
| entity_links | 없음 | linked_type, linked_id로 유연한 연결 |
| propositions | 없음 | proposition_kind TEXT — 새 값(dev_change 등) 바로 사용 |
| signals | 없음 | 변경 없음 |
| profiles | 없음 | 변경 없음 |
| memory_vectors | 없음 | 변경 없음 |

### 14.2 검색 파이프라인 변경

| 구성요소 | 변경 | 범위 |
|---------|------|------|
| `classifyQueryIntent()` | dev bias 추가 | 5줄 추가 |
| `detectDevQueryBias()` | 신규 함수 | ~30줄 |
| `searchRelevantHybrid()` | workstream soft boost | ~10줄 추가 |
| `computeSecondStageRerankScore()` | dev 억제 로직 | ~5줄 추가 |
| `buildContextText()` | Dev Worklog 섹션 | ~5줄 추가 |
| `buildDevWorklog()` | 신규 함수 | ~40줄 |

### 14.3 memory-tuning.mjs 확장

```javascript
// DEFAULT_MEMORY_TUNING에 추가
devBias: {
  queryThreshold: 0.3,       // dev bias가 이 값 이상이면 dev 질의로 판단
  taskBoost: 0.25,           // task intent 부스트량
  decisionBoost: 0.15,       // decision intent 부스트량
  profileSuppress: 0.15,     // profile intent 억제량
  eventSuppress: 0.08,       // event intent 억제량
  workstreamBoost: 0.2,      // dev workstream 결과 가산
  generalSuppress: 0.6,      // 일반 질의 시 dev 결과 감점 배율
}
```

### 14.4 recall_memory 도구 호환

기존 recall_memory MCP 도구 인터페이스는 변경하지 않는다. 내부적으로 dev bias가 자동 적용되어, 개발 관련 질의 시 dev workstream 결과가 자연스럽게 상위에 올라온다.

recall_memory의 `type` 파라미터에 `'dev'` 옵션을 추가하는 것은 Phase 3에서 검토한다. 현재는 `type: 'all'`로도 dev bias routing이 충분히 작동한다.

---

## 부록: 데이터 흐름 종합

```
[사용자 대화: "memory.mjs에서 episode kind 필터 추가해서 bloat 해결했어"]
  │
  ▼
[cycle1 실시간 추출] (10분 주기)
  ├─ task upsert:
  │    title: "memory retrieval stabilization"
  │    workstream: "dev/claude2bot/memory"
  │    details: "current_state: episode kind filter 적용 완료, bloat 해결\nnext_step: fixture regression 확인"
  │    task_key: "dev-claude2bot-memory:memory-retrieval-stabilization"
  │
  ├─ proposition insert:
  │    subject_key: "dev-claude2bot-memory"
  │    proposition_kind: "dev_change"
  │    text: "episode kind 필터를 message로 변경하여 candidate 22배 bloat 해결"
  │    occurred_on: "2026-03-30"
  │
  ├─ entity upsert:
  │    entity(file, "memory.mjs")
  │    entity(bug, "candidate bloat")
  │
  └─ entity_links upsert:
       entity("memory.mjs") → task
       entity("memory.mjs") → proposition
       entity("candidate bloat") → task
       entity("candidate bloat") → proposition

  │
  ▼
[context.md 갱신] (cycle2 또는 writeContextFile)
  ## Dev Worklog
  - memory retrieval stabilization [dev/claude2bot/memory]
    - touched: memory.mjs
    - bugs: candidate bloat
    - state: episode kind filter 적용 완료, bloat 해결
    - next: fixture regression 확인

  │
  ▼
[다음 세션 시작]
  → session-start hook이 context.md 주입
  → Claude가 Dev Worklog 즉시 확인
  → "최근 뭐 수정했지?" → "memory.mjs에서 episode kind 필터 적용하여 bloat 해결, 다음은 fixture regression"

  │
  ▼
[recall_memory 질의: "memory.mjs 수정 이력"]
  → detectDevQueryBias: ".mjs" 파일 확장자 감지 → devBias = 0.5
  → classifyQueryIntent: task +0.125, decision +0.075
  → searchRelevantHybrid: dev workstream soft boost +0.2
  → entity 기반 검색: entity(file, "memory.mjs") → linked propositions
  → 결과: dev_change proposition "episode kind 필터..." 상위 노출
```
