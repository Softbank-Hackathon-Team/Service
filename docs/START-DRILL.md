로드맵 위치: 본선 D-6 / 팀 스타트 드릴 / 본선 연결점: 완성도·데모 30, 팀 개발 20 (팀원 누구나 같은 순서로 데모까지 간다)

# 스타트 드릴: 레포를 처음 받아 데모 리허설까지

상태: AI 초안

이 문서는 레포를 처음 받은 팀원이 **한 번에 따라 하는 순서표**다.
받기부터 시험, 데모 리허설까지 단계마다 걸린 시간을 적는다.
각 단계의 자세한 설명과 오류 표는 `docs/QUICKSTART.md`에 있다.
맥에서 전체 초기화부터 끄기까지 반복하는 드릴은 `docs/archive/STARTUP-DRILL.md`다.

기준 코드는 Service 레포 main이다.

## 0. 그림: 무엇을 어떤 순서로 하나

드릴은 일곱 칸을 차례로 지난다.

```mermaid
flowchart LR
  A[받기·도구] --> B[.env 값 받기]
  B --> C[설치·DB]
  C --> D[프로그램 4개]
  D --> E[smoke]
  E --> F[시험]
  F --> G[리허설]
```

- 앞 칸이 끝나야 다음 칸이 된다. 특히 DB가 먼저 떠야 프로그램이 붙는다.
- 실제 클라우드(AWS·GCP·Cloudflare)는 이 드릴에서 건드리지 않는다.
- 클라우드 대신 **시험 스위치**(가짜 Terraform·가짜 Argo 등)를 켜고 돈다. 스위치는 아래 4절에서 설명한다.

## 0-1. 드릴 기록표

드릴을 돌릴 때마다 한 줄씩 채운다. 목표 합계는 30분이다.

| 칸 | 끝난 기준 | 걸린 분 |
|---|---|---|
| 1 받기·도구 | 1절 확인 명령이 모두 버전을 찍음 | |
| 2 .env | `.env`가 있고, 실클라우드면 2-3 확인 명령이 기대 숫자 | |
| 3 설치·DB | `docker compose ps`에 `healthy` | |
| 4 프로그램 4개 | `readyz`가 `{"ok":true}` | |
| 5 smoke | `completed after` 줄 | |
| 6 시험 | `npm test`의 `# fail 0` | |
| 7 리허설 | 마지막 줄 `판정 PASS` | |

## 1. 받기와 도구 (처음 한 번)

### 1-1. 필요한 도구

| 도구 | 버전 | 확인 명령 | 어디에 쓰나 |
|---|---|---|---|
| git | 아무거나 | `git --version` | 레포 받기 |
| Node.js | 22 이상 | `node -v` | api·worker·web |
| npm | Node에 딸려 옴 | `npm -v` | 설치·실행 |
| Docker + compose v2 | 최신 | `docker compose version` | 로컬 Postgres |
| curl | 기본 설치 | `curl --version` | 상태 확인 |
| python3 | 3.9 이상 | `python3 --version` | 리허설 도구 |

실제 클라우드 회차에만 더 필요한 도구다. 드릴에서는 없어도 된다.

| 도구 | 확인 명령 | 어디에 쓰나 |
|---|---|---|
| terraform 1.12 이상 | `terraform version` | 도착 자원 만들기 |
| kubectl | `kubectl version --client` | 클러스터 읽기 |
| helm 3.19 | `helm version` | 차트 렌더 |
| aws CLI | `aws --version` | AWS 읽기 |
| gcloud + gke-gcloud-auth-plugin | `gcloud --version` | GCP 읽기 |

### 1-2. 레포 받기

```bash
git clone https://github.com/Softbank-Hackathon-Team/Service.git
```

- 팀 레포를 내 컴퓨터로 복사한다.

```bash
cd Service
```

- 이 문서의 명령은 모두 이 폴더(`package.json`이 있는 곳)에서 친다.

## 2. .env 만들기와 받아야 할 값

### 2-1. 예시 파일 복사

```bash
cp .env.example .env
```

- `.env.example`에는 키 이름과 개발용 기본값만 있다.
- `.env`는 git에 올라가지 않는다(`.gitignore`).
- 로컬 드릴은 이 상태로도 돈다. 비밀값이 없어도 된다.

