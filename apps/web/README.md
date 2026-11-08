로드맵 위치: 본선 / 이전 콘솔 웹 화면(apps/web) / 본선 연결점: 완성도·데모

# web: 이전 콘솔

상태: AI 초안 (로컬의 실제 API·워커·DB로 처음부터 끝까지 확인함. 배포된 플랫폼에서는 아직)

## 구조

- `src/`: 새 콘솔. `npm run dev`, 포트 5173
- `legacy/`: 이전 콘솔. `npm run dev:legacy`, 포트 5174. e2e는 아직 이쪽을 본다
- `src/design`, `src/components`: 토큰과 컴포넌트. 디자인의 원본은 이 두 폴더다
- `src/features/<화면>`: 화면과 순수 판단(`model.ts`). 판단은 `test/`에서 시험한다
- `src/lib`: API 클라이언트, 인증, 폴링, 화면 신호, 상태 이름표

## 화면 신호 (SSE)

서버 `GET /api/v1/events`가 로그인한 회사의 신호를 계속 보낸다. 신호는 "다시 읽어"라는 뜻이다(contracts `SseEvent`).

- 연결: `lib/events.ts`. 브라우저 `EventSource`는 Authorization 머리말을 못 붙여서 `fetch`로 스트림을 읽는다. 401이면 토큰을 갱신해 다시 붙고, 끊기면 서버가 보낸 `retry`만큼 쉬고 다시 붙는다. 붙지 못하면 대기를 늘려 30초에서 멈춘다
- 탭 하나에 연결 하나: `lib/live.ts`. 콘솔에 들어오면 붙이고 로그인 화면으로 나가면 끊는다. 다시 붙으면 끊긴 사이를 메우려고 한 번 전부 다시 읽는다
- 화면: `usePoll(fn, ms, deps, { signal, liveFloor })`. 맞는 신호가 오면 간격을 기다리지 않고 다시 읽는다. 연결이 살아 있는 동안 간격은 10초 이상으로 늘고, 연결이 없으면 원래 간격으로 돌아간다. 지금은 이전 한 건(`aboutMigration`)과 이전 목록(`anyMigration`)이 듣는다
- 워커 단계는 늘리지 않는다: 신호는 상태가 바뀔 때만 오고, 워커 단계는 상태가 그대로인 채 값이 바뀐다. 이전 한 건은 `signalCovers(status)`가 거짓인 동안(`liveFloor: false`) 0.7초 간격을 그대로 쓰고, 사람 차례·멈춘 상태만 10초로 늘린다 (`lib/events.ts` `pollInterval`)

화면을 옮기는 원칙: 기능 명세를 표로 옮기지 않는다. 화면 흐름을 따라가면 명세가 충족되게 만든다.
서버에 없는 값은 지어내지 않고, 없는 기능의 버튼은 두지 않는다.

## 실제 서버로 돌리기

화면에는 목업이 없다. 로컬에서도 실제 API·워커·DB 로 돌리고, 클라우드 쪽(Terraform, Argo CD, 사전 점검, LLM)만 서버의 시험 스위치로 흉내 낸다. 레포 맨 위에서:

```bash
cp .env.example .env && npm ci
npm run db:up                    # Postgres + 마이그레이션
npm run auth:seed                # 데모 계정(demo@dev-company.test) 비밀번호를 만들어 .secrets/demo-login.txt 에 쓴다
MOCK_SEED=1 MOCK_IAC=1 MOCK_ARGO=1 MOCK_PRECHECK=1 FAKE_LLM=1 npm run dev:api
MOCK_SEED=1 MOCK_IAC=1 MOCK_ARGO=1 MOCK_PRECHECK=1 FAKE_LLM=1 ROLLBACK_WINDOW_SEC=20 npm run dev:worker
npm run dev:web                  # http://localhost:5173
```

