# CLAUDE.md — Service 레포 작업 규칙

> 상태: AI 초안 (팀 검토 전). 이 파일은 Claude Code가 이 레포에서 일할 때 매번 처음 읽는 규칙이다.
> 사람이 읽어도 되게 썼다. 규칙을 바꾸면 이 파일을 고치고 PR로 올린다.

## 0. 이 레포는 무엇인가

여러 클라우드(AWS, GCP)와 온프레(k3s) 사이에서 고객 서비스를 멈추지 않고 옮겨 주는 플랫폼의 코드다.
고객은 비밀 키 대신 임시 권한(IAM 역할)을 빌려주고, 플랫폼은 돌고 있는 서비스를 읽어 "공통 명세(IR)"로 바꾼 뒤,
도착 환경용 Terraform/Helm 입력값으로 번역하고, 사람이 승인한 계획대로만 이전·전환·롤백한다.
보안(회사 간 격리, 가드레일, 보안 현황 한 표)이 팀 특화 테마다.

지금 단계는 **스켈레톤**이다. 돌아가는 첫 뼈대(npm workspaces, api·worker·contracts·core·adapters, DB 마이그레이션, smoke)가 이미 있다. 목표는 "아키텍처 9개 영역이 전부 빈 껍데기라도 연결돼서 한 번 돈다"이고,
기능·API 명세는 이 코드에서 거꾸로 뽑는다. 그러니 완성도보다 **모양(폴더·입출력 계약·이름)의 일관성**이 우선이다.

## 0-1. 아키텍처 전제 (모든 작업이 공유)

코드를 쓰기 전에 이 전제를 바꾸지 않는다. 바꿔야 할 것 같으면 사람에게 먼저 묻는다.

- 이전 방식은 **리플랫폼**이다. 앱은 도착 환경에 새로 배포하고, DB는 논리 복제(CDC)로 따라가게 한 뒤 컷오버한다. 디스크 통째 복사(리호스트)는 하지 않는다.
- DB는 **관리형 Postgres(RDS) 먼저**. 다른 DB 종류는 나중이다.
- 환경: **AWS와 GCP는 필수**, **온프레(k3s + CloudNativePG)도 반드시 보여 준다**. Azure는 어댑터 모양과 가짜(Mock)만 둔다.
- 이전 대상 고객 앱은 **3티어**(웹, API, DB)를 기준으로 한다.
- AI 에이전트의 추론은 **상용 LLM API**(Anthropic)를 부른다. 모델 서버를 직접 띄우지 않는다.
- 고객 권한은 비밀 키가 아니라 **임시 역할**로 빌린다(관찰 역할, 실행 역할 분리). 코드에 자격 증명을 넣지 않는다.
- 아직 코드에 없는 선택(데모 경로가 어느 방향인지, 환경별로 어떤 자원을 쓸지 등)은 어댑터에 `// STUB:`이나 `// TODO(human):`으로 남기고 Claude가 정하지 않는다.

## 1. 무엇이 확정이고 무엇이 초안인가 (가장 중요)

AI가 쓴 내용이 팀 결정처럼 굳어지는 걸 막기 위한 규칙이다.

- 근거의 우선순위: **팀 회의에서 확정한 것 > 그 영역을 맡은 사람이 정한 것 > 설계 문서·명세 > AI 추측**.
  설계 문서와 회의 결정이 다르면 회의 결정을 따르고, 어긋남을 PR 설명에 적는다.
- 코드에서 사람이 정하지 않은 값을 Claude가 정했으면 바로 위에 주석을 단다.
  - `// DRAFT(ai): <무엇을 왜 이렇게 정했나>` — AI가 임시로 정한 것. 팀 검토 대상
  - `// DECISION(team): <결정 요약> (근거 문서/회의 날짜)` — 사람이 확정한 것. Claude는 이걸 지우거나 바꾸지 않는다
  - `// STUB: <나중에 진짜로 할 일>` — 가짜 구현. 그럴듯한 고정값을 돌려준다
  - `// TODO(human): <사람이 골라야 할 설계 결정>` — Claude가 정하면 안 되는 것
