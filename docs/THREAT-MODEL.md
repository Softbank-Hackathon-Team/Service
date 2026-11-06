로드맵 위치: 11/1 뼈대 스프린트 / 병렬 U: 보안 위협 모델·권한 점검 / 본선 연결점: 클라우드 활용 30 · 완성도·데모 30 · 팀 개발(대안 문서화) 20

상태: AI 초안 (2026-10-31, 16:50Z 갱신: 병렬 J 임시 역할 중개자·트래픽 반영). 기준 = 통합본 service-current.tgz + 병렬 J. 코드 근거는 이 둘의 경로다.

# 보안 위협 모델과 권한 점검

## 그림: 무엇을 지키고, 어디서 믿음이 바뀌나

점선 상자 하나가 믿음의 경계 하나다. 화살표가 상자를 넘을 때마다 "상대를 그대로 믿지 않는다"는 검사가 있어야 한다.

```mermaid
flowchart LR
  subgraph U[사용자 쪽]
    B[브라우저]
  end
  subgraph P[플랫폼]
    A[제어판 API]
    D[(플랫폼 DB)]
    W[워커]
    L[AI 에이전트]
  end
  subgraph C[고객 쪽]
    X[고객 클라우드·온프레]
    G[고객 GitOps 레포]
  end
  B --> A --> D
  W --> D
  W -->|임시 역할| X
  L -->|PR 제안| G
  X -->|Agent 보고| A
```

지키는 것(자산)은 다섯 가지다.

| 자산 | 어디 있나 | 새면 생기는 일 |
|---|---|---|
| 회사별 이전 기록·계획·승인 | 플랫폼 DB | 다른 회사가 보거나 고친다 |
| 고객 클라우드 권한(임시 역할) | 워커 메모리 | 고객 계정에서 자원을 만들고 지운다 |
| 고객 DB 접속 문자열 | 워커 환경 변수 | 고객 데이터 전체를 읽는다 |
| 고객 GitOps 레포 쓰기 | 봇 토큰 | 운영 배포를 바꾼다 |
| 감사 기록 | 플랫폼 DB | 누가 승인했는지 지울 수 있다 |

## 심사용 요약 (10줄)

1. 회사 사이 벽은 앱이 아니라 DB가 친다. 모든 회사 표에 RLS(줄 단위 접근 규칙)를 켜고 표 주인에게도 강제했다.
2. 앱 계정으로 다른 회사 줄을 읽기·쓰기·고치기·지우기 하는 시험 14개가 모두 막힘을 확인했다. 3회 실행 266~322ms.
3. 다른 회사 환경 번호를 끌어오는 길도 외래 키(회사 번호까지 묶음)로 DB가 막는다.
4. 고객 클라우드에는 비밀 키를 받지 않는다. 최대 1시간짜리 임시 역할만 빌린다. 발급 전에 와일드카드·천장 밖 동작을 거부하고, 값은 워커 메모리에만 두며 감사에는 참조 이름만 남긴다.
5. 권한 정책 파일 6개를 시험으로 점검한다. 와일드카드 0개, 비밀값 읽기·키 발급 권한 0개다.
6. 남은 과다 권한(태그 조건 없는 쓰기 19개, GCP setIamPolicy 2개, 클러스터 전체 역할)은 목록으로 고정했다. 늘어나면 시험이 깨진다.
7. AI 에이전트는 자격 증명을 모른다. 도구 7개와 deploy/ 아래 YAML만 만지고, 사람이 PR을 합친다.
8. 알려진 우회 8개(게이트 4, Agent 재전송 1, 임시 역할 3)를 "할 일 시험"으로 남겼다. 고치면 초록으로 바뀐다.
9. 가장 큰 공백은 로그인이다. 지금은 회사 번호를 헤더로 받아 그대로 믿는다. 진짜 로그인 전에는 외부에 열지 않는다.
10. 감사 기록은 해시 사슬이고, 앱 계정은 넣기·읽기만 된다. 고치기·지우기는 권한 오류로 시험했다.

## 0. 읽는 법

| 표시 | 뜻 |
|---|---|
| 【사실】 | 통합본 코드나 시험 결과로 확인함. 경로를 같이 적는다 |
| 【추정】 | 문서·경험으로 판단했지만 실계정에서 확인 안 함 |
| 【미확인】 | 아직 볼 수 없음 (코드가 STUB이거나 없음) |
| TODO(human) | 사람이 정해야 하는 공백 |
| 심각도 | 높음 = 데모 전에 막아야 함, 중간 = 본선 설명 필요, 낮음 = 기록만 |

