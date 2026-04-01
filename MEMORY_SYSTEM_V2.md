# claude2bot Memory System v2 — 설계 기획서

> 2026-03-30 | 인간 뇌 기억 구조 기반 AI 메모리 시스템

---

## 1. 개요

claude2bot의 메모리 시스템을 인간 뇌의 기억 구조를 모방하여 재설계한다.
장기/중기/단기 기억 + 실시간 주입 + 회상 시스템 + 3단계 정리 모델.

### 현재 문제
- 번역 후처리 35회+ LLM 호출 (업계 아무도 안 함)
- rollup 체인 (업계 아무도 안 씀)
- episode 3중 기록 → candidate 22배 중복
- consolidation 전 24시간 기억 공백
- memory-context에 노이즈 20~30%

### 목표
- LLM 호출: 64회/일 → ~5회/일
- 기억 반영 속도: 24시간 → 10분 (설정 가능)
- 노이즈: 20~30% → ~5%
- 기억 정확도: episode-only → 구조화 fact 기반

---

## 2. 아키텍처

```
┌─────────────────────────────────────────────┐
│              상시 주입 (context.md)            │
│  ┌─────────┐ ┌──────────┐ ┌───────────────┐ │
│  │ 장기기억 │ │ 중기기억  │ │   단기기억     │ │
│  │ Bot     │ │ Ongoing  │ │ Recent       │ │
│  │ User    │ │ (tasks)  │ │ (오늘+어제)   │ │
│  │ Core    │ │          │ │              │ │
│  │ Decision│ │          │ │              │ │
│  │ Signals │ │          │ │              │ │
│  └─────────┘ └──────────┘ └───────────────┘ │
└─────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────┐
│           실시간 주입 (매 메시지)              │
│  ┌──────────────┐ ┌───────────────────────┐ │
│  │ Current Time │ │ memory-context        │ │
│  │ (로컬 시간)   │ │ (threshold 0.9+ only) │ │
│  └──────────────┘ └───────────────────────┘ │
└─────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────┐
│         회상 시스템 (recall_memory)            │
│  Claude가 필요 시 자율적 검색                   │
│  ~70ms 응답, 원본 추적 (episode + line)        │
│  Dense + Sparse + Temporal + Seed + Focus    │
└─────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────┐
│         정리 모델 (3-Cycle)                   │
│  ┌─────────┐ ┌──────────┐ ┌───────────────┐ │
│  │ cycle1  │ │ cycle2   │ │   cycle3      │ │
│  │ 실시간   │ │ 데일리    │ │   주간        │ │
│  │ draft   │ │ 교정     │ │   장기 정리    │ │
│  │ extract │ │ 정제     │ │   프로필 재구성 │ │
│  └─────────┘ └──────────┘ └───────────────┘ │
└─────────────────────────────────────────────┘
```

---

## 3. context.md 구성

### 양식 (마크다운 기반)

```markdown
## Bot
[bot.md 내용 — 유저가 작성한 봇 페르소나/역할]
[+ signals DB에서 학습된 봇 적응 사항 보충]

## User
- name: JYP (학습)
- expertise: Unity, 게임개발 (학습)
- tone: casual (학습)
- language: ko (학습)

## Core Memory
- JWT 인증은 refresh token 방식으로 변경
- 한국어 선호, 존댓말

## Decisions
- REST over GraphQL 선택 (2026-03)
- 메모리 시스템 3-Cycle 아키텍처 도입 (2026-03)

## Ongoing
- 메모리 시스템 v2 구현 [in_progress]
- claude2bot Windows 호환성 개선 [done]

## Signals
- server-auth (0.8)
- memory-system (0.7)
- game-development (0.9)

## Recent
[오늘 daily summary]
[어제 daily summary]
```

### 데이터 소스

