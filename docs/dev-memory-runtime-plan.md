# claude2bot 메모리 런타임 최종 정리안

> 2026-03-31 | 현재 구조 기준 최종 운영 원칙

---

## 1. 결론

claude2bot 메모리는 다음 4층으로 나눈다.

1. Raw
2. Memory Update Worker
3. Long-term Identity Context
4. Recall / Verification

핵심 원칙은 다음과 같다.

- `context.md`는 장기 아이덴티티 파일로 유지한다.
- 세션 시작에는 작은 identity core만 주입한다.
- 최신성은 현재 세션과 작은 hint가 담당한다.
- 정확한 사실 확인은 `recall_memory`로 처리한다.

### Context 관리 규칙

- `context.md`는 raw dump가 아니라 compiled identity view다.
- `context.md`에는 장기적으로 유지될 bot/profile/policy/decision만 올린다.
- 최근 작업 상태, next_step, raw worklog는 `context.md`에 직접 올리지 않는다.
- user-authored source (`bot.md` 등)가 learned memory보다 우선한다.
- context 갱신은 매턴 실시간이 아니라 batch 갱신을 기본으로 한다.
- 같은 의미의 항목은 병합하고, 충돌 시 최신/명시/강한 증거를 우선한다.
- stale 항목은 hard delete보다 하향 / supersede / deprecated 처리한다.
- `recall_memory`는 context를 채우는 수단이 아니라 사실 확인 수단이다.

---

## 2. 단계 정의

### Step 1. Raw

역할:
- episode/message/turn 원본 저장
- 최신성 확보
- 검증 근거 보존

특징:
- LLM 없이도 가능
- 즉시 저장
- 노이즈가 있어도 그대로 유지

이 단계의 목적은 "지금 막 일어난 것"을 잃지 않는 것이다.

### Step 2. Memory Update Worker

역할:
- 최근 raw를 배치로 분류
- profile / rule / active task / current_state / next_step 반영
- 필요 시 장기 아이덴티티 후보를 승격

특징:
- 기본 주기 5분
- pending backlog 임계치 초과 시 즉시 실행
- `context.md` 직접 실시간 수정은 하지 않음

### Step 3. Long-term Identity Context

역할:
- 장기 아이덴티티 재컴파일
- 우선순위 재정렬
- stale 감쇠 / supersede / dedupe
- 압축

주의:
- 이 단계는 현재 상태 복구용이 아니다.
- 이 단계는 장기 품질과 안정성을 담당한다.

---

## 3. 주입 구조

### 3.1 세션 시작 주입

세션 시작에는 작은 Core Context만 넣는다.

포함:
- 봇 역할
- 유저 언어 / 호칭 / 말투
- 핵심 규칙 / policy
- 아주 중요한 장기 decision

제외:
- 최근 작업 상태 상세
- 최근 사건 상세
- 오래된 작업 이력 나열
- raw worklog

### 3.2 매턴 보강

매턴에는 작은 hint overlay만 넣는다.

slot 예시:
- relevant rule/profile 0~1개
- major decision/current 0~1개

원칙:
- retrieval top-k 중 작은 subset만 사용
- raw 최근 대화를 그대로 worklog처럼 넣지 않음
- 없으면 안 넣음
- 노이즈가 의심되면 생략

### 3.3 검색

다음은 검색으로 처리한다.

- 오래된 작업
- 예전 설계 결정
- 과거 사건
- 파일/버그/엔티티 이력
- 정확한 사실 확인

즉:
- 세션 전 = small identity core
- 매턴 = small hint subset
- 나머지 = `recall_memory`

---

## 4. recent 와 relevant

둘은 구분한다.

### recent

- 시간 기준
- 최근 1일 / 2일 / N턴

### relevant

- 질의 기준
- embedding / lexical / entity match

현재 시스템은 둘을 함께 쓰고 있지만, 최종 조립에서는 slot을 분리하는 것이 좋다.

- recent slot
- relevant slot
- current task slot

---

## 5. Dev 메모리

### 5.1 축 정의

- `workstream`: 범용 축
- `scope`: work / personal
- `activity`: coding / research / planning / communication / ops

즉 dev 여부를 workstream 하나에 몰지 않는다.

### 5.2 Dev Worklog

Dev Worklog는 context의 main source of truth가 아니다.

정의:
- 최근 1~2일
- structured dev task만
- current_state / next_step 있는 것만
- 없으면 섹션 자체를 비움

즉:
- fallback으로 과거 task를 억지로 끌어오지 않는다
- 오래된 dev 작업은 `recall_memory`로 찾는다

---

## 6. LLM 역할

### 코드가 담당

- DB 조회
- 랭킹
- 필터링
- slot 제한
- 어떤 메모리를 줄지 결정

### 중간 LLM이 담당

- 구조화
- 교정
- current_state / next_step / scope / activity 추출

### 최종 에이전트가 담당

- 답변
- 필요 시 recall 호출

즉:
- 코드는 찾고
- 중간 LLM은 정리하고
- 에이전트는 답한다

---

## 7. 운영 원칙

1. `context.md`에 모든 것을 넣지 않는다.
2. Core는 작게 유지한다.
3. 최신/current는 매턴 overlay로 처리한다.
4. 오래된 것은 검색으로 보낸다.
5. ambiguous raw는 current memory로 바로 승격하지 않는다.
6. 애매하면 비워두는 편이 잘못된 힌트를 주는 것보다 낫다.

---

## 8. 최종 한 줄

작은 Core는 세션 시작에 주입하고, 최신 상태는 매턴 작은 overlay로 보강하며, 오래된 기억은 검색으로 처리한다. Step 1은 raw, Step 2는 current 구조화, Step 3은 장기 정리다.