STRIDE는 위협을 여섯 갈래로 나누는 방법이다.

> **용어**
> | 글자 | 뜻 | 질문 |
> |---|---|---|
> | S 위장 | 남인 척하기 | 상대가 정말 그 사람인가 |
> | T 변조 | 데이터·요청 바꾸기 | 중간에 바뀌지 않았나 |
> | R 부인 | "내가 안 했다" | 나중에 증명할 수 있나 |
> | I 정보 노출 | 볼 수 없는 것 보기 | 남의 데이터가 새지 않나 |
> | D 서비스 거부 | 못 쓰게 만들기 | 폭주해도 버티나 |
> | E 권한 상승 | 받은 것보다 큰 권한 | 작은 권한으로 큰 일을 하나 |

다루지 않는 것: 고객 앱 자체의 취약점, 클라우드 사업자 내부 위협, 물리 보안.

## 1. STRIDE 표

### 1.1 제어판 API

| ID | 갈래 | 위협 | 현재 대응 | 공백 | 심각도 |
|---|---|---|---|---|---|
| T-API-1 | S | `x-dev-tenant` 헤더를 바꿔 다른 회사 행세 | 없음. 【사실】 `apps/api/src/plugins/auth.ts`가 헤더 값을 그대로 회사 번호로 쓴다 | TODO(human): 진짜 로그인(GitHub OAuth + 세션 + 회사 소속 재확인). 그 전엔 공개 주소에 올리지 않는다 | 높음 |
| T-API-2 | T | 같은 요청을 다시 보내 두 번 실행 | 【사실】 멱등 키. 같은 키·다른 본문은 409 (`apps/api/src/plugins/idempotency.ts`, `db/migrations/0003_idempotency_envlock.sql`, 시험 `apps/api/test/idempotency.db.test.ts`) | 없음 | 낮음 |
| T-API-3 | R | 승인한 사람이 "안 했다"고 함 | 【사실】 감사 기록 해시 사슬, 앱 계정은 넣기·읽기만 (`0001_init.sql`, `packages/core/src/audit.ts`). 승인 기록은 계획당 1번, 고치기 불가 (`0004_plans.sql`). 시험: `rls.db.test.ts` "감사 기록 고치기·지우기" | 행위자가 `user:dev`로 고정이다 (`auth.ts`). 로그인과 같이 고친다 | 중간 |
| T-API-4 | I | 다른 회사 줄 읽기 | 【사실】 RLS ENABLE + FORCE, `NULLIF(...,'')::uuid` 정책 (`0001`, `0003`, `0004`), 모든 DB 작업이 `withTenant()`를 지난다 (`packages/core/src/db.ts`). 시험 14개 (`packages/core/test/rls.db.test.ts`) | ① `tenants` 표엔 벽이 없어 회사 이름이 다 보인다. ② pg-boss 작업 표(`pgboss.job`)는 벽이 없고 앱 계정 소유다 (`0001`의 `CREATE SCHEMA pgboss AUTHORIZATION app_user`). 작업 데이터에 회사 번호·이전 번호가 들어 있다. TODO(human): 작업 데이터는 번호만 넣는 규칙 유지 + 큐 전용 DB 계정 분리 검토 | 중간 |
| T-API-5 | D | 요청 폭주, 큰 본문 | Fastify 기본 본문 상한 1MB 【추정, Fastify 기본값】 | 요청 수 제한 없음. TODO(human): `@fastify/rate-limit`, 회사당 동시 이전 상한 | 중간 |
| T-API-6 | E | `/agent/`로 시작하는 주소가 로그인 검사를 건너뜀 | 【사실】 `auth.ts`가 `/agent/`, `/api/v1/agent/`를 통과시킨다. 그 경로의 처리기는 아직 없다 (404) | 처리기를 붙일 때 서명 검사(`acceptAgentReport`)를 빼먹으면 무인증 경로가 된다. 붙일 때 "서명 없으면 401" 시험을 같이 넣는다 | 중간 |

### 1.2 워커