| 섹션 | 소스 | 갱신 시점 |
|------|------|----------|
| Bot | bot.md (유저 작성) + signals | cycle2 |
| User | profiles DB (100% 학습) | cycle2 |
| Core Memory | facts WHERE preference/constraint | cycle2 |
| Decisions | facts WHERE decision/fact | cycle2 |
| Ongoing | tasks WHERE active/in_progress | cycle2 |
| Signals | signals DB (score DESC) | cycle2 |
| Recent | daily summary 최근 2개 | cycle2 |

### 제거된 섹션
- ~~Identity~~ → User로 통합
- ~~Recent Summaries~~ → rollup 제거로 불필요
- ~~History~~ → Recent로 대체 (오늘+어제만)
- ~~Interests~~ → Signals로 통합

---

## 4. 실시간 주입

### Current Time
```
[2026. 3. 30. 오후 2:35]
유저 메시지
```
- `new Date().toLocaleString()` — OS 로케일/타임존 자동
- 매 메시지마다 ~15토큰 추가 (무시 가능)
- MCP instructions의 고정 `Current time` 제거

### memory-context
- type별 composite gate + overlap 기반으로 높은 확신 항목만 자동 주입
- 낮은 확신 / 타입 불일치 항목은 recall_memory로 위임
- `<system-reminder>` 태그로 감싸서 터미널 노출 방지 (테스트 필요)
- 중복 제거: episode kind 필터(message/turn 기본, transcript는 debug 전용) + content hash dedup

---

## 5. 회상 시스템 (recall_memory)

### MCP 도구

```json
{
  "name": "recall_memory",
  "description": "Search memory DB for relevant facts, tasks, signals, episodes. Use when you need to verify or recall past information.",
  "inputSchema": {
    "properties": {
      "query": { "type": "string", "description": "Search query" },
      "type": { "enum": ["all", "facts", "tasks", "signals", "episodes"], "default": "all", "description": "Memory type filter" },
      "timerange": { "type": "string", "description": "e.g. today, this-week, 2026-03" },
      "source": { "type": "boolean", "default": false, "description": "Include source episode + line" },
      "limit": { "type": "number", "default": 5 }
    },
    "required": ["query"]
  }
}
```

### 검색 엔진
- 기존 `searchRelevantHybrid()` 재사용
- Dense (벡터 KNN) + Sparse (FTS5 BM25) + Temporal + Seed + Focus
- 전부 로컬 실행, LLM 호출 0회
- 응답 시간: ~70ms

### 결과 양식

```
[2026-03-28 14:35:21] JWT → refresh token 변경 (fact, 3회 언급)
  └ source: session abc-def, line 142

[2026-03-29 10:20:00] RAG 시스템 구축 완료 (task, done)
  └ source: session xyz-123, line 89

[2026-03-30 07:38:00] 3-Cycle 메모리 설계 논의 (episode, 오늘)
  └ source: session current, line 456
```

- 시:분:초 (로컬 타임존)
- 내용 + 타입 + mention 횟수
- source_episode_id + source_line (원본 추적)

### Claude 사용 시나리오
1. memory-context에 관련 정보 있음 → 바로 답변
2. 애매하거나 없음 → recall_memory 호출 → 사실 확인 후 답변
3. 더 자세히 필요 → 원본 episode 발췌 요청

---

## 6. 정리 모델 (3-Cycle)

### cycle1 — 실시간 Draft Extraction

| 항목 | 값 |
|------|-----|
| 주기 | 설정 가능 (per-turn / 5m / 10m / 30m / 1h) |
| 기본값 | 10m |
| 모델 | 로컬 (ollama) 또는 경량 API |
| 역할 | 새 episodes에서 facts/tasks/signals draft 추출 |
| 비용 | 로컬 모델 시 0원 |
| mode | extract (경량) / extract+update (고품질, Mem0 CRUD) |

