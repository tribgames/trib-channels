# claude2bot Agent Guide

Claude Code 세션 내에서 claude2bot 플러그인의 설정과 기능을 다루기 위한 가이드.

---

## 1. 설정 파일

모든 경로는 `$CLAUDE_PLUGIN_DATA` 기준. 실제 경로는 `~/.claude/plugins/data/claude2bot-claude2bot/`.

| 파일 | 역할 | 런타임 반영 |
|------|------|-------------|
| `config.json` | 백엔드, 채널, 스케줄, 음성 설정 | 스케줄: restart 필요. 채널/토큰: 세션 재시작 |
| `access.json` | 접근 권한, 페어링 코드, allowFrom | 즉시 (매 요청마다 읽음) |
| `PROFILE.md` | 유저 프로필 (이름, 역할, 선호) | 즉시 (instructions에 포함) |
| `prompts/*.md` | 스케줄 프롬프트 파일 | 즉시 (실행 시 읽음) |
| `scripts/*.js` | 스케줄 스크립트 | 즉시 (실행 시 읽음) |
| `settings.default.md` | 기본 행동 규칙 (번들) | 세션 시작 시 |
| `settings.local.md` | 유저 커스텀 행동 규칙 | 세션 시작 시 |

### config.json 구조

```jsonc
{
  "backend": "discord",
  "discord": { "token": "..." },
  "channelsConfig": {
    "main": "general",            // 메인 채널 라벨
    "channels": {
      "general": { "id": "12345", "mode": "interactive" },
      "news":    { "id": "67890", "mode": "monitor" }
    }
  },
  "nonInteractive": [ ... ],     // 별도 프로세스 스케줄
  "interactive": [ ... ],        // 세션 주입 스케줄
  "proactive": { ... },          // 자율 대화 설정
  "promptsDir": "prompts",       // 프롬프트 디렉토리
  "contextFiles": ["PROFILE.md"],
  "voice": { "enabled": true, "language": "auto" }
}
```

### 파일 수정 방법

```bash
# config.json 읽기
Read $CLAUDE_PLUGIN_DATA/config.json

# config.json 수정 (JSON이므로 Edit 도구 사용)
Edit $CLAUDE_PLUGIN_DATA/config.json

# 프롬프트 파일 수정
Edit $CLAUDE_PLUGIN_DATA/prompts/mail-briefing.md
```

---

## 2. 스케줄 설정

### 3가지 모드

| 모드 | 배열 키 | 동작 | 세션 필요 |
|------|---------|------|-----------|
| **non-interactive** | `nonInteractive` | `claude -p` 서브프로세스 실행, 결과를 채널에 전송 | 아니오 |
| **interactive** | `interactive` | 현재 세션에 프롬프트 주입 | 예 |
| **proactive** | `proactive` | 랜덤 간격으로 세션에 주입 (idle guard) | 예 |

### 세션 제어 우선순위
- macOS/Linux: `tmux send-keys`
- Windows + WSL: `wsl.exe tmux send-keys`
- Windows Native: PowerShell 창 활성화 + SendKeys (제한적 폴백)

### TimedSchedule 항목 (non-interactive / interactive)

```jsonc
{
  "name": "mail-briefing",       // 고유 이름 (kebab-case)
  "time": "09:30",               // "HH:MM", "hourly", "every5m", "every10m", "every30m"
  "days": "weekday",             // "daily" (기본) | "weekday" (월-금)
  "channel": "general",          // channelsConfig 라벨
  "enabled": true                // false면 비활성화
}
```

프롬프트 파일: `prompts/{name}.md` (또는 `prompt` 필드로 경로 지정).

### Proactive 설정

```jsonc
{
  "proactive": {
    "frequency": 3,              // 1~5 (1=~1회/일, 3=~4회/일, 5=~10회/일)
    "feedback": true,            // proactive-feedback.md 첨부 여부
    "dndStart": "23:00",         // 방해금지 시작
    "dndEnd": "07:00",           // 방해금지 종료
    "items": [
      { "topic": "proactive-chat", "channel": "general" }
    ]
  }
}
```