- 새 문서(`docs/` 아래)는 첫 줄 아래에 `상태: AI 초안 | 팀 검토 중 | 팀 확정` 중 하나를 쓴다. Claude는 `팀 확정`을 직접 달지 않는다.
- 명세 역추출 때는 `DRAFT(ai)`와 `STUB`를 grep 해서 "아직 안 정한 것" 목록을 만든다: `grep -rn "DRAFT(ai)\|STUB:\|TODO(human)" apps packages db`

## 2. 아키텍처 9개 영역과 코드 위치

| 번호 | 영역 | 한 줄 | 코드 위치 |
|---|---|---|---|
| 1 | 입력층 | 웹 콘솔, CLI, 로그인, 회사(테넌트), 고객 환경 원클릭 연결(키 0개, 임시 역할) | `apps/web`, `apps/api/src/plugins/auth.ts`, `apps/api/src/routes/environments*` |
| 2 | API 서버 + 오케스트레이터 | 요청 접수 → 상태 한 칸 옮기기(`advance()`) → 큐에 작업. api와 worker가 같은 코어 코드를 씀 | `apps/api`, `apps/worker`, `packages/core` |
| 3 | 가져오기 · 공통 명세 · 어댑터 | 관찰 역할로 고객 자원 읽기 → 공통 명세(AppSpec) → 환경별 Terraform/Helm 입력값 | `packages/contracts/src/spec.ts`, `packages/adapters`, `infra/` |
| 4 | 이전 계획 · 상태 머신 · DB 컷오버 | 점검, 계획, 승인, 22개 상태, DB 논리 복제와 컷오버 | `packages/contracts/src/migration.ts`(상태 표), `apps/worker/src/jobs/*` |
| 5 | 트래픽 전환 · 자동 롤백 | 10→50→100% 가중치 전환(Cloudflare LB), 지표가 나쁘면 되돌림 | `apps/worker/src/jobs/traffic*`, 결과 모양은 `packages/contracts/src/results.ts` |
| 6 | GitOps · 여러 클러스터 배포 | 같은 Helm 차트를 Argo CD로 세 환경에 배포. Argo CD가 읽는 렌더 결과는 **별도 gitops 레포** | `gitops/`(차트 원본), 별도 gitops 레포 |
| 7 | 보안 · 거버넌스 | 이전 중 가드레일, 보안 수집기(규칙 기반) → 통제 항목 한 표 | `apps/worker/src/jobs/security*`, `Finding` 계약 |
| 8 | AI 에이전트 · 샌드박스 | 격리된 샌드박스(vCluster)에서만 점검·수정, 결과는 사람이 승인 | `apps/agent-worker`(`agent-run` 큐), `AgentFinish` 계약 |
| 9 | 플랫폼 운영 · 관측 | 우리 플랫폼 자체(EKS 위 api/worker/web) 배포, 지표, 장애 대응 | `deploy/` |

이전 한 번의 정상 흐름: 연결(1) → 가져오기·명세(3) → 계획·승인(4) → 자원 생성(3, Terraform) → 배포(6) → DB 복제·트래픽 이동(4, 5) → 컷오버(4) → 롤백 가능 창 → 정리.
그동안 보안(7)은 계속 감시하고, 에이전트(8)는 샌드박스 안에서만 움직인다.

설계 근거 문서(읽기 전용 참고, 고치지 않는다): 레포 밖 팀 공유 폴더의 `notes/architecture/` (api-orchestrator-v1.md, 01-input-layer-flows.md, 12-fastify-lifecycle-and-zod.md, HANDOFF.md, 아키텍처 그림). 레포에는 `documents/` 폴더가 없다.

## 3. 스택

뼈대에 이미 들어간 버전이 기준이다. 바꾸려면 PR 설명에 이유를 쓴다. `DRAFT(ai)` 표시는 팀 합의 전 기본값이다.