**동작 흐름:**
1. 마지막 실행 이후 새 episodes 수집
2. 5레이어 전처리 (cleanMemoryText, looksLowSignal, candidateScore)
3. candidate에 source_line 저장
4. provider/model로 fact extraction 호출
5. upsertFacts/upsertTasks/upsertSignals에 전달
6. 즉시 recall_memory 검색 가능

### cycle2 — 데일리 교정

| 항목 | 값 |
|------|-----|
| 주기 | 1일 1회 (cron, 기본 03:00) |
| 모델 | sonnet (claude-cli) |
| 역할 | cycle1 draft 교정 + 정제 + daily summary + context.md 갱신 |
| LLM 호출 | ~3회 |

**동작 흐름:**
1. cycle1이 추출한 draft facts 검증/보완
2. consolidation 프롬프트에 기존 관련 메모리 top-5 주입 (Mem0 CRUD 패턴)
3. 중복/모순 해결 (ADD/UPDATE/DELETE/NOOP 판단)
4. daily summary 생성 (History/Recent 섹션 소스)
5. contextualize (검색용 문맥 설명 생성)
6. context.md 갱신

### cycle3 — 주간 장기 정리

| 항목 | 값 |
|------|-----|
| 주기 | 주 1회 (cron, 기본 일요일 03:00) |
| 모델 | sonnet (claude-cli) |
| 역할 | 장기 프로필 재구성 + stale 정리 + lifetime 갱신 |
| LLM 호출 | ~1회 |

**동작 흐름:**
1. DB에서 고빈도/고신뢰 facts + profiles 쿼리 → 프로필 재구성
2. stale 데이터 정리 (soft delete → hard delete 또는 archive)
3. mention_count / retrieval_count 기반 메모리 품질 평가
4. Heat 기반 장기 기억 승격/강등 (MemoryOS 패턴)
5. lifetime summary 갱신
6. context.md 최종 갱신

---

## 7. 설정 구조

```json
{
  "memory": {
    "cycle1": {
      "interval": "10m",
      "provider": {
        "connection": "ollama",
        "model": "qwen3.5:4b"
      },
      "mode": "extract"
    },
    "cycle2": {
      "schedule": "03:00",
      "provider": {
        "connection": "cli",
        "model": "sonnet",
        "effort": "medium"
      }
    },
    "cycle3": {
      "schedule": "sunday 03:00",
      "provider": {
        "connection": "cli",
        "model": "sonnet",
        "effort": "medium"
      }
    }
  }
}
```

### Provider 옵션

| connection | 실행 방식 | 비용 | 예시 |
|-----------|----------|------|------|
| ollama | Ollama HTTP API (localhost:11434) | 무료 | qwen3.5:4b, qwen3:30b-a3b |
| cli | `claude --print --model X --effort Y` | API | sonnet, opus |
| api | Anthropic/OpenAI HTTP 직접 호출 | API | haiku, gpt-5.4 |
| codex | `codex exec -c model_reasoning_effort=X` | API | gpt-5.4 xhigh |

### 로컬 모델 가이드

| 환경 | 추천 모델 | RAM 사용 |
|------|----------|---------|
| M4 16GB | Qwen3.5-4B | 3.4GB |
| M5 32GB+ | Qwen3-30B-A3B (MoE) | 19GB |
| RTX 3070 8GB | Qwen3-8B | 5.2GB |
| API 선호 | haiku / gpt-5.4 | 0 |

---

## 8. Instructions 재구성

### MCP Instructions (서버 시작 1회, 고정)
- Safety rule
- BASE_INSTRUCTIONS (통신 규칙 + System Tag Privacy)
- settings.default.md (행동 규칙 — Schedule Behavior Guide 등)

### Session-Start Hook (세션마다 갱신)
- bot.md (봇 페르소나)
- context.md (학습된 프로필 + 메모리 요약)

### settings.default.md 중복 제거
- MCP instructions에서만 주입
- session-start hook에서 제거

---

## 9. 프로필 학습