- 끝까지 한 번: `E2E_LOGIN_PASSWORD=... npm run e2e:real` 이 로그인부터 이전 완료까지, 그리고 실행 뒤 롤백까지 화면을 눌러 진행한다 (`e2e-real/console-flow.real.ts`). 서버·화면은 먼저 떠 있어야 한다. 배포된 플랫폼은 `E2E_BASE_URL` 만 바꿔 같은 시험을 돌린다
- 화면 점검: 개발 서버에서만 브라우저 콘솔의 `__layoutCheck()` 가 지금 화면의 카드·버튼 겹침, 가로 넘침, 화면 밖 행동 버튼, 좁은 화면의 쌓는 순서, 글자 대비(4.5:1)를 잰다. 창을 1024×768, 1280×720, 1440×900, 1920×1080 으로 바꿔 가며 돌린다 (`src/dev-layout-check.ts`, 운영 빌드에는 안 들어감)
- 멈춤·실패 화면: 예전 목업의 "상황 만들기"는 목업과 함께 없어졌다. 서버에서 이전을 실패로 닫는 길은 `npm run ops:force-fail -- <이전 id> --reason "<왜>" --yes`

## 언어와 테마

- 언어: 화면 글자는 모두 `t('한국어 원문')` 으로 쓴다 (`lib/i18n.ts`). 영어·일본어 표는 `src/i18n/en.ts`·`ja.ts`, 열쇠는 한국어 원문이다. 값이 들어가는 문장은 자리 `{0}` 을 쓰고, 같은 원문이 자리마다 다른 말이면 `tc('맥락', '원문')` (상태 이름, 보안 판정). 시험 `test/i18n.test.ts` 가 화면 문장마다 두 표에 번역이 있고 자리·줄 수가 같은지 본다. 새 글자를 넣으면 두 표에도 넣는다
- 서버가 만든 글자(사전 점검 문장, 인벤토리 이유, 증적 리포트, AI 수정안 등)는 번역하지 않는다
- 테마: `tokens.css` 의 `[data-theme='dark']` 가 같은 토큰을 어두운 값으로 바꾼다. 컴포넌트에 색을 직접 쓰지 않는다
- 저장: 서버에 사용자 설정 API 가 없어 이 브라우저에 사람마다 둔다 (`lib/prefs.ts`). 로그인하면 그 사람 설정을 가져오고, 언어가 다르면 화면을 다시 읽는다

## 화면과 기능 명세

| 주소 | 화면 | 이 화면이 맡는 기능 (기능 명세 번호) |
|---|---|---|
| `#/` | 대시보드 | 환경 목록·상태 67·68, 이전 목록 72, 이전 시작 69 |
| `#/environments/:id` | 환경 | 환경 상태 67·68, 환경 쪽 이전과 끝난 이전이 남긴 자원 수, Agent 보고 99 (보안 보고는 위반·위협을 나눠 셈), 연결이 끝나지 않은 환경은 "연결 이어 하기" |
| `#/environments/connect`, `#/environments/connect/:id` | 환경 등록 | 환경 연결 링크 113, Agent 등록 114. 어디를 연결할지 → 이름(AWS 는 리전·EKS 클러스터) → 고객 쪽 역할·Agent → 연결 확인. 이미 만든 환경은 연결 상태로 단계를 고른다 (`features/environments/connect.ts`) |
| `#/migrations` | 이전 목록 | 이전 목록 72 |
| `#/migrations/new` | 새 이전 | 이전 만들기 69. 세 질문: 출발 환경(연결된 환경만, 줄 제목은 그 환경에서 서비스 중인 소프트웨어) → 옮길 서비스(출발 범위 `sourceScope`) → 도착 환경(실행 역할을 빌릴 수 있는지). 출발·도착 목록 끝에 환경 등록하기 (`features/migration/source.ts`) |
| `#/migrations/:id` | 이전 한 건 | 상태 73, 가져오기 70, AI 초안 71, 명세 확정 74, 점검 75, 계획 76, 승인 77, 실행 78, 진행 79~82 (트래픽 목표·실측), 앱 숫자 83 (컷오버 때 붙잡은 요청), 컷오버 84, 롤백 창 85, 롤백 86, 취소 87, 재개 88, 멈춘 이유 (실패 코드 → 사람 말, 트래픽 판정·규칙 번호, AI 실패 분석), 실패·롤백·취소 뒤 도착에 남은 자원, 전환 판정 요약, 계획 다시 만들기·명세부터 고치기, 재시도 비용 동의, 보안(계획 승인부터 근거 칸의 "보안" 카드: 보안 표 91, 전후 비교 92, 가드레일 상태 108, 위협 106, 임시 권한 장부, 실제 점검, 항목별 근거) |
| `#/migrations/:id/cost` | 비용 | 추정 95, 비교 96, 성장 122, 보안 프로필 123, 가격 근거 (출처·기준일·오래됨, 예시 앱 기준 표시) |
| `#/security/:id` | (없앰) | 예전 보안 탭 주소. 그 이전 화면으로 간다. 보안은 탭에서 이전을 고르지 않고, 이전 흐름 안에서 데이터가 생기는 때(계획 승인부터 끝까지) "보안" 카드로 본다. 접힌 머리줄에 요약(위반·약점, 가드레일 멈춤·위협·만료된 권한이면 스스로 펼침), 펼치면 예전 탭의 내용을 묶음마다 (`features/migration/SecurityCard.tsx`) |
| `#/audit/:id` | 감사 | 타임라인 93, 증적 리포트 94, 사슬 재검증 |
| `#/agent/:id` | 에이전트 | 결과 97, 실행 98, 명세 초안 71, AI 지출과 상한 |
| `#/settings` | 계정 | 큰 카드 안 벤더 카드(AWS·GCP·Azure·온프레)와 환경 등록하기, 환경마다 연결 확인 시각·지금 빌린 권한(진행 중 마이그레이션의 임시 권한 장부에서 벤더로 가림)·갱신(서버 API 없어 꺼 둠). 화면 설정(테마 라이트·다크, 언어 한국어·English·日本語), GitHub 로그인(서버가 켰는지), 로그아웃, 서비스 상태 103, API 문서 104 |
| `#/design-system` | 디자인 시스템 | 메뉴에는 없는 개발용 화면. 토큰과 컴포넌트를 실제 코드로 보여 준다 |