### 2-2. 받아야 할 값 목록

실제 클라우드 회차와 AI 기능을 쓰려면 아래 값이 필요하다.
값은 팀 노션에서만 관리한다. 레포·채팅·공유 폴더에 쓰지 않는다.

| 묶음 | 키 이름 | 없으면 |
|---|---|---|
| AI | `ANTHROPIC_API_KEY` | AI 실행이 `LLM_KEY_MISSING` |
| 로그인 | `JWT_SECRET`, `DEMO_USER_EMAIL`, `DEMO_USER_PASSWORD` | 개발에선 띄울 때마다 새로 만듦 |
| 온프레 Agent | `AGENT_REPORT_MASTER_KEY` | 보고 경로 503 |
| 트래픽 | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID` 또는 `_ZONE_NAME`, `CLOUDFLARE_SOURCE_POOL_ID`, `CLOUDFLARE_TARGET_POOL_ID`, `TRAFFIC_PROVIDER`, `TRAFFIC_LB_ID`, `PROM_URL` | shift가 `TRAFFIC_NOT_CONFIGURED` |
| 복제 | `REPL_SOURCE_URL`, `REPL_TARGET_URL` (+ `_PEER_URL`) | sync가 `REPL_NOT_CONFIGURED` |
| GitOps | `GITOPS_REPO_URL`, `GITOPS_WRITE_TOKEN`, `GITOPS_READ_TOKEN` | deploy가 `GITOPS_NOT_CONFIGURED` |
| Argo CD | `ARGOCD_URL`, `ARGOCD_TOKEN` 또는 `ARGO_KUBE_CONTEXT` | 반영 확인이 `ARGO_NOT_CONFIGURED` |
| GCP | `GCP_PROJECT` | GCP 읽기 실패 |

- `AWS_PROFILE`은 사람마다 다르다. 넘기지 않고 각자 자기 프로필 이름을 쓴다.
- 클라우드 로그인(aws, gcloud)은 값 전달이 아니라 각자 한다.

### 2-3. 값 받는 법

- 값은 팀 노션의 환경변수 페이지에서 받는다.
- 내 `.env`의 같은 키 줄에 값을 넣는다. 앞에 `#`이 붙은 줄이면 `#`을 지운다.
- 값을 복사한 뒤 클립보드나 메모장에 남기지 않는다.

확인은 숫자만 나오게 한다.

```bash
grep -c -E '^ANTHROPIC_API_KEY=.+' .env
```

- 기대 출력: `1`. 값은 화면에 안 나온다.

## 3. 설치와 DB

```bash
npm install
```

- `apps/*`와 `packages/*`의 라이브러리를 한 번에 받는다.
- 처음이면 1~3분 걸린다.

```bash
npm run db:up
```

- Postgres 16 컨테이너를 켜고, `db/migrations`의 SQL을 순서대로 넣는다.
- 이미 들어간 파일은 건너뛴다(기록 표 `migrate.applied`).

```bash
docker compose ps
```

- `db`의 STATUS에 `(healthy)`가 보이면 준비 끝이다.

## 4. 프로그램 4개 띄우기

터미널 창 4개를 연다. 모두 Service 폴더에서 시작한다.
이 칸의 명령 앞에 붙은 `MOCK_...=1` 같은 것이 **시험 스위치**다.

### 4-1. 시험 스위치가 뭔가

| 스위치 | 켜면 |
|---|---|
| `MOCK_SEED=1` | 출발 환경을 실제로 읽지 않고 데모 원본을 씀 |
| `MOCK_IAC=1` | terraform을 부르지 않고 가짜 출력 |
| `MOCK_ARGO=1` | Argo CD 반영을 바로 성공으로 봄 |
| `MOCK_PRECHECK=1` | 클라우드 사전 점검을 가짜로 |
| `IMAGE_BUILD=1` | 이미지를 빌드하지 않고 고정 digest |
| `FAKE_LLM=1` | AI 호출 대신 정해진 답 |
| `DEV_AUTH=1` | 로그인 없이 `x-dev-tenant` 헤더로 회사 지정 |
| `GITOPS_DISABLE=1` | gitops 레포에 쓰지 않음 |