### 유저 프로필
- **profile.md / profile.json 없음** — 100% 대화 학습
- profiles DB: name, language, tone, expertise, role 등 key-value
- signals DB: 대화 패턴에서 자동 감지
- 첫 대화부터 학습 시작 (부트스트랩 불필요)

### 봇 페르소나
- **bot.md** — 유저가 직접 작성 (선택적)
- signals DB가 대화 패턴에서 자동 보충
- bot.md 기반 + signals 학습 = context.md Bot 섹션
- 충돌 시 유저 작성(bot.md)이 우선

---

## 10. 즉시 수정 사항 (Phase 1)

| # | 수정 | 효과 |
|---|------|------|
| 1 | 번역 제거 (normalize 함수/호출 전부) | LLM 35회 → 0 |
| 2 | rollup 제거 (weekly/monthly/yearly) | LLM 3회 → 0 |
| 3 | episode 중복 방지 (candidate 생성 시 kind='message' 필터) | 22배 bloat → 1배 |
| 4 | dedup key 개선 (entity_id → content hash) | 검색 중복 제거 |
| 5 | context.md fallback 중복 방지 (kind 필터 + DISTINCT) | 50% 중복 제거 |
| 6 | recent topics kind 필터 | 토픽 중복 방지 |
| 7 | memory-context 터미널 노출 방지 (system-reminder 테스트) | UX 개선 |
| 8 | 매 메시지 Current time 주입 (로컬 시간) | 시제 정확도 |
| 9 | settings.default.md 중복 제거 | 토큰 절약 |

---

## 11. 구현 로드맵

| Phase | 내용 | 난이도 | 의존성 |
|-------|------|--------|--------|
| **Phase 1** | 즉시 수정 9건 | 낮음 | 없음 |
| **Phase 2** | recall_memory 도구 + cycle1 구현 | 중간 | Phase 1 |
| **Phase 3** | cycle2 교정 모드 전환 + context.md v2 | 중간 | Phase 2 |
| **Phase 4** | cycle3 구현 + 프로필 학습 | 낮음 | Phase 3 |
| **Phase 5** | bot.md 도입 + instructions 재구성 | 낮음 | Phase 3 |
| **Phase 6** | 설정 UI (setup 스킬 memory 섹션) | 낮음 | Phase 4 |

---

## 12. 유지하는 것 (검증 완료)

- 5레이어 전처리 (업계 최고 수준)
- 하이브리드 5종 검색 (Dense+Sparse+Temporal+Seed+Focus)
- Ebbinghaus 망각 곡선 랭킹
- Intent 자동 분류 (벡터 프로토타입, LLM 0회)
- Semantic segment (토픽 분할, 비용 미미)
- upsertFacts CRUD (벡터 유사도 + slot 충돌 + supersede)
- candidateScore 다차원 점수 모델
- daily summary (Recent 섹션 소스)
- context.md (greeting/스케줄/proactive chat에 필수)

---

## 13. 제거 확정

- 번역 (normalizeSleepArtifacts, normalizeJsonPayloadToEnglish, normalizeTextToEnglish)
- rollup 체인 (daily→weekly→monthly→yearly)
- Identity 섹션 + identity.md 파일 생성
- Recent Summaries 섹션
- profile.md / profile.json (학습 대체)

---

## 14. 참고 자료

### 논문
- LightMem (ICLR 2026) — Online/Offline 2-Tier, Atkinson-Shiffrin 기억 모델
- Letta Sleep-time Compute (arXiv 2504.13171) — 유휴 시간 비동기 메모리 갱신
- Graph-Native Cognitive Memory (arXiv 2603.17244) — 실시간 belief + 비동기 교정
- SimpleMem (arXiv 2601.02553) — Online Semantic Synthesis, Intent-Aware Retrieval
- MemGPT (arXiv 2310.08560) — OS 가상 메모리 모방
- Mem0 (arXiv 2504.19413) — Fact CRUD (ADD/UPDATE/DELETE/NOOP)