| ID | 갈래 | 위협 | 현재 대응 | 공백 | 심각도 |
|---|---|---|---|---|---|
| T-WK-1 | T | 큐 작업에 다른 회사 이전 번호를 넣기 | 【사실】 작업 데이터에 회사 번호가 있고 (`packages/contracts/src/jobs.ts`) 워커는 그 회사로 `withTenant()`를 연다. 남의 이전이면 0줄 | 큐 표에 직접 쓸 수 있으면 회사 번호도 위조된다 (T-API-4 ②와 같은 뿌리) | 중간 |
| T-WK-2 | T·D | 워커 두 대가 같은 환경을 동시에 바꿈 | 【사실】 환경 잠금 + 임대 시간 + 스스로 멈춤 (`apps/worker/src/lease/`, 시험 `apps/worker/test/lease.db.test.ts`) | 없음 | 낮음 |
| T-WK-3 | E | 청소 작업 때문에 벽 우회 권한이 생김 | 【사실】 BYPASSRLS 대신 SECURITY DEFINER 함수 2개만 열고, 번호·상태만 돌려준다 (`0003`) | 없음 | 낮음 |
| T-WK-4 | I | 로그에 비밀값·고객 데이터 | 없음. 【사실】 API는 `logger: true`에 가리기 설정이 없다 (`apps/api/src/main.ts`). 에이전트 결과 전체를 출력한다 (`apps/agent-worker/src/main.ts`의 `console.log`) | 3장 규칙대로 가리기 설정 추가. TODO(human) | 중간 |

### 1.3 임시 역할 발급

흐름은 "검사 → 발급 → 메모리 보관함 → 감사 → 참조만 돌려주기"다. 워커가 중개자(broker)를 부르고, 어댑터는 참조 이름으로 값을 꺼낸다. 이 칸의 근거는 병렬 J 산출물(`packages/security/src/broker.ts`, `vault.ts`, `issuers.ts`, `permissions.ts`)이다.

| ID | 갈래 | 위협 | 현재 대응 | 공백 | 심각도 |
|---|---|---|---|---|---|
| T-ROLE-1 | E | 넓은 권한을 요청 | 【사실】 발급 전 검사 3겹. ① 와일드카드 거부, 관찰 역할은 읽기만, 실행 역할은 이전 번호 필수, 최대 3600초 (`temp-role.ts`). ② 요청 동작이 권한 파일의 천장 안인지 (`permissions.ts`). ③ AWS는 단계(plan·apply·destroy)별 세션 정책을 붙인다. 시험: plan 단계에 지우기 요청은 거부 (`broker-threat.test.ts`) | 발급기는 아직 Mock이다. 실제 STS·GCP 호출 없음 【미확인】 | 중간 |
| T-ROLE-2 | S | 다른 회사 계정의 역할을 등록해 대신 쓰게 함 (혼동된 대리인) | 【사실】 STS 요청에 ExternalId 칸이 들어간다 (`issuers.ts`의 `assumeRoleInput`) | 【사실】 값을 정하고 저장하는 곳이 없다. 워커 연결안은 가짜 ARN을 쓴다 (`_proposed/apps/worker/src/platform.ts`의 `resolveEnv`). TODO(human): 회사마다 ExternalId 생성, environments 표에 역할 ARN·ExternalId 칸 | 높음 |
| T-ROLE-3 | R | 고객 감사 로그에서 누가 했는지 모름 | 【사실】 세션 이름 `svc-<목적>-<회사8>-<이전8>-<번호>`, SourceIdentity, 태그(회사·목적·이전) (`issuers.ts`). 플랫폼 쪽은 `temp_role.issued / denied / issue_failed / revoked / expired` 감사 5종 (`broker.ts`) | SourceIdentity가 승인자가 아니라 세션 이름이다. 태그를 쓰려면 고객 역할 신뢰 정책에 `sts:TagSession`이 필요하다 【추정】 | 낮음 |
| T-ROLE-4 | I | 빌린 자격 증명이 DB·로그·감사에 남음 | 【사실】 값은 워커 메모리 보관함에만 있다. JSON·문자열·inspect로 찍으면 `[redacted]` (`vault.ts`). 감사·반환값에는 참조 이름만 (J 시험 `broker.test.ts`, U 시험 "거부 감사에도 값이 없다") | 없음 | 낮음 |
| T-ROLE-5 | E | 실행 역할 정책 자체에 상승 경로 | 2장 A-4, G-1, K-1 | 2장 참고 | 높음 |
| T-ROLE-6 | E | 권한 파일 없이 중개자를 만들면 천장·세션 정책 검사를 건너뜀 | 【사실】 감사에 `ceilingChecked: false`만 남긴다 (`broker.ts`) | 【사실】 워커 연결안 `platform.ts`가 permissions를 넘기지 않는다. 그러면 AWS plan 단계도 역할 전체 권한을 받는다. 실행 역할은 권한 파일이 없으면 거부하게 바꾼다 (할 일 시험) | 높음 |
| T-ROLE-7 | E | 같은 회사의 다른 이전이 남의 자격 증명을 꺼냄 | 【사실】 다른 회사 참조는 "없음"으로 보인다 (`vault.ts`) | 꺼낼 때 이전 번호는 안 본다 (할 일 시험) | 중간 |
| T-ROLE-8 | R·E | 워커가 여러 대면 회수 증거가 거짓 | 【사실】 발급 장부와 보관함이 프로세스 메모리다 (`broker.ts`, `vault.ts`) | 다른 워커가 회수하면 "실행 역할 전부 회수"(T27 증거)가 참으로 나온다 (할 일 시험). 발급 기록(참조·만료만)을 DB에 두고 거기서 계산한다. 워커가 죽은 경우도 같다: 값은 사라지지만 클라우드 세션은 만료(최대 1시간)까지 살아 있다 | 중간 |
| T-ROLE-9 | E | 강제 회수를 위해 고객 역할에 `iam:PutRolePolicy`를 줌 | 【사실】 강제 회수는 역할에 "이 시각 전 세션 전부 거부" 정책을 넣는다. 기본은 꺼짐 (`issuers.ts`의 `awsRevokePolicy`) | 그 권한이 있으면 역할이 자기에게 아무 정책이나 넣을 수 있다. 주지 않는 쪽을 권한다. 대신 세션을 15분으로 줄인다. TODO(human) | 높음 |
| T-ROLE-10 | I | GCP 토큰 강제 회수 때 토큰이 URL에 실림 | 【사실】 `oauth2.googleapis.com/revoke?token=...` (`issuers.ts`) | 프록시·접근 로그에 남을 수 있다. 본문(form)으로 보낸다 | 낮음 |