빈도별 매핑:

| frequency | 일일 횟수 | idle guard |
|-----------|-----------|------------|
| 1 | ~1회 | 8시간 |
| 2 | ~2회 | 4시간 |
| 3 | ~4회 | 2시간 |
| 4 | ~7회 | 1시간 |
| 5 | ~10회 | 30분 |

### 스케줄 추가/편집/삭제

**추가** (config.json에 항목 + 프롬프트 파일):
```bash
# 1. config.json의 interactive 또는 nonInteractive 배열에 항목 추가
# 2. prompts/ 디렉토리에 {name}.md 프롬프트 작성
# 3. /claude2bot schedule 또는 trigger_schedule 도구로 확인
```

**편집**: config.json의 해당 항목 수정 + 프롬프트 파일 수정.

**삭제**: config.json에서 항목 제거. 프롬프트 파일은 남겨도 무방.

**슬래시 진입점**: `/claude2bot schedule`

---

## 3. 접근 권한

### access.json 구조

```jsonc
{
  "allowFrom": ["USER_ID_1", "USER_ID_2"],  // 허용 유저 ID
  "dmPolicy": "paired",                      // "open" | "paired" | "closed"
  "channels": {
    "CHANNEL_ID": {
      "requireMention": false,
      "allowFrom": []                        // 빈 배열 = 전원 허용
    }
  },
  "pairing": {
    "code": "AB12CD",                        // 6자리 페어링 코드
    "expires": "2025-04-01T00:00:00Z"
  }
}
```

### 페어링 플로우

1. 유저가 Discord DM으로 봇에게 메시지 전송
2. `dmPolicy: "paired"` → 페어링 코드 요구
3. 유저가 코드 입력 → `allowFrom`에 유저 ID 추가
4. 이후 DM 가능

### DM 정책

| 정책 | 동작 |
|------|------|
| `open` | 누구나 DM 가능 |
| `paired` | 페어링 코드 인증 후 DM 가능 |
| `closed` | DM 비활성화 |

### 채널 등록

`channelsConfig.channels`에 채널 추가:
- `mode: "interactive"` — 메시지 수신 + 응답
- `mode: "monitor"` — 메시지 수신만 (메인 채널에 보고)

---

## 4. MCP 도구 (8개)

### reply
채널에 메시지 전송. 파일 첨부, 임베드, 컴포넌트(버튼/셀렉트) 지원.
```
chat_id: string (필수)
text: string (필수)
reply_to?: string         — 스레드 대상 메시지 ID
files?: string[]          — 첨부 파일 경로 (최대 10개, 25MB)
embeds?: object[]         — Discord 임베드
components?: object[]     — Discord 컴포넌트 (버튼, 셀렉트 메뉴)
```

### fetch_messages
채널의 최근 메시지 조회. 오래된 순 반환.
```
channel: string (필수)
limit?: number            — 최대 메시지 수 (기본 20, 최대 100)
```

### react
메시지에 이모지 리액션 추가.
```
chat_id: string (필수)
message_id: string (필수)
emoji: string (필수)      — 유니코드 이모지 또는 <:name:id>
```

### edit_message
봇이 보낸 메시지 수정.
```
chat_id: string (필수)
message_id: string (필수)
text: string (필수)
```

### download_attachment
메시지의 첨부파일 다운로드. 로컬 파일 경로 반환.
```
chat_id: string (필수)
message_id: string (필수)
```

### schedule_status
모든 스케줄의 상태 조회 (이름, 시간, 타입, 실행 중 여부, 마지막 실행).
```
(파라미터 없음)
```

### trigger_schedule
스케줄 수동 즉시 실행. 시간/요일 제약 무시.
```
name: string (필수)       — 스케줄 이름 (예: "mail-briefing", "proactive:chat")
```

### schedule_control
스케줄 연기 또는 오늘 건너뛰기.
```
name: string (필수)
action: "defer" | "skip_today" (필수)
minutes?: number          — defer 시 지속시간 (기본 30분)
```

---

## 5. 슬래시 커맨드

### `/claude` 커맨드 (7개)