| 부분 | 선택 | 메모 |
|---|---|---|
| 언어·런타임 | TypeScript 5.9, Node.js 22 | ESM(`"type": "module"`), import 경로에 `.js` 확장자 |
| 패키지 관리 | **npm workspaces** (pnpm 안 씀) | 패키지 이름 `@svc/<이름>` |
| HTTP 서버 | Fastify 5 + `fastify-type-provider-zod` | 예선 코드 재사용 기준 |
| 입력·명세 검사 | Zod 4 | 모든 계약은 `packages/contracts`. `npm run schemas`로 JSON Schema 내보냄 |
| 작업 큐 | pg-boss 12 (`createSchema: false`, `pgboss` 스키마는 초기화 SQL이 만듦) | 상태 변경과 같은 트랜잭션에서 작업을 넣기 위해 |
| DB | PostgreSQL 16, 회사 격리는 `tenant_id` + RLS(FORCE, NULLIF 정책) | 로컬은 `docker compose`의 `db` |
| DB 스키마 변경 | `db/migrations/NNNN_*.sql` | `DRAFT(ai)` 실행 도구(지금은 컨테이너 초기화 때 적용) |
| 테스트 | Node 내장 `node:test` + `tsx` | 라우트는 `app.inject()` (포트 안 열고 호출) |
| 로그 | pino (Fastify 내장) | 본문·토큰은 로그에 남기지 않는다 |
| 웹 | `DRAFT(ai)` React + Vite | 지금은 README 자리만 |
| 인프라 코드 | Terraform (상태 파일은 S3 `use_lockfile`), Helm, Argo CD | 스켈레톤에선 파일만, 실행 안 함 |
| LLM | Anthropic API (에이전트 기본 모델은 설계 문서 기준) | 키는 환경변수, 코드에 넣지 않는다 |

## 4. 폴더 구조 규칙

레포는 이 Service 모노레포 하나 + Argo CD가 읽는 gitops 레포 하나로 나눈다.

```
apps/
  api/           Fastify 서버. src/main.ts, src/plugins (auth, errors, …), src/routes
  worker/        pg-boss 작업 처리. src/jobs/<작업>.ts
  agent-worker/  AI 에이전트 루프 (agent-run 큐). 운영 권한 없음
  web/           웹 콘솔
packages/
  contracts/     모든 경계 계약(Zod): spec(AppSpec), migration(상태 22개·VALID), jobs(QUEUES·작업 내용),
                 events(SSE), plan, results(Finding, DeployResult, AgentFinish, Measurement), adapter(EnvironmentAdapter), common
  core/          db.ts(withTenant), advance.ts, audit.ts(해시 체인), boss.ts(pg-boss), errors.ts(DomainError)
  adapters/      aws, gcp, onprem, azure-mock: EnvironmentAdapter 구현
db/migrations/   0001_init.sql, 0002_seed_dev.sql …
infra/           Terraform 모듈
gitops/          앱 Helm 차트 원본 (렌더 결과는 gitops 레포로)
deploy/          우리 플랫폼 자체 배포
tools/           smoke.ts 등 개발용 스크립트
docs/            SKELETON-PLAN.md, contracts/, reviews/
```

- 패키지 하나 = 폴더 하나 = `src/index.ts`에서만 밖으로 내보낸다. 다른 패키지의 `src/` 안쪽 파일을 직접 import 하지 않는다. 다른 패키지는 `"@svc/<이름>": "*"`로 의존한다.
- 파일 이름은 kebab-case(`create-migration.ts`), 타입·스키마 이름은 PascalCase(`MigrationView`), 함수는 camelCase.
- 표에 없는 최상위 폴더나 새 패키지를 만들려면 먼저 사람에게 묻는다.

## 5. 모듈 입출력 계약 원칙

팀원이 영역을 나눠 붙어도 깨지지 않게 하기 위한 규칙이다.