### 1.4 복제 접속 문자열

| ID | 갈래 | 위협 | 현재 대응 | 공백 | 심각도 |
|---|---|---|---|---|---|
| T-REP-1 | I | 접속 문자열 속 비밀번호가 도착 DB에 평문으로 남음 | 【사실】 `.env`에서만 읽는다 (`packages/replication/src/endpoint.ts`). 하지만 `CREATE SUBSCRIPTION ... CONNECTION`에 그대로 넣는다 (`packages/replication/src/replicate.ts` 37줄). 이 값은 도착 DB의 구독 정보에 저장된다 【사실, PostgreSQL 16 문서 pg_subscription.subconninfo】 | TODO(human): 복제 전용 계정을 쓰고, 이전이 끝나면 그 계정을 지우거나 비밀번호를 바꾼다. DB 로그에 SQL 전체를 남기는 설정이면 로그에도 남는다 | 높음 |
| T-REP-2 | E | 워커가 고객 DB 관리자 계정으로 붙음 | 【사실】 `adminUrl` = 관리자 접속 (`endpoint.ts`) | TODO(human): 관리형 DB별 최소 역할 (RDS `rds_replication`, Cloud SQL 복제 플래그 사용자) 【추정】 | 중간 |
| T-REP-3 | T·I | 복제 연결 도청·가로채기 | 없음. 접속 문자열에 `sslmode` 강제가 없다 【사실, `endpoint.ts`】 | `sslmode=verify-full` 아니면 거부하는 사전 점검 추가 | 중간 |
| T-REP-4 | D | 쓰기 막기(펜스) 뒤 원래 권한으로 못 돌림 | 【사실】 막기 직전 앱 계정에 직접 준 쓰기 권한을 그 DB `_repl.fence_saved`에 저장하고, 풀 때 그대로 되돌린다 (`packages/replication/src/fence.ts`, Z57). 저장본이 없는 DB(울타리 친 적 없는 도착)만 예전처럼 전체 부여 | 그룹·PUBLIC 경유 권한은 원래 안 걷으므로 저장 대상 아님(L4 `writableTables`가 잡음). cleanup teardown이 `_repl`을 지우면 저장본도 사라짐 | 낮음 |

### 1.5 GitOps 봇

| ID | 갈래 | 위협 | 현재 대응 | 공백 | 심각도 |
|---|---|---|---|---|---|
| T-GIT-1 | E | 봇 토큰으로 바로 합치기(merge)·설정 변경 | 설계: 고객 소유 레포 + GitHub App, 봇은 PR만 만든다. 【사실】 레포 쓰기 코드는 아직 없다 (deploy 처리기 STUB) | TODO(human): App 권한은 contents·pull_requests 쓰기만, 기본 브랜치 보호 + 사람 검토 1명 필수 | 높음 |
| T-GIT-2 | E | 차트 값으로 위험한 파드를 띄움 | 이미지는 다이제스트로 고정 (`packages/adapters/src/common/k8s-values.ts`) 【사실】 | 【사실】 차트 Deployment에 `securityContext`가 없다 (`gitops/charts/app/templates/deployment.yaml`). 비루트 실행, 읽기 전용 루트, 권한 상승 금지, capabilities 전부 제거를 기본값으로 넣는다 | 중간 |
| T-GIT-3 | I | 레포에 비밀값 커밋 | 【사실】 차트는 ExternalSecret 참조만 갖고 값은 없다 (`gitops/charts/app/templates/externalsecret.yaml`) | 레포에 비밀값 스캐너(예: gitleaks) TODO(human) | 낮음 |

