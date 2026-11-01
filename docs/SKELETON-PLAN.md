# 스켈레톤 생성 플랜

상태: AI 초안

목표: 아키텍처 9개 영역이 **가짜 구현(STUB)이라도 전부 연결돼서**, 이전 한 건이 `draft`에서 `completed`까지 한 번 도는 것.
그다음 이 코드에서 기능·API 명세를 거꾸로 뽑는다. 완성도보다 폴더·이름·입출력 계약을 고르게 맞추는 게 먼저다.

출발점: 첫 뼈대가 이미 있다(npm workspaces, api·worker·contracts·core·adapters, DB 마이그레이션, smoke). 지금은 `POST /migrations → 워커 import → spec_review`까지 돈다. 이 플랜은 그 뒤를 채운다.

## 시작 전 (처음 한 번)

```bash
cd ~/Softbank_final/Service   # 레포 폴더로 이동
git switch -c feat/skeleton               # 스켈레톤용 새 브랜치를 만들고 거기로 옮김 (main을 건드리지 않게)
node -v                                   # Node.js 버전 확인. v22.x가 나와야 함. 없으면: brew install node@22
docker -v                                 # Docker 확인. 로컬 Postgres를 컨테이너로 띄울 때 씀
cp .env.example .env                      # 환경변수 예시를 실제 파일로 복사 (.env는 커밋 안 됨)
npm install                               # 모든 패키지 의존성 설치
docker compose up -d --wait db            # Postgres를 켜고 준비될 때까지 기다림
npm run typecheck && npm test             # 기대: 타입 오류 0, 테스트 전부 통과
claude                                    # 이 폴더에서 Claude Code 실행
```

- Claude Code를 처음 열면 `.claude/settings.json`에 적힌 플러그인 3개(context7, terraform, postgres-best-practices)를 설치하겠냐고 묻는다. 허용한다.
- 안 물어보면 Claude Code 안에서 직접: `/plugin install context7@claude-plugins-official`, `/plugin marketplace add hashicorp/agent-skills` → `/plugin install terraform@hashicorp`, `/plugin marketplace add supabase/agent-skills` → `/plugin install postgres-best-practices@supabase-agent-skills`.
- `/skills`를 치면 이 레포 스킬 6개(fastify, add-endpoint, add-state-transition, add-adapter, add-db-migration, check-against-design)가 보여야 한다.
- 지금 돌아가는지 확인: 터미널 셋에서 `npm run dev:worker`, `npm run dev:api`, `npm run smoke`. `status=spec_review after N ms`가 나오면 성공.

## 단계별 순서와 프롬프트

각 단계 프롬프트를 Claude Code에 그대로 붙인다. 단계가 끝날 때마다 `npm run typecheck && npm test && npm run smoke`가 통과하면 커밋한다(커밋은 직접).

| 단계 | 만드는 것 | 영역 | 예상 |
|---|---|---|---|
| 1 | 공용 장치: 멱등 키, 상태 조건 함수, 환경 잠금, 화면 신호(SSE) | 2 | 1.5시간 |
| 2 | 남은 경로 전부(STUB) | 1, 2, 4 | 1.5시간 |
| 3 | 남은 큐 작업 전부(STUB) → 한 바퀴 | 2, 3, 4, 5 | 1.5시간 |
| 4 | 보안·에이전트 자리 채우기 | 7, 8 | 1시간 |
| 5 | 인프라·배포 파일 껍데기 | 3, 6, 9 | 40분 |
| 6 | 웹 최소 화면 | 1 | 1시간 |
| 7 | 끝까지 도는지 확인 + 명세 역추출 | 전체 | 1시간 |

### 1. 공용 장치

> CLAUDE.md를 읽고, documents/api-orchestrator-v1.md 4.3(멱등 키), 4.6(화면 신호), 5.2(advance), 6.4(환경 잠금) 기준으로 STUB인 공용 장치를 채워 줘. (1) idempotency_keys 표 + api 플러그인(상태를 바꾸는 POST는 Idempotency-Key 필수, 같은 키 재요청은 저장된 응답), (2) advance.ts의 guardOk 조건(paused 복귀, failed→planning 조건), (3) env_locks 인수·반납 + 워커 heartbeat·reaper(설계 6.4, reaper는 고아 작업을 boss.fail), (4) GET /events SSE(DB NOTIFY → 구독자). DB 바꾸는 건 add-db-migration 스킬, 상태 조건은 add-state-transition 스킬. 각각 테스트.

### 2. 남은 경로

> add-endpoint 스킬로 documents/api-orchestrator-v1.md 4.4절 경로 표 중 아직 없는 것 전부를 만들어 줘(environments, connection-link, verify, specs PATCH(If-Match), plan, plans 조회, approvals(planHash), start, resume, rollback, cancel, force-unlock, audit-events, healthz/readyz). 요청·응답 스키마는 packages/contracts에. 외부 일은 STUB. 경로마다 정상·거부·회사 경계 테스트.

### 3. 남은 큐 작업 → 한 바퀴

> apps/worker에 QUEUES 중 처리기가 없는 작업을 전부 STUB으로 만들어 줘(precheck, plan, apply, deploy, sync, traffic shift, cutover, rollback window, cleanup). 각 작업은 JOB_SCHEMAS로 parse → 잠깐 대기 → 결과 계약(results.ts) 모양의 가짜 결과 저장 → advance()로 다음 상태. plan 작업은 adapters의 toTerraform/toHelmValues를 실제로 불러 PlanDoc을 만든다. tools/smoke.ts를 늘려서 이전 생성 → 계획 → 승인 → 시작 → completed까지 상태를 찍게 해 줘. 사람 손은 승인 한 번만.

