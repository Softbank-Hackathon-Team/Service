# reverse-lab — 역방향(온프레 → 클라우드) 이전 로컬 실험장

상태: AI 초안 (ADR-031, 팀 검토 전)

AWS 계정, 온프레 VM, 플랫폼 권한 없이 노트북 하나에서 온프레 → 클라우드 이전을 끝까지 돌린다.
DB 복제는 진짜다. 클라우드 호출(IaC, Argo CD, STS)은 흉내다.

## 무엇이 진짜와 같은가

| 실제 | 실험장 | 같은 점 |
|---|---|---|
| 고객 VM 안 CNPG | `onprem-pg` (PG16) | 들어오는 포트 0 (호스트에 포트 안 엶). superuser 가 아닌 `svc_migrate` (CNPG managed role 과 같은 속성·멤버십). 앱 계정 `shop_app` = DB·표 주인 (온프레 앱 차트 기본) |
| 클라우드 VPC 안 RDS | `cloud-pg` (PG16) | 호스트에 포트 안 엶. superuser 가 아닌 관리자 `app` (RDS 마스터처럼 CREATEROLE·CREATEDB) |
| 중계 EC2 | `relay` (sshd) | sshd 설정이 `apps/worker/src/relay/aws-relay.ts` user-data 와 같다 (PermitOpen 하나, PermitListen 5432, 셸·tty 없음). 플랫폼 입구 :15432 |
| 온프레 터널 파드 | `tunnel` (ssh) | ssh 명령·플래그가 `deploy/helm/onprem-db-tunnel/templates/tunnel.yaml` 과 같다. 호스트 키 고정 (TOFU 없음) |
| 온프레 Agent | `e2e.ts` 안 실험장 Agent | 실제 Agent 와 같은 서명 하트비트 (`@svc/agent`). kubectl 대신 고정 답 |

길 두 개:

- 주 복제: 클라우드 DB → `relay:5432` → 터널(`-R`) → 온프레 DB. 워커의 온프레 관리 접속도 이 길 (호스트 `127.0.0.1:56432`)
- 롤백 창 역복제: 온프레 DB → `tunnel:5432` → 터널(`-L`) → 중계 → 클라우드 DB. 워커의 클라우드 관리 접속은 중계 입구 (호스트 `127.0.0.1:56433`)

## 실제와 다른 점 (여기서 통과해도 실환경에서 따로 봐야 한다)

- RDS 는 복제 권한을 `rds_replication` 멤버십으로 준다. 일반 Postgres 로는 흉내 낼 수 없어 클라우드 관리자에게 REPLICATION 속성을 직접 줬다. 그래서 클라우드 끝점 provider 는 `postgres` 다
- TLS 끔 (`REPL_SSLMODE=disable`). 실환경은 이전마다 CA·verify-full (ADR-019)
- 중계 EC2 만들기·지우기, 도착 VPC 보안 그룹, 끝점 행(`replication_endpoints`)은 안 쓴다. 워커는 env `REPL_*` 길로 끝점을 정한다 (`platform.env`)
- 가져오기는 흉내 명세 (`MOCK_SEED`). 온프레 Agent 가 명세를 보고하는 길은 아직 없다

## 처음 한 번

필요한 것: Docker, Node 22+, 레포 루트의 `.env` (`cp .env.example .env`), 로컬 플랫폼 DB (`docker compose up -d --wait db`).
psql 은 없어도 된다 (컨테이너 안 psql 을 쓴다).

```bash
npm run lab:reverse -- up
```

`up` = 키 만들기(처음 한 번, `.state/`) → 컨테이너 4개 → 데이터 넣기 → 두 길 확인. 끝에 `ok: svc_migrate ... orders=500` 과 `ok: app` 이 나오면 된다.

## 1. 복제 엔진만 시험 (1분)

```bash
npm run test:lab:reverse
```

`packages/replication/test/reverse-lab.it.ts` 2건: 롤백 경로(복제 → 컷오버 → 롤백 창 시험 행이 온프레로 → 롤백 → 잔여물 0), 완료 경로(컷오버 → 정리, 옛 온프레는 울타리 유지).

## 2. 플랫폼 전체 (api·worker 상태 머신)

```bash
npm run lab:reverse -- platform          # api :3100 + worker 를 뒤에서 (로그 tools/reverse-lab/.state/*.log)
npm run lab:reverse -- e2e rollback      # 약 20초. 롤백 창에 클라우드에 시험 행 → 온프레로 오는지 → 롤백
npm run lab:reverse -- reset             # 판마다 먼저
npm run lab:reverse -- e2e complete      # 약 80초. 롤백 창(60초)을 지나 정리까지
npm run lab:reverse -- platform-stop
```

- 같은 로컬 DB 를 보는 다른 worker(`npm run dev:worker`)는 꺼 둔다. 작업을 가로채 실험장 env 없이 돈다
- `platform` 이 "DB 마이그레이션 N개를 안 넣음" 으로 api·worker 를 안 띄우면: `npm run db:migrate`. 로컬 DB 에 표는 있는데 기록이 빠진 경우만 `MIGRATION_CHECK=0 npm run lab:reverse -- platform`
- 출발은 실험장 전용 온프레 환경 `reverse-lab-onprem` (없으면 만들고 Agent 키를 발급해 하트비트를 보낸다). 도착은 시드 AWS 환경 `22222222-…`

## 판과 판 사이

`reset` = 양쪽 구독·슬롯·발행·복제 전용 계정·`_repl` 제거 → 클라우드 표 비우기 → 온프레 표 다시 만들기(customers 50, orders 500). 실환경의 "처음 이전하는 고객" 상태와 같다 (ADR-030).

## 상태 보기·끄기

```bash
npm run lab:reverse -- status    # 두 길 + 양쪽 복제 객체 수
npm run lab:reverse -- down      # 컨테이너·볼륨 삭제 (키는 .state 에 남는다)
```

## 비밀값

`init/*.sql`, `platform.env` 의 비밀번호·마스터 키는 실험장 전용 고정값이다. 컨테이너와 로컬 api 밖에서 쓰이지 않는다.
터널 키·중계 호스트 키·Agent 키는 `.state/` 에 만들고 커밋하지 않는다 (`.gitignore`).