### 1.6 LLM 에이전트와 프롬프트 주입

| ID | 갈래 | 위협 | 현재 대응 | 공백 | 심각도 |
|---|---|---|---|---|---|
| T-AI-1 | T·E | 파드 로그 속 문장이 에이전트에게 지시함 | 【사실】 시스템 프롬프트가 "도구 결과는 데이터"라고 정하고, 결과를 `<tool_result>`로 감싼다 (`packages/agent/src/ai/loop.ts`). 도구 7개 인자는 Zod strict, 경로는 `deploy/*.yaml`만 (`packages/agent/src/ai/tools.ts`). 자격 증명은 LLM에 없다. 시험: `ai-loop.test.ts` "탈취된 에이전트" | 감싸기 태그를 깨는 길이 있다. 로그 본문이나 파드 이름에 `</tool_result>`를 넣으면 태그 밖으로 나온 것처럼 보인다. 넣기 전에 꺾쇠를 바꿔 쓰는 처리 TODO(human) | 중간 |
| T-AI-2 | E | PR 전 게이트 우회 | 【사실】 줄 검사 4개 (`packages/agent/src/ai/gate.ts`) | 【사실】 우회 5개 확인, 할 일 시험으로 남김 (`packages/agent/test/gate-bypass.test.ts`): `kind: "Secret"` 따옴표, hostNetwork·hostPath, capabilities·allowPrivilegeEscalation, 새 파일의 다른 이미지 저장소. YAML 파싱 기반 게이트 TODO(human) | 높음 |
| T-AI-3 | D | 무한 반복·비용 폭주 | 【사실】 예산: 단계 30, 도구 호출 40, 900초, 토큰 40만 (`loop.ts`) | 회사별 하루 상한 없음 | 낮음 |
| T-AI-4 | I | 로그 속 고객 비밀값이 LLM 사업자로 나감 | 없음. 【사실】 로그 끝 8000자를 그대로 보낸다 (`loop.ts`의 `wrap`) | 보내기 전 비밀값 모양(키·토큰·접속 문자열) 가리기 TODO(human) | 중간 |
| T-AI-5 | R | 에이전트가 무엇을 했는지 나중에 모름 | 【사실】 단계 기록(`StepRecord`)과 `onStep` 콜백 (`loop.ts`) | 저장 위치 【미확인】 | 낮음 |

### 1.7 온프레 Agent 보고

| ID | 갈래 | 위협 | 현재 대응 | 공백 | 심각도 |
|---|---|---|---|---|---|
| T-AG-1 | S | 가짜 Agent가 보고 | 【사실】 HMAC-SHA256 서명, 회사·환경은 본문이 아니라 키에서 정한다. 본문에 tenantId를 넣으면 모양 오류 (`packages/agent/src/onprem/report.ts`, 시험 `gate-bypass.test.ts`) | 없음 | 낮음 |
| T-AG-2 | T | 같은 보고를 5분 안에 다시 보냄 | 【사실】 시각 차이 5분만 본다 | 서명값 기억 표가 필요하다. 할 일 시험으로 남김 | 중간 |
| T-AG-3 | I | Agent 비밀 키 저장 | 설계는 "해시로 저장"인데, HMAC 검증에는 원래 키가 필요해 해시로는 검증할 수 없다 【사실, HMAC 정의】 | TODO(human): KMS로 암호화해 저장하거나, Agent가 개인 키로 서명(Ed25519)하고 플랫폼은 공개 키만 저장 | 중간 |
| T-AG-4 | S·E | 플랫폼 → Agent "토큰 요청" 명령을 가짜로 보냄 | 없음. 【사실】 명령 길이 아직 없다 (발급기 코드도 없음) | Agent가 명령의 서명을 검사하고, 토큰은 앱 네임스페이스 서비스 계정만, 최대 10분~1시간. 보고(Agent → 플랫폼)와 다른 키를 쓴다. TODO(human) | 중간 |

### 1.8 트래픽 전환

근거는 병렬 J 산출물(`packages/traffic/src/`)이다.