### 4. 보안·에이전트

> 영역 7과 8 자리를 채워 줘. 보안: 워커 작업 security-scan(STUB)이 Finding 계약 모양 결과를 내고, 이전 중 가드레일 판정 함수(위험 변경 감지 → 되돌림 요청)를 STUB으로. 에이전트: apps/agent-worker가 agent-run 큐를 받아 가짜 도구 루프를 돌고 AgentFinish를 저장, 사람 승인 전엔 반영 안 함. 계약이 contracts에 없으면 먼저 추가하고 쓰는 쪽을 같이 고쳐.

### 5. 인프라·배포 껍데기

> infra/modules/<aws|gcp|onprem>/app(어댑터 toTerraform vars와 변수 1:1), gitops/(앱 Helm 차트, values는 toHelmValues 출력 모양과 일치), deploy/(우리 api/worker/web 차트) 파일만 만들어 줘. terraform validate, helm lint, helm template까지만. apply·install은 하지 마. add-adapter 스킬의 변수 일치 테스트도 추가.

### 6. 웹

> apps/web(React+Vite, DRAFT(ai))에 화면 셋: 환경 목록·연결, 이전 상세(상태 타임라인, SSE로 갱신), 계획 승인. 요청·응답 타입은 @svc/contracts에서 가져온다. 개발용 인증은 지금 API와 같은 방식.

### 7. 확인 + 명세 역추출

> check-against-design 스킬로 전체를 검토하고 docs/reviews/에 결과를 써 줘. 그다음 명세 역추출: (1) 등록된 경로 전부와 요청·응답 스키마 → docs/contracts/api.md, (2) 큐 이름과 작업 데이터 → docs/contracts/jobs.md, (3) 패키지별 받는 것/넘기는 것 → docs/contracts/modules.md, (4) DRAFT(ai)·STUB·TODO(human) 목록 → docs/contracts/open-items.md. 모두 상태: AI 초안.

## 막히면

- 같은 에러로 두 번 실패하면 멈추고 에러 전문을 보여 달라고 한다. 테스트를 끄고 넘어가지 않는다.
- 범위가 커지면 그 단계는 STUB으로 두고 다음 단계로 간다. "한 바퀴 돈다"가 먼저다.
- 이미 알려진 함정 둘: 인증 플러그인을 `fastify-plugin`으로 안 감싸면 회사 값이 비어 RLS 위반 500이 난다. pg-boss는 `createSchema: false`여야 앱 계정에 DB 생성 권한이 필요 없다.

## 끝났을 때 확인

```bash
npm run typecheck                 # 기대: 에러 0
npm test                          # 기대: 전부 통과
npm run db:reset                  # DB를 처음부터 다시 만들어 마이그레이션이 깨끗이 적용되는지
npm run dev:worker & npm run dev:api &
npm run smoke                     # 기대: draft → … → completed 상태가 순서대로 찍힘
grep -rn "DRAFT(ai)\|STUB:\|TODO(human)" apps packages db | wc -l   # 남은 미정 항목 수
```

## 병렬 진행 규칙 (10/31 밤, 스레드 여러 개)

같은 폴더에 여러 작업이 동시에 쓰므로, 폴더마다 주인을 하나로 정한다. 남의 폴더는 읽기만 한다.

| 작업 | 쓰는 곳 (주인) | 끝 기준 |
|---|---|---|
| B. 큐 처리기 + 승인 경로 | `apps/worker/src/jobs/*`, `apps/worker/src/main.ts`, `apps/api/src/routes/*` (새 파일) | smoke가 draft → completed 한 바퀴 |
| C. 상태 조건·중복 방지·환경 잠금 | `packages/core/src/*`, `apps/api/src/plugins/*`, `apps/worker/src/lease/*`, `db/migrations/0003_*`부터 | guardOk 거부 테스트, 같은 키 두 번 → 같은 응답, 잠금 테스트 |
| D. 보안·에이전트·트래픽 STUB | `packages/security`, `packages/agent`, `packages/traffic` (새 패키지), `apps/agent-worker` | 패키지마다 계약 표 README + 테스트 2개 |
| E. 명세 역추출 | `docs/contracts/*` | api.md, jobs.md, modules.md, open-items.md |
| 통합 | 공유 파일 전부 | 매 반영 후 typecheck·test·smoke |

- 공유 파일(루트 `package.json`·`tsconfig*.json`·`package-lock.json`, `packages/contracts/src/*`, `apps/api/src/main.ts`, `docker-compose.yml`, `CLAUDE.md`)은 통합 담당만 고친다. 다른 작업은 "무엇을 왜 바꿔야 하는지"를 통합 담당에게 보낸다.
- 새 큐 이름·작업 모양·결과 모양이 필요하면 contracts 변경 요청부터 보낸다. 받은 뒤에 쓰는 쪽 코드를 쓴다.
- 새 경로 파일은 B가 만들고, `main.ts`에 등록하는 한 줄은 통합 담당이 넣는다.
- 각 작업은 끝나면 바뀐 파일 목록과 typecheck·test 결과를 통합 담당에게 보낸다.