1. **경계를 넘는 데이터는 전부 `packages/contracts`의 Zod 스키마로 정의한다.** 타입은 `z.infer`로만 만든다. 패키지·앱 안에서 경계용 타입을 따로 손으로 쓰지 않는다. 계약을 바꾸면 쓰는 쪽 전부가 타입 검사로 깨지니, 같은 PR에서 고친다.
2. **각 패키지 README 맨 위에 계약 표를 둔다**: 이 모듈의 목적 한 줄 / 받는 것 / 넘기는 것 / 부작용(DB 쓰기, 큐, 외부 호출) / 실패 시 에러 코드.
3. **큐 작업도 계약이다.** pg-boss 큐 이름(`QUEUES`)과 작업 데이터 스키마(`JOB_SCHEMAS`)는 `packages/contracts/src/jobs.ts` 한 곳에 모은다. 워커는 작업 내용을 믿지 않는다. 받은 작업을 이 스키마로 parse 하고, 상태·명세 같은 실제 값은 DB에서 다시 읽은 뒤 처리한다.
4. **어댑터는 `discover`만 네트워크를 쓰고 나머지는 순수 함수다.** 같은 입력이면 같은 출력이라 테스트로 고정된다.
5. **상태를 바꾸는 길은 `advance()` 하나다.** 라우트나 작업 코드가 `UPDATE migrations SET status`를 직접 쓰면 안 된다. 상태를 바꾸는 POST 하나 = `advance()` 한 번.
6. **회사 경계**: DB를 쓰는 모든 코드는 `withTenant(tenantId, tx => ...)`를 거친다. 인증·회사 플러그인은 `fastify-plugin`으로 감싼다(안 감싸면 훅이 경로에 안 걸려 회사 값이 빈 채로 RLS 위반 500이 난다). 회사 번호는 SQL 문자열에 이어 붙이지 않고 매개변수로 넘긴다. 남의 회사 자원은 403이 아니라 404로 보인다.
7. **에러 모양 하나**: 응답은 contracts의 `ApiError` 모양, 코드 안에서는 `DomainError(status, code, message)`와 그 하위 클래스(`packages/core/src/errors.ts`). 상태 규칙 위반은 409 `InvalidTransition`.
8. **스켈레톤 단계의 외부 호출은 전부 가짜(STUB)** 로 두고, 진짜 구현과 같은 계약을 지킨다. 진짜로 바꿀 때 호출부가 안 바뀌어야 한다.

## 6. 작업 방식

- 스켈레톤 순서와 프롬프트: `docs/SKELETON-PLAN.md`.
- 반복 작업은 `.claude/skills/`의 스킬을 쓴다: 엔드포인트 추가, 상태 전이 추가, 어댑터 추가, DB 마이그레이션 추가, 설계 대조 검토.
- 모듈 하나를 만들면 같은 커밋 안에 테스트 하나 이상(정상 흐름 1개 + 거부 1개)을 둔다.
- 끝나면 아래 확인 명령을 돌려 통과한 것만 "끝"이라고 말한다. 못 돌렸으면 못 돌렸다고 쓴다.

```bash
cp .env.example .env          # 환경변수 예시 파일을 실제 파일로 복사 (.env는 커밋 안 됨)
npm install                   # 모든 workspace 의존성 설치
docker compose up -d --wait db   # 로컬 Postgres 켜고 준비될 때까지 기다림
npm run typecheck             # 전체 타입 검사
npm test                      # 전체 테스트
npm run dev:worker            # (터미널 1) 워커 실행
npm run dev:api               # (터미널 2) API 실행
npm run smoke                 # (터미널 3) 이전 하나를 만들어 상태가 넘어가는지 확인
```

- 커밋 메시지 형식(PR 템플릿과 같음): `type(scope): 요약` — type은 feat | fix | refactor | chore | docs | test | perf, scope는 패키지·영역 이름.

## 7. 금지 사항

- **실제 클라우드 자원을 만들거나 지우지 않는다.** `terraform apply` / `destroy`, `aws ... create-*`, `gcloud ... create`, 실제 클러스터에 `kubectl apply`, `helm install` 금지. `terraform init -backend=false`, `terraform validate`, `terraform fmt`, `helm template`, `helm lint`까지만 된다.
- **비밀값을 커밋하지 않는다.** API 키, 클라우드 자격 증명, DB 비밀번호, `.env`, `*.tfstate`, `*.tfvars`(예시 파일 제외)는 저장소에 넣지 않는다. 예시는 `.env.example`에 가짜 값으로만. 로그·테스트 스냅숏에도 비밀값을 남기지 않는다.
- **git commit / push / PR 생성은 사람이 시킬 때만** 한다. `main`에 직접 push 하지 않는다. 브랜치에서 PR로만.
- 팀 공유 폴더 `notes/architecture/`의 설계 문서는 고치지 않는다(참고용).
- 새 외부 의존성(npm 패키지)을 넣을 때는 PR 설명에 이유와 대안 하나를 쓴다. 같은 일을 하는 패키지를 두 개 넣지 않는다.
- 코드·문서에 사람 이름, 담당자, 개발 일정을 적지 않는다. 영역 이름으로만 쓴다.
- 테스트를 끄거나 건너뛰어서 통과시키지 않는다.