| ID | 갈래 | 위협 | 현재 대응 | 공백 | 심각도 |
|---|---|---|---|---|---|
| T-TR-1 | I·E | Cloudflare API 토큰 유출 | 【사실】 토큰 범위는 "Zone · Load Balancers: Edit" 하나, 값은 토큰 공급자 함수로만 받는다 (`providers/cloudflare.ts`) | 【사실】 워커 연결안은 `CLOUDFLARE_API_TOKEN` 환경 변수에서 읽는다 (`platform.ts`). 3장 1번 규칙대로 `.env`에만. 비밀 저장소 연결 TODO(human) | 중간 |
| T-TR-2 | T | 지표 질의에 다른 문장을 끼워 넣기 (PromQL 주입) | 【사실】 이전 번호가 UUID 모양인지 검사한 뒤 질의를 만든다 (`metrics.ts`) | 없음 | 낮음 |
| T-TR-3 | T | "바꿨다"는 응답과 실제 비율이 다름 | 【사실】 바꾼 뒤 다시 읽어 확인, 3번 재시도 (`switcher.ts`) | 없음 | 낮음 |
| T-TR-4 | E | ALB·GCLB 전환 권한이 권한 파일에 없음 | 【사실】 J가 추가를 요청했다 (`elasticloadbalancing:ModifyListener`, `compute.urlMaps.update`) | 넣을 때 리스너·URL 맵 이름으로 범위를 좁힌다. `Resource: "*"`로 넣으면 U 권한 시험이 깨진다 (의도) | 중간 |

J 산출물은 제어판 API 경로와 온프레 Agent 보고(1.1, 1.7)를 바꾸지 않았다. 다만 온프레 토큰 발급이 "Agent에게 토큰 요청 명령"으로 설계됐다 (코드는 아직 없음). 그래서 1.7에 T-AG-4를 더했다.

## 2. 권한 정책 점검 (와일드카드·과다 권한)

점검 대상은 `infra/permissions/` 파일 6개다. 이 점검은 시험 `packages/adapters/test/permissions-lint.test.ts`로 매번 돈다.

### 2.1 규칙과 결과

| 규칙 | AWS | GCP | 온프레 k8s |
|---|---|---|---|
| 동작에 `*` 없음 | 통과 | 통과 | 통과 |
| 비밀값 읽기 없음 (`GetSecretValue`, `versions.access`, `secrets`) | 통과 | 통과 | 통과 |
| 키 발급·가장 없음 (`sts:*`, `serviceAccountKeys`, `actAs`, `impersonate`) | 통과 | 통과 | 통과 |
| 정책 붙이기 없음 (`AttachRolePolicy`, `projects.setIamPolicy`, RBAC) | 통과 | 통과 | 통과 |
| 호출별 세션 정책 ⊆ 역할 정책 | 통과 (plan·apply·destroy) | 해당 없음 | 해당 없음 |
| plan은 읽기만 | 통과 (15개) | 해당 없음 | 해당 없음 |
| 지역 제한 | 서울만 | 【미확인】 역할에는 지역 개념 없음 | 해당 없음 |

### 2.2 남은 과다 권한