이전 한 건은 주소가 하나이고, 서버 상태가 바뀌면 화면이 바뀐다 (`features/migration/model.ts`의 `screenOf`). 진행 단계 카드는 모든 상태에서 큰 카드 바로 옆에 있다. 카드는 실행 전(구성 읽기~계획 승인)과 실행(자원 생성~정리) 중 지금 묶음 하나만 보인다. 계획 승인 버튼 한 번이 승인과 실행 시작을 함께 보내고, 시작이 막히면(동시 진행 상한·환경 사용 중) 승인 상태에서 이유와 "다시 시작"을 보인다. 근거 칸에 놓을 것이 없는 단계(구성 읽기·사전 점검·계획 만들기)는 빈 칸을 두지 않고 큰 카드가 그 너비를 채운다. 근거 칸이 생기는 단계로 넘어가면 큰 카드가 줄고 근거 칸이 오른쪽에서 들어온다 (`features/migration/shared.tsx` `Frame`, `design/base.css`).

벤토는 큰 카드만 늘고 줄며, 나머지 칸은 `src/design/tokens.css`의 `--col-*` 너비로 고정한다. 한 화면 안에서는 상태가 바뀌어도 칸 구성이 같고, 빈 칸은 비워 둔다(이전 한 건 화면의 근거 칸만 위 문단처럼 단계에 따라 열고 닫는다). 행동 버튼 줄은 근거 카드 아래 자기 줄을 차지한다. 1200px보다 좁으면 큰 카드, 진행 단계, 근거 순서로 한 줄로 쌓고 행동 버튼 줄은 화면 아래에 붙는다.

## 서버 새 칸이 들어간 자리 (화면 흐름 안)

기능마다 표나 화면을 새로 만들지 않고, 지금 있는 화면의 상태와 칸에 넣었다.