- 스위치는 **명령줄에만** 붙인다. `.env`에 쓰지 않는다.
- 이유: `.env`에 남으면 실제 데모에서도 가짜로 돈다. 그러면 화면 숫자가 거짓이 된다.

### 4-2. 터미널 1: 워커

```bash
MOCK_SEED=1 MOCK_IAC=1 MOCK_ARGO=1 \
MOCK_PRECHECK=1 \
FAKE_LLM=1 GITOPS_DISABLE=1 \
GITOPS_REPO_URL= PROM_URL= \
TRAFFIC_OBSERVE_SEC=0.5 \
npm run dev:worker
```

- 큐(pg-boss)에서 작업을 꺼내 이전 상태를 한 칸씩 넘긴다.
- `GITOPS_REPO_URL=`처럼 빈 값을 주면 `.env`에 값이 있어도 끈 것으로 본다.
- `TRAFFIC_OBSERVE_SEC=0.5`: 트래픽 단계마다 0.5초만 관찰한다. 운영 기본은 30초다.

### 4-3. 터미널 2: API

```bash
MOCK_SEED=1 MOCK_CREDS=1 \
FAKE_LLM=1 DEV_AUTH=1 \
GITOPS_DISABLE=1 GITOPS_REPO_URL= \
npm run dev:api
```

- 3000 포트에서 요청을 받는다.

```bash
curl -s localhost:3000/readyz
```

- 기대 출력: `{"ok":true}`. API가 DB까지 붙었다.

### 4-4. 터미널 3: 웹 화면

```bash
npm run dev:web
```

- 기대 출력: `Local: http://localhost:5173/`
- 웹은 `/api` 요청을 3000으로 넘겨 준다.

### 4-5. 터미널 4: AI 에이전트 워커 (선택)

```bash
FAKE_LLM=1 npm run dev -w @svc/agent-worker
```

- `agent-run` 큐만 본다. 운영 권한이 없다.
- AI 점검 장면을 볼 때만 띄운다.

## 5. smoke 1회

```bash
npm run smoke
```

- 이전 1건을 만들고, 계획·승인을 거쳐 끝까지 돌린다.
- 상태가 바뀔 때마다 한 줄씩 찍는다.
- 마지막 줄이 `completed after 약 8000 ms`면 성공이다.
- 브라우저로 http://localhost:5173 을 열면 방금 이전이 `completed`로 보인다.

## 6. 시험

```bash
npm run typecheck
```

- 전체 TypeScript 타입 검사. 기대: 출력 없이 끝남.

```bash
npm test
```

- DB 없이 도는 단위 시험. 스위치는 스크립트가 알아서 붙인다.
- 기대: 마지막 쪽에 `# fail 0`.

```bash
npm run test:db
```

- 실제 Postgres에 붙는 시험. 3절의 DB가 떠 있어야 한다.
- 시험마다 따로 DB를 만들고 끝나면 지운다.
- 기대: `# fail 0`.

처음 한 번은 브라우저 시험용 크롬을 받는다.

```bash
npm exec -w @svc/web -- playwright install chromium
```

- 화면 시험 도구(playwright)가 쓸 브라우저를 받는다.

```bash
npm run test:e2e
```

- 진짜 브라우저로 화면을 눌러 본다.
- api·worker가 안 떠 있으면 시험 스위치를 붙여 스스로 띄운다.
- 기대: `passed`만 있고 `failed` 없음.

## 7. 데모 리허설

4절의 워커·API·DB가 떠 있어야 한다.

```bash
bash tools/rehearse.sh --runs 1 --no-web
```

- 발표 대본 장면 순서대로 데모 명령을 기계가 대신 누르고 시간을 잰다.
- 회차 앞마다 `tools/demo-reset.sh`가 데모 회사(1111…)만 처음 상태로 되돌린다.
- `--no-web`: 화면 시간 재기를 뺀다. 처음엔 이걸로 본다.
- 결과는 `tools/measure/out/rehearse-<시각>/summary.txt`에 남는다.
- 기대: 마지막 줄 `판정 PASS: 1회 ...`.

익숙해지면 화면까지 2회로 돌린다.

```bash
bash tools/rehearse.sh
```

- 2회 돌려 두 회차 결과가 같은지까지 본다.

## 8. 실제 클라우드 회차 (드릴 밖)