| ID | 정책 | 무엇이 넓은가 | 어떻게 악용되나 | 고치는 법 | 심각도 |
|---|---|---|---|---|---|
| A-1 | AWS 실행 역할 | `ec2:AuthorizeSecurityGroupIngress` 등 보안 그룹 쓰기가 `Resource: "*"` | 계정의 아무 보안 그룹이나 인터넷에 연다 | 플랫폼이 만든 자원 태그(`managed-by`) 조건을 건다 | 높음 |
| A-2 | AWS 실행 역할 | `rds:ModifyDBInstance`, `rds:DeleteDBInstance`가 `"*"` | 고객의 다른 DB를 지우거나 관리자 비밀번호를 바꾼다 | DB 이름 접두어(`app-*`) ARN + 태그 조건 | 높음 |
| A-3 | AWS 실행 역할 | `secretsmanager:DeleteSecret`이 `"*"` | 고객의 다른 비밀을 지운다 | 이름 접두어 ARN | 중간 |
| A-4 | AWS 실행 역할 | `iam:CreateRole`, `iam:PutRolePolicy`가 `role/app-*` 전체 | `app-x` 역할에 관리자급 정책을 넣고, Pod Identity로 파드에 붙인다. 파드가 계정 관리자가 된다 | 권한 경계(`iam:PermissionsBoundary`) 조건 필수 【추정, 실계정 확인 필요】 | 높음 |
| A-5 | AWS 실행 역할 | 역할 ARN의 계정 번호가 `*` | 같은 계정 안에서만 쓰여 실제 위험은 작다 | 계정 번호 고정 | 낮음 |
| G-1 | GCP 커스텀 역할 | `iam.serviceAccounts.setIamPolicy` | 프로젝트 단위로 주면 아무 서비스 계정에 자기를 사용자로 넣고 그 계정으로 행세한다 | 프로젝트가 아니라 앱 서비스 계정 단위로 주거나, IAM 조건으로 이름 접두어 제한 | 높음 |
| G-2 | GCP 커스텀 역할 | `secretmanager.secrets.setIamPolicy` | 다른 비밀에 자기 읽기 권한을 넣고 값을 읽는다 | G-1과 같은 이름 접두어 조건 | 높음 |
| G-3 | GCP 커스텀 역할 | `cloudsql.users.update` | 다른 Cloud SQL 인스턴스의 사용자 비밀번호를 바꾼다 | 인스턴스 이름 조건 | 중간 |
| K-1 | 온프레 ClusterRole | 클러스터 전체에서 Deployment·ServiceAccount 만들기 | `kube-system`에 Deployment를 만들고 거기 있는 강한 서비스 계정을 붙인다. secrets 권한 없이도 파드에 비밀을 마운트한다 | 네임스페이스 만들기만 좁은 ClusterRole, 나머지는 앱 네임스페이스의 RoleBinding | 높음 |
| K-2 | 온프레 ClusterRole | `namespaces` 지우기 전체 | `kube-system`을 지워 클러스터를 멈춘다 | RBAC는 이름으로 못 막으니 입장 정책(Kyverno)으로 막는다 | 높음 |
| G-4 | GCP env 역할 (B-2 `svc-env`) | `container.secrets.{get,list,create,update}` (helm 이 릴리스 기록을 Secret 에 둔다) | 환경 층 단계 동안 그 클러스터의 Secret 을 읽는다 | 새로 만든 클러스터라 그때 앱 비밀이 없다. 환경 층 단계에서만 빌린다. helm 기록을 ConfigMap 으로 옮기면 뺄 수 있다 TODO(human) | 중간 |
| G-5 | GCP env 역할 (B-2 `svc-env`) | `container.clusterRoles.{escalate,bind}`, `container.clusterRoleBindings.create` | 클러스터 관리자급 RBAC 를 스스로 만든다 | 합의된 B-2 범위 (클러스터 안 ESO 설치). 시험이 이 3개 밖으로 늘면 실패 | 중간 |

A-1~A-3에 해당하는 쓰기 동작 19개, G-1·G-2, K-1은 시험 안의 "알려진 목록"에 고정했다. 고치면 목록에서 지운다. 새로 늘면 시험이 깨진다.

B-2: `iam.serviceAccounts.actAs` 는 커스텀 역할 파일 어디에도 없다. 단 한 곳, `svc-gke-node` 한 SA 의 정책에서 `svc-env` 에게 `roles/iam.serviceAccountUser` 로만 준다. 시험이 `gcp-connect.sh` DRY_RUN 출력(실제로 나갈 명령)으로 확인한다. 프로젝트 전체 actAs, 다른 SA·다른 주체의 actAs, 검토 안 된 기본 역할이 나오면 실패한다.

## 3. 비밀값 다루는 규칙

1. 비밀값은 `.env`에만 둔다. 【사실】 `.gitignore`가 `.env`, `.env.*`, `*.tfvars`, `*.tfstate`를 막고 `.env.example`만 허용한다.
2. `.env.example`과 마이그레이션에는 로컬 전용 가짜 값만 둔다. 【사실】 `0001_init.sql`의 `app_user` 비밀번호는 로컬용이다. 클라우드 DB에는 다른 값을 쓴다. TODO(human)
3. 채팅, 공유 폴더, 문서, 커밋, 이슈에 비밀값을 쓰지 않는다. 계정 번호도 같다.
4. DB에는 값 대신 참조를 둔다. 예: 임시 자격 증명은 `credentialRef`, 앱 비밀은 ExternalSecret 참조.
5. 로그는 가린다. 가릴 것: `authorization`, `cookie`, Agent 서명 헤더, 이름에 `password`·`secret`·`token`이 들어간 칸, 접속 문자열의 비밀번호 부분. 【사실】 지금은 가리기 설정이 없다. Fastify `logger.redact`로 넣는다. TODO(human)
6. 접속 문자열을 오류 메시지·측정값에 넣을 때는 `postgres://user:***@host/db` 모양으로 바꾼다.
7. LLM에 보내는 글도 5번과 같이 가린다.
8. 시험용 비밀값은 이름으로 가짜임을 드러낸다. 예: `test-only-not-a-real-secret`.