| 서버 | 화면 · 칸 | 어떻게 |
|---|---|---|
| `GET /migrations/:id/spec` 의 `specV2`·`needsReviewV2`·`fieldMetaV2` | 명세 확정 · 큰 카드 + "읽은 값" | v2 판이면 검토 줄을 `needsReviewV2`로 만든다. 큰 카드는 칸을 요소(구성요소·진입·연결·명세 점검)마다 카드로 묶고(카드마다 5칸, 나머지는 "외 N칸", 확인할 칸이 먼저), 확정을 누르면 카드가 차례로 파랗게 차며 그 카드로 스크롤한 뒤 다음 단계로 간다 (`features/migration/visuals.ts` `specCardsV2`, `HeroVisuals.tsx` `SpecCards`). 칸마다 출처·신뢰도·이유는 근거 카드의 그 줄 아래에만 (검토 칸이거나 신뢰도 1 미만일 때). `null` 은 비워 두고 검토 표시만, 환경변수 값은 보이지 않는다 (`features/migration/specV2.ts`) |
| `PATCH /migrations/:id/spec` (`confirm`·`include`) | 명세 확정 · 주 행동 | "N칸 확인하고 명세 확정"이 검토 키를 20개씩 그대로 confirm 한 뒤, 남은 칸이 없을 때만 `POST /plan`. 409 `SPEC_VERSION_CONFLICT`면 새 판을 다시 읽는다. v1 판은 지금처럼 `POST /plan` 만 |
| `outOfBoundary` | 명세 확정 · "이 앱 밖 자원" 접는 카드 | 칸이 있을 때만 (없으면 "없음"이 아니라 그리지 않음). DB·캐시·저장소·큐만 "이 앱으로 가져오기"(`include: [resource]`), 서비스·잡은 버튼 없음 |
| `accuracy` | 명세 확정 · "가져오기 정확도" 접는 카드 | 비율·비교 기준·비교한 칸 수, 불일치 칸만 줄로. 가져올 때 잰 값이라고 적는다 |
| 계획서 `steps`·`rollbackCriteria`, `GET /plan/resources`, `GET /security` | 계획 승인 · 큰 카드의 넘기는 판 | 탭·←→·옆으로 밀기로 넘긴다: 계획(실행 순서 상자 → 상자, 비율 단계 막대, 되돌리는 조건 둘 → 출발로 되돌림) · 자원 대응(출발 상자 ─옮기는 법→ 도착 상자) · 상품 대체(있을 때, 확인하는 자리) · 보안(네 칸 숫자·비율 막대·통제마다 출발 → 도착, 나빠지면 빨간 선). 상품 대체 확인이 남았으면 그 판에서 시작한다. 지난 단계로 볼 때도 같다 (`features/migration/HeroPager.tsx`, `HeroVisuals.tsx`) |
| 타임라인의 `rolling_back` 전이(`lastJudgement`·actor)와 계획서 되돌림 기준 | 롤백 중·롤백 완료 · 큰 카드 | 어디서(그때 상태·도착 비율) → 원인(사유·넘은 지표) → 한 일(자동 롤백·사람 롤백) → 지금, 판정이 있으면 지표마다 출발·도착 막대와 기준 세로선. 판정이 없으면 서버가 남긴 이유 (`visuals.ts` `rollbackCause`) |
| 계획서 `acknowledgements` | 계획 승인 · "승인 전에 확인" 접는 카드 | 체크 목록 하나. 따로 단계를 두지 않고 승인 버튼이 남은 수를 말한다("확인 2개 남음"). 승인 때 `acks`를 늘 보낸다 (서버는 `PLAN_ACKS=1`일 때만 강제). 체크는 계획 지문에 묶여 계획서가 바뀌면 처음부터 |
| 계획서 `costSummary` | 계획 승인 · "월 비용" | 계획서에 있으면 미리보기(`GET /cost`) 대신 이 값. 계산 못 한 칸·고정값은 단서로, 가격 기준일은 안내 줄에 |
| `POST /migrations/:id/start {planHash}` | 실행 시작 | 승인한 계획 지문을 싣는다. 409 `TENANT_BUSY`면 승인 상태 그대로 "다시 시작"(계획이 유효한 동안만) |
| `POST /migrations/:id/replan`, `POST /spec/reopen` | 실패·낡은 계획·거절 화면 · 주 행동 | "계획 다시 만들기"는 failed(planning·provisioning)·stale·rejected 에서만 (`canReplan`). 거절은 "명세부터 고치기" 보조 버튼도. 다시 계획할 수 없는 실패는 지금처럼 정리 확인 뒤 끝내기 |
| 409 `RETRY_BUDGET_EXHAUSTED` | 실패 화면(다시 계획)·멈춤 화면(재개) · 버튼 줄 | 동의 체크 한 줄을 보이고, 체크하면 `acceptCustomerCost: true`로 다시 보낸다 |
| `GET /agent-review` 의 `failureAnalysis` | 멈춘 이유 접는 카드 | 끝난 분석만 원인·고칠 것·근거로. 칸이 없거나 진행 중이면 아무것도 그리지 않는다 |
| `GET /plan/resources` v2 (`irVersion`, `cache`·`queue`·`boundary`, `runtimeChange`) | 계획 승인 · "자원 대응" | 같은 칸 여러 줄(앱마다)도 그린다. "실행 방식 바뀜"은 그 줄 아래. 경계 밖은 옮기는 자원이 아니라 표 밖 한 줄. 머리줄 건수는 그린 줄 수 (`lib/resourceMap.ts`) |
| `GET /migrations/:id/rehearsal` (`RehearsalView`) | 이전 화면 · 진행 단계 "앱 배포" 칸, 배포 중 큰 카드 한 줄, "리허설"·"충실도" 접는 카드, 멈춤 화면 | 앱 배포 칸 오른쪽에 리허설 중·통과·재사용·건너뜀·멈춤. 리허설 카드에 샌드박스 이름·단계·걸린 시간·남은 기한·격리(커널·파드 보안)·검사(실패 먼저)·사람이 승인한 격리 문구. 충실도 표는 같게·바꿔서·못 본 것 세 묶음으로 줄마다 실제·리허설·이유 그대로. 서버 `run.stale` 이 참이면 지난 배포 시도의 기록으로 보이고(그때 결과와 판정을 가른 실패만), 지금 판정으로 말하지 않는다. 완료 화면에는 두 카드를 접어 둔다(`features/migration/rehearsal.ts`) |
| 실패 코드 `REHEARSAL_*` 14개 | 멈춘 이유 문장 | 실제도 실패·샌드박스가 보증 못 함·플랫폼 문제(contracts `REHEARSAL_FAILURE_CLASS`)로 문장이 갈린다. 보증 못 함은 "앱이 고장 났다는 뜻은 아닙니다" |
| 실패 코드 `UNSUPPORTED_V2`·`NEEDS_HUMAN`·`RUNTIME_*`·`TF_PLAN_DRIFT`·`GITOPS_VALUES_DRIFT` | 멈춘 이유 문장 | `lib/failure.ts`. 승인 뒤 바뀜 두 줄은 "일부만 생겼을 수 있음"으로 떨어지지 않는다 |
| 환경 `failureReason` 코드 | 대시보드 환경 줄·환경 화면 큰 카드·환경 등록 실패 | 코드를 사람 말로 (`connectionReasonText`). 권한 이름은 문장에 넣고, 모르는 코드는 코드 그대로. 플랫폼 쪽 실패(`PLATFORM_*`)는 고객이 고칠 것이 없다고 쓴다 |
| `POST /migrations` 의 `sourceScope`, `MigrationView.sourceScope` | 새 이전 · "무엇을 옮길까요?", 이전 화면 상단 알약 | 온프레는 네임스페이스(그 안 DB 가 하나면 함께), 클라우드는 클러스터를 인벤토리에서 고른다. 못 읽으면 자동 또는 직접 적기(서버 정규식을 화면에서 먼저 봄). 비면 본문에 칸을 싣지 않는다 |
| `EnvironmentView` 의 `targetProjectId`·`missingPermissions`·`needsHuman`·`mock` | 새 이전 도착 줄, 환경 등록 결과 | GCP 전용 프로젝트가 없거나 권한이 빠지면 도착 줄에 경고 한 줄. 흉내 자격 확인은 그렇다고 쓴다 |