### 오픈소스 프로젝트
- Mem0 (48K stars) — 가장 실용적, Fact-level CRUD
- Letta/MemGPT (22K stars) — Sleep-time Agent, 에이전트 자율 메모리
- Zep/Graphiti (3K stars) — Temporal Knowledge Graph
- OpenClaw (339K stars) — 12-Layer 메모리, Hebbian decay
- ReMe (AgentScope) — LoCoMo 86.23% 1위, 파일 기반 + pre_reasoning_hook
- LightMem (ICLR 2026) — Online/Offline 2-Tier
- MemoryOS (EMNLP 2025) — Heat 기반 승격
- Cognee (YC) — Knowledge Graph 메모리 엔진

### 벤치마크
- LoCoMo (Stanford) — Long Conversation Memory 평가
- claude2bot 구조는 ReMe(86.23%)와 동등 이상 예상 (검색/전처리 우위)

---

## 15. 추가 설계 (Phase 1 이후 논의)

### MCP 도구 annotations title
- `annotations: { title: '...' }` 로 도구 호출 시 깔끔한 타이틀 표시
- trib-search에서 검증됨 (`Web Search (search)` 등)
- recall_memory: `annotations: { title: 'Memory Recall' }`
- 기존 도구들에도 추가: reply→Discord Reply, fetch_messages→Fetch Messages 등

### recall_memory instructions 가이드
- 사용자에게 알리지 않고 자율적으로 호출
- "검색해볼게요" 안내 없이 조용히 검색 → 결과만 자연스럽게 반영
- query는 핵심 키워드 3~5단어로 짧게
- history/date recall 기본 소스는 message/turn, transcript는 debug/source_type=transcript에서만 노출

### memory-context 터미널 노출 대응
- system-reminder 감싸기 테스트 예정 (코드 반영 완료)
- 안 되면 plain text bullet (태그명 제거)
- output-forwarder에 HIDDEN_TOOLS + 도구 필터링 이미 있음

### trib-search 동기화
- trib-search도 동일한 instructions 재구성 필요
- provider 추상화 공유 가능성 검토
- annotations title 이미 적용됨

---

## 16. Phase 1 구현 완료 (2026-03-30)

### 커밋 이력
1. `5786793` — trib-search 분리 + launcher 정리
2. `b8518f9` — Windows 호환 + 슬래시 커맨드 제거 + ready gate + webhook retry
3. `750468d` — 시스템 태그 보호 + 포워더 바인딩 + 싱글톤
4. `d0c73ca` — Memory v2 Phase 1 (번역/rollup 제거 + 노이즈 정리 + 시간 주입 + instructions 재구성)

### Phase 1 완료 항목
- [x] 번역 제거 (normalizeSleepArtifacts, normalizeJsonPayloadToEnglish, normalizeTextToEnglish)
- [x] rollup 제거 (weekly/monthly/yearly + collectDailiesForWeek + collectFilesForPeriod + getWeekNumber)
- [x] episode 중복 방지 (candidate 생성 시 kind='message' 필터)
- [x] dedup key 개선 (content hash 기반)
- [x] context.md fallback 중복 방지 (kind='message' + DISTINCT)
- [x] recent topics kind 필터
- [x] memory-context system-reminder 감싸기 (테스트 대기)
- [x] 매 메시지 Current time 주입 (로컬 시간)
- [x] settings.default.md 중복 제거 (session-start hook에서 제거)
- [x] MCP instructions Current time 제거

### 미해결 (다음 세션)
- [ ] system-reminder 감싸기 테스트 (세션 재시작 필요)
- [ ] 싱글톤 kill 미동작 디버깅
- [ ] consolidation 최초 실행 (facts/tasks/signals 채우기)
- [ ] 스킬 통합 (install/setup/doctor)
- [ ] 음성 메시지 동작 확인