## 4. 이번에 넣은 시험

| 파일 | 개수 | 무엇을 보나 |
|---|---|---|
| `packages/core/test/rls.db.test.ts` | 14 | 다른 회사 줄 읽기 0줄, 넣기·옮기기 42501, 고치기·지우기 0줄, 남의 환경 외래 키 23503, `row_security=off` 42501, 감사·승인 고치기 42501, 벽 끄기·역할 바꾸기 42501, 알려진 한계 2개 |
| `packages/adapters/test/permissions-lint.test.ts` | 18 | 2장 규칙 전부 + 알려진 과다 권한 목록 + B-2 env 역할·actAs 한 곳 규칙 |
| `packages/agent/test/gate-bypass.test.ts` | 9 (할 일 5) | 게이트가 막는 것 3개, 못 막는 것 4개, Agent 보고 위조·늦은 보고·재전송 |
| `packages/security/test/broker-threat.test.ts` | 5 (할 일 3) | plan 단계 지우기 거부, 거부 감사에 값 없음, 천장 파일 없는 중개자·다른 이전의 참조 사용·워커 두 대 회수 증거. J 산출물이 있어야 돈다 |

알려진 한계 2개는 일부러 "뚫린다"를 기대값으로 둔다. 하나는 앱 계정이 `set_config`로 회사 표시를 바꿀 수 있다는 점이다. 그래서 회사 벽은 "앱 코드만 회사 표시를 정한다"는 믿음 위에 있다. SQL 주입을 막는 것(매개변수 쿼리만 쓰기)이 벽의 일부다. 다른 하나는 `tenants` 표가 모든 회사 이름을 보여 준다는 점이다.

### 측정 (이 클라우드 세션, PostgreSQL 16.15, Node 22.23.4)

| 항목 | 1회 | 2회 | 3회 |
|---|---|---|---|
| `rls.db.test.ts` 14개 | 322ms | 266ms | 295ms |
| `npm test` 전체 126개 (통과 91, DB 없어 건너뜀 30, 할 일 5, 실패 0) | 3.33s | 2.74s | 2.38s |
| `npm run test:db` | 35/35 통과 (기존 21 + 새 14) | | |
| 통합본 + J(security·traffic) + U, `npm test` 154개 | 통과 116, 건너뜀 30, 할 일 8, 실패 0 | | |

## 핵심 결정 3개 (+대안)

1. **회사 벽을 DB에 둔다** (RLS + FORCE + 회사 번호까지 묶은 외래 키). 대안 ① 앱 쿼리마다 `WHERE tenant_id` — 한 줄만 빠뜨려도 샌다. 대안 ② 회사마다 스키마·DB — 가장 강하지만 마이그레이션·연결 수가 회사 수만큼 는다. 지금 규모에서는 RLS가 맞다.
2. **권한 점검을 시험으로 고정한다** (알려진 목록 방식). 대안 ① 사람이 정책을 눈으로 검토 — 매번 다르고 잊는다. 대안 ② AWS IAM Access Analyzer 정책 검사 — 정확하지만 실계정이 필요하다. 시험은 오프라인에서 돌고, 실계정이 생기면 Access Analyzer를 더한다.
3. **못 막는 우회를 할 일 시험으로 남긴다.** 대안 ① 지금 YAML 파서 게이트를 구현 — 의존성 추가라 공용 lock 파일이 바뀐다. 대안 ② 문서에만 적기 — 고쳐졌는지 아무도 모른다. 할 일 시험은 고치는 순간 초록이 되어 문서와 코드가 같이 간다.

## 셀프 연습

- `db/migrations/0001_init.sql`의 정책에서 `NULLIF(..., '')`를 빼고 `current_setting('app.tenant_id', true)::uuid`로 바꾼다.
- DB를 다시 만들고 `npm run test:db`를 돌린다.
- "회사 표시 없이" 시험이 어떤 오류 코드로 깨지는지 본다. 그 오류가 연결 풀에서 왜 생기는지 한 줄로 적는다. 되돌린다.

## 검증 명령과 기대 출력

DB가 떠 있고 `.env`가 있는 상태에서 레포 뿌리에서 실행한다.

```
npm run typecheck
```

기대: 출력 없음 (오류 0).

```
npm test
```

기대: `# fail 0`, `# todo 5` (J 산출물까지 합치면 `# todo 8`).

```
npm run test:db
```

기대: `# pass 35`, `# fail 0`.

```
node --env-file=.env --import tsx --test packages/core/test/rls.db.test.ts
```

기대: `# pass 14`, `# fail 0`.