## 서버에 없어서 화면이 일부만 맡는 기능

| 번호 | 기능 | 지금 화면 |
|---|---|---|
| 106 | 위협 패널 확인 처리 | Agent 보안 보고 중 위협(kind threat)의 실패 항목만 읽기로 보여 줌. 설정 위반(posture)은 위협에서 뺌. 확인 처리 버튼 없음 |
| 107 | 사람 직접 확인 | 통제 표에 표시만 함. 입력 없음 |
| 108 | 가드레일 엔진 | 멈춘 상태, 되돌리기 기준, 거부 기록, 멈춘 이유(실패 코드), 마지막 트래픽 판정을 보여 줌. 규칙 번호는 워커가 전이 근거(evidence.guardrailRule)에 남길 때만 보임 |
| 109·110·111 | 샌드박스, 수정안 PR, 주입 차단 시연 | 배포 전 vCluster 리허설은 이전 화면에서 보임(아래 표). 에이전트 점검은 결과까지만, 적용은 사람이 함 |
| 112 | GitHub 로그인, 멤버 초대 | 서버가 켜 두면(`/auth/config` 의 `github.enabled`) 로그인 화면에 "GitHub로 로그인"이 생기고, 실패해 돌아오면(`?github_error=`) 사람 말로 보인 뒤 주소에서 지운다. 쓰던 중 계정이 꺼지면(401 `USER_DISABLED`) 그 이유를 로그인 화면에 쓴다. 멤버 화면 없음  계정 화면은 서버가 켰는지만 보인다(계정 연동 여부는 서버가 주지 않음) |
| - | 환경 권한 갱신, 사용자 설정 저장 | 계정 화면의 갱신 버튼은 서버 API 가 없어 꺼 둔다. 테마·언어는 서버가 아니라 브라우저에 사람마다 저장한다 |
| 121 | 플랫폼 상태 | API·DB 응답만. 워커·큐 숫자 API 없음 |
| 130 | 온프레 동등 기능 표 | 통제 표에서 온프레 칸으로만 보임 |
| 131 | 부하 기반 사이징 | 없음. 비용 화면의 피크 요청 입력으로 대신함 |