### Phase 2 구현 대상
- [ ] recall_memory MCP 도구 구현
- [ ] MCP 도구 annotations title 추가
- [ ] cycle1 provider 추상화 + ollama 연동
- [ ] cycle1 interval 스케줄러
- [ ] bot.md 도입

### Phase 3 이후
- [ ] cycle2 교정 모드 전환
- [ ] cycle3 주간 장기 정리
- [ ] 프로필 학습 (profile.json 제거)
- [ ] trib-search 동기화

---

## 17. LLM CRUD를 채택하지 않는 이유

### Mem0 프로덕션 결과 (GitHub #4573, 2026-03-27)
- 32일 운영, 10,134개 메모리 전수 감사
- **97.8%가 junk** — 원본 사용 가능한 건 38개뿐
- 52.7%: 시스템 프롬프트 반복 추출
- 5.2%: **환각 유저 프로필** (존재하지 않는 사람 날조)
- 2.1%: **보안 유출** (IP, 파일 경로)
- DELETE 시 새 fact ADD 안 해서 **정보 블랙홀** (#4536)
- "더 좋은 모델 = 더 무차별 추출" (Sonnet도 동일)

### claude2bot 접근 — 코드 기반 CRUD
- 벡터 유사도 0.85 → 시맨틱 중복 감지 (코드, 결정적)
- slot 충돌 → 같은 카테고리 값 교체 (코드, 결정적)
- superseded → 벡터 0.75+ 텍스트 다름 (코드, 결정적)
- stale → 시간 기반 decay (코드, 결정적)
- **DELETE 없음** — soft delete만 (stale/superseded)
- **LLM은 extraction만** — CRUD 판단은 코드에 위임

### 5레이어 전처리가 Mem0 junk를 방지하는 방법
1. cleanMemoryText → 시스템 태그/코드블록 제거 (Mem0의 52.7% 문제 해결)
2. looksLowSignal → 20+패턴으로 노이즈 차단 (heartbeat, cron, 시스템 이벤트)
3. candidateScore → 다차원 점수 (과장/artifact 감점)
4. kind='message' 필터 → transcript/turn 제외 (시스템 프롬프트 재추출 방지)
5. shouldKeepFact → confidence/단어수/글자수 게이트 (환각/임시 항목 차단)

### 참고
- https://github.com/mem0ai/mem0/issues/4573
- https://github.com/mem0ai/mem0/issues/4536
- https://arxiv.org/html/2603.19595v1 (All-Mem: 비파괴적 편집 대안)

### recall_memory 최종 파라미터

```json
{
  "name": "recall_memory",
  "annotations": { "title": "Memory Recall" },
  "inputSchema": {
    "properties": {
      "query": { "type": "string", "description": "Search keywords (3-5 words)" },
      "type": { "enum": ["all", "facts", "tasks", "signals", "episodes"], "default": "all" },
      "timerange": { "type": "string", "description": "today, this-week, 2026-03" },
      "limit": { "type": "number", "default": 5 },
      "source": { "type": "boolean", "default": false, "description": "Include source episode + line" },
      "context": { "description": "Number of surrounding episodes OR 'semantic' for topic-based chunking" },
      "compact": { "type": "boolean", "default": true, "description": "Use u/a shorthand for episodes" }
    },
    "required": ["query"]
  }
}
```

### Episode context 모드
- `context: 5` → 전후 5개 episode (기계적, SQL 1회)
- `context: "semantic"` → 같은 토픽 segment만 (buildSemanticDayPlan 재사용)
- `compact: true` → `u:` / `a:` 축약, 초 단위 제거

### 업계 프로덕션 이슈 교훈
- Mem0: 97.8% junk, 환각 프로필, DELETE 정보 손실
- Letta: 극심한 느림, archival memory 실패
- Zep/Graphiti: Event loop 충돌 (치명적), Neo4j 의존
- OpenClaw: 세션 상태 손상, 메모리 리콜 신뢰 불가
- 공통: 모든 프로젝트에서 사용자가 자체 메모리 시스템 구축

### claude2bot이 회피하는 패턴
- LLM CRUD → 코드 기반 (결정적)
- junk 추출 → 5레이어 전처리
- 셀프호스팅 복잡도 → SQLite + 로컬 embedding
- 세션 상태 손상 → episodes DB + source FK
- event loop 충돌 → 단순 아키텍처

### ReMe 심층 비교 (2026-03-30)
- LoCoMo 86.23% (벤치 1위였으나 CORE memory 88.24%에 추월됨)
- 벤치마크 재현 불가 이슈 (GitHub #123)
- ES 메모리 중복 버그 (GitHub #183, 2026-03-30)
- LLM 과의존: 매 턴 ReActAgent 2회 호출 (compactor + summarizer)
- 전처리 없음: 원본 텍스트 그대로 저장/검색

### claude2bot vs ReMe
- 전처리: 5레이어 (claude2bot) vs 없음 (ReMe)
- LLM 호출: cycle1 주기적 1회 vs 매 턴 2회
- 중복 방지: 코드 기반 dedup vs LLM 판단
- 프로필: profiles+signals 분리+confidence vs 뭉뚱그림
- 프로덕션: Discord 봇 실운영 vs 학술 벤치마크만

### CORE memory (88.24%)
- ReMe 86.23%를 추월한 최신 프로젝트 (dev.to 게시글)
- LoCoMo 벤치마크 자체의 방법론 결함 지적 (Reddit r/AIMemory)
- 벤치마크 점수보다 실사용 품질이 중요

### 업계 프로덕션 이슈 종합
| 프로젝트 | 핵심 문제 |
|---------|---------|
| Mem0 | 97.8% junk, 환각 프로필, DELETE 정보 손실 |
| Letta | 극심한 느림, archival memory 실패 |
| Zep/Graphiti | Event loop 충돌 (치명적), Neo4j 의존 |
| ReMe | 벤치마크 재현 불가, LLM 과의존, 전처리 없음 |
| OpenClaw | 세션 상태 손상, 메모리 리콜 신뢰 불가 |
| 공통 | 모든 프로젝트에서 사용자가 자체 메모리 시스템 구축 |

### LoCoMo 벤치마크 상위 기법 참고 (2026-03-30)

| 순위 | 시스템 | 점수 | 핵심 기법 |
|------|--------|------|---------|
| 1 | MemoryLake | 94.03% | 의도 기반 동적 메모리 재구성 |
| 2 | EverMemOS | 92.32% | OpenClaw 기반, BM25+Vector, sqlite-vec |
| 3 | Full-context | 91.21% | 전체 대화 투입 (상한선 참조) |

### 우리가 적용할 수 있는 핵심 기법 (PropMem)
1. **Entity-Filtered Retrieval** — 질문에서 entity 추출 → 해당 entity facts만 검색 (가장 큰 단일 개선)
2. **Atomic Proposition** — 25단어 단위 fact 분리 (이미 유사하게 구현)
3. **절대 날짜 변환** — "어제" → "2026-03-29" (cycle1에서 변환)
4. **지식 업데이트 soft recency** — 구버전 30% 점수 패널티 (삭제 아닌 감점)

### timezone 처리
- profiles DB에 저장하지 않음 — OS에서 `Intl.DateTimeFormat().resolvedOptions().timeZone` 자동 감지
- 출장/이주 시 자동 반영

### 프로필 점진적 갱신 규칙
- profiles를 1회 발화로 즉시 덮어쓰지 않음
- mention_count 기반 점진적 전환:
  - 기존 confidence > 0.7 + mention 3회 이상 → 1회 발화로 안 바뀜
  - 새 값이 3~5회 반복되면 점진적 전환
  - cycle2 교정에서 "1회 발화 프로필 변경 → DROP" 규칙
- profiles 테이블에 mention_count 컬럼 추가 필요
- facts의 mention_count 패턴 재사용