이 드릴은 클라우드 자원을 만들지 않는다. 실제 회차는 따로 정한 사람이 정한 컴퓨터에서만 한다.

| 문서·도구 | 내용 |
|---|---|
| `docs/archive/RUNBOOK-FINALS.md` | 본선 당일 순서 |
| `docs/INFRA-INTERFACE.md` | 인프라와 코드가 주고받는 값 |
| `infra/README.md` | Terraform 모듈과 검증 명령 |
| `tools/cloud-precheck.sh` | 회차 전 계정·권한 점검 |
| `tools/cloud-zero.sh` | 회차 뒤 자원 0 확인 |
| 팀 공유 폴더 `MAC-RUN-12`, `ROUND11-FULL` | 실클라우드 회차 손순서 (레포 밖) |

- `terraform apply`·`destroy`는 이 드릴에서 하지 않는다.

## 9. 끄기

- 터미널 1~4에서 각각 `Ctrl+C`.

```bash
npm run db:down
```

- DB 컨테이너를 끈다. 데이터는 남는다.

```bash
docker compose down -v
```

- DB 데이터까지 지운다. 다음 `db:up`에서 마이그레이션이 처음부터 돈다.

## 10. 막힐 때 체크 5개

| 증상 | 먼저 볼 것 | 고치는 법 |
|---|---|---|
| 워커·API가 `ECONNREFUSED 127.0.0.1:5432` | DB가 healthy인가 | `docker compose ps` 확인 뒤 그 터미널을 `Ctrl+C`, 다시 실행 |
| `password authentication failed for user "app_user"` | 예전 DB 볼륨이 남았나 | `docker compose down -v` 뒤 `npm run db:up` (데이터 지워짐) |
| smoke가 `401` 또는 `UNAUTHENTICATED` | API에 `DEV_AUTH=1`을 붙였나 | 4-3 명령 그대로 다시 띄움 |
| 이전이 `failed`, 코드 `TF_BIN_MISSING` 또는 `GITOPS_NOT_CONFIGURED` | 워커에 `MOCK_IAC=1`·`MOCK_ARGO=1`을 붙였나 | 4-2 명령 그대로 워커를 다시 띄움 |
| `EADDRINUSE ... 3000` 또는 `5432` | 다른 서버·Postgres가 포트를 잡았나 | 그 프로그램을 끄거나 `.env`의 `API_PORT`를 바꿈 (`docs/QUICKSTART.md` 4절) |

- 워커가 뜰 때 찍는 `effective config` 줄을 보면 어떤 스위치가 켜졌는지 한눈에 보인다.

## 핵심 결정 3개

1. **시험 스위치는 명령줄에만 붙인다.** 대안: `.env.dev`를 따로 두고 읽기. 버린 이유: 파일로 두면 실제 데모 `.env`에 섞여 들어가 가짜 결과가 화면에 나올 수 있다. 명령줄은 그 터미널에만 남는다.
2. **비밀값은 팀 노션 한곳에서만 관리한다.** 대안: Slack DM에 `.env` 통째로 붙이기. 버린 이유: 메시지 기록에 평문이 남고, 필요 없는 키까지 퍼진다. 레포에는 키 이름(`.env.example`)만 둔다.
3. **드릴 기준은 로컬(시험 스위치) 한 바퀴다.** 대안: 처음부터 실제 클라우드로 연습. 버린 이유: 자원 비용과 계정 권한이 필요하고, 실패 원인이 코드인지 계정인지 섞인다.

## 셀프 연습

워커를 `MOCK_IAC=1` 없이 다시 띄우고 smoke를 돌린다. 이전이 어느 상태에서 어떤 실패 코드로 멈추는지 화면과 워커 로그에서 찾는다. 그다음 스위치를 다시 붙여 `completed`로 돌아오게 한다.

## 검증 명령과 기대 출력

```bash
curl -s localhost:3000/readyz
```

- 기대: `{"ok":true}`

```bash
npm run smoke
```

- 기대: 마지막 줄 `completed after` 약 8000 ms (`docs/QUICKSTART.md` 5절 실측 7,872~8,238 ms)

```bash
npm test
```

- 기대: `# fail 0`

```bash
bash tools/rehearse.sh --runs 1 --no-web
```

- 기대: 마지막 줄이 `판정 PASS`로 시작