새 화면 없이 서버·운영 쪽에서 끝나는 기능(65·66·89·90·100~102·115~120·124~128·132)은 화면이 맡지 않는다.

## 화면이 아직 쓰지 않는 서버 칸

서버 경로 39개(`docs/openapi.yaml`) 중 화면이 부르지 않거나 일부 칸만 쓰는 것. 이유가 있어 남겨 둔 것이다.

| 서버 | 화면이 안 쓰는 이유 |
|---|---|
| `GET /auth/me`, `GET /auth/config` 의 `devAuth`·`loginRequired` | 로그인 응답에 사용자가 이미 있다. 로그인 화면은 `github.enabled`만 본다. 시험용 헤더 인증일 때 로그인을 건너뛸지는 사람이 정한다 (`lib/auth.ts` TODO(human): 화면은 `x-dev-tenant`를 보내지 않고 devAuth 서버에서도 Bearer 로그인이 되므로 로그인 화면을 두는 쪽이 단순하다) |
| `GET /plans/:id` | 화면은 `GET /migrations/:id/plan`으로 최신 계획만 본다 |
| `POST /agent/reports` | 온프레 Agent가 서명해서 보내는 경로라 사람 화면과 상관없다 |
| 승인·거절·롤백·취소·재개 본문의 `reason` | 이유 입력을 둘지 사람이 정한다 (`features/migration/shared.tsx` TODO(human)) |
| 계획서 `tfPlanHash`·`helmValuesHash`·`adapterVersion`, 타임라인 `stateDurations`, 리포트 `deploy`·`cost`·`precheck` | 감사·증적 리포트 쪽 원자료라 기본 화면에 두지 않는다. 증적 리포트(HTML)에서 본다 |
| 비용 `recommendations`, `load` | 비용 화면은 출발·도착 비교와 조건 바꿔 보기만 맡는다 |
| 보안 `tempRoleAudit`, 실점검 `durationMs` | 장부와 항목별 근거 카드가 같은 사실을 사람 말로 보여 준다 |
| 화면 신호 `weight_changed`·`rollback_*`·`matrix_changed`·`agent.step` | 서버가 아직 내지 않는다. 지금 오는 신호는 `migration.status_changed`와 `reload_all` 뿐이다 |
| 환경 해제 `DELETE /environments/:id`, 연결 링크 `boundaryPolicyExists` | 해제는 되돌릴 수 없어(다시 연결 불가) 버튼을 두지 않았다. 경계 정책이 이미 있는 계정은 아직 화면에서 묻지 않는다 |
| `POST/GET/DELETE /tokens` (CLI 토큰) | 사람 화면이 아니라 CLI 용이다. 토큰 목록·발급 화면은 아직 없다 |
| 다시 가져오기 | 서버에 경로가 없다. 명세 화면에 버튼을 두지 않는다 |
| 출발 범위 `partOf`·`ecsCluster` | 지금 지원 범위가 k8s 라 클러스터·네임스페이스·DB·앱 이름만 고르거나 적는다 |
| 계획서 `irVersion`·`specSource`·`instances`·`specVersion` | 감사·증적 쪽 원자료(L3)라 기본 화면에 두지 않는다. 화면은 자원 대응 v2 줄과 확인 항목으로 같은 사실을 사람 말로 보인다 |
| 명세 PATCH `changes`(값 고치기)·`acceptDraft` 단독 | 화면은 아직 값을 고치는 입력이 없다. 검토 칸 확인(`confirm`)과 경계 밖 끌어오기(`include`)만 보낸다. AI 초안 판이면 확인과 함께 `acceptDraft`를 싣는다 |