Discord에서 `/claude <subcommand>` 형태로 사용.

| 커맨드 | 설명 | 주요 파라미터 |
|--------|------|---------------|
| `stop` | 현재 작업 즉시 중단 (SIGINT) | - |
| `status` | 세션 상태 확인 | - |
| `usage` | 세션 사용량 보기 | - |
| `config` | 현재 설정 확인 | - |
| `model` | AI 모델 전환 | `name`: sonnet, opus, haiku / `effort`: low, medium, high, max |
| `compact` | 대화 기록 압축 | - |
| `clear` | 대화 초기화 (세션 유지) | - |
| `new` | 새 세션 시작 | - |

### `/claude2bot` 커맨드 (3개)

Discord에서 `/claude2bot <subcommand>` 형태로 사용.

| 커맨드 | 설명 | 주요 파라미터 |
|--------|------|---------------|
| `setup` | 설정 대시보드 열기 | - |
| `schedule` | 스케줄 관리 열기 | - |
| `doctor` | 시스템 진단 | - |

---

## 6. 훅 흐름

메시지 수신부터 응답 완료까지의 실제 실행 흐름:

```
유저 메시지 수신
  │
  ▼
server.ts / backend.onMessage
  - 채널 owner 확인
  - message_id 중복 차단
  - transcript 경로 갱신
  - 유저 메시지 리액션 추가
  - notifications/claude/channel 전송
  │
  ▼
OutputForwarder
  - transcript watch
  - assistant text / tool log 추출
  - 팀/sidechain/session 필터링
  - Discord 전송
  │
  ▼
Stop (stop.cjs)
  - 리액션 제거
  - turn-end 신호 파일 기록
  - 서버가 미전송 텍스트 최종 전송
  - sessionIdle = true 설정
```

### 패딩 로직
- `sentCount > 0`이면 메시지 앞에 `ㅤ\n` (투명 문자 + 줄바꿈) 추가
- Discord에서 연속 메시지가 붙어보이는 것을 방지

### 청크 분할 (format.cjs)
- 2000자 초과 시 자동 분할
- 코드블록이 잘리면 언어태그 복원 + 닫기/열기 처리
- limit 초과 시 초과분을 다음 청크로 이동

---

## 7. 에러 대처

### 봇 무응답
1. `/claude2bot doctor` — 연결, 설정, 훅 상태 진단
2. `/claude status` — 세션 상태 확인
3. `access.json`의 `allowFrom`에 유저 ID 포함 여부 확인
4. 채널이 `channelsConfig.channels`에 등록되어 있는지 확인

### 스케줄 미실행
1. `schedule_status` 도구로 스케줄 상태 확인
2. config.json에서 `enabled: true` 확인
3. `days` 설정 확인 (weekday면 주말 미실행)
4. 프롬프트 파일 존재 확인: `prompts/{name}.md`
5. 스케줄러 락 충돌: `/tmp/claude2bot-scheduler.lock` 확인
6. `/claude2bot schedule` — 스케줄 상태와 설정 경로 확인

### 음성 인식 실패
1. config.json의 `voice.enabled: true` 확인
2. `ffmpeg`, `whisper-cli` PATH에 있는지 확인
3. 모델 파일 경로 확인 (`voice.model`)

### 권한 버튼 무반응
1. `access.json`의 `allowFrom`에 버튼 클릭 유저 포함 확인
2. 봇 권한: 메시지 수정 권한 필요

---

## 8. 제약사항

### 에이전트가 할 수 없는 것
- 소스 코드 수정 (hooks, server.ts, backends 등)
- Discord 봇 토큰 직접 생성/변경
- 세션 외부에서 interactive 스케줄 실행

### 런타임 즉시 반영
- `access.json` 수정
- 프롬프트 파일 수정
- `PROFILE.md` 수정
- `schedule_control` (defer/skip)

### 재시작 필요
- config.json의 스케줄 추가/삭제 → `/claude2bot schedule`
- config.json의 채널/토큰 변경 → 세션 재시작
- settings.default.md / settings.local.md 변경 → 세션 재시작
- 훅 파일 변경 → 세션 재시작
