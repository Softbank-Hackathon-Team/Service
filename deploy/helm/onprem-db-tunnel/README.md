# onprem-db-tunnel

상태: AI 초안

온프레 클러스터와 클라우드 DB 사이의 논리 복제 길이다. 온프레는 들어오는 포트가 0이므로, 온프레 클러스터 안의 파드가 중계 EC2(`infra/modules/aws/demo-relay`)로 SSH를 밖으로 열고 그 연결 안에 DB 연결을 싣는다.

| 방향 | ssh | 누가 누구에게 붙나 | 쓰는 때 |
|---|---|---|---|
| 정방향 | `-L` | 온프레 CNPG → 이 파드 Service:5432 → 중계 → VPC 안 RDS | 클라우드에서 온프레로 이전 (온프레 CNPG 가 RDS 를 구독) |
| 역방향 | `-R` | 클라우드 → 중계 0.0.0.0:5432 → 이 파드 → 온프레 CNPG | 온프레가 출발일 때, 클라우드에서 온프레로 전환한 뒤 롤백 창 역복제 |

## 보안 모양

- 중계 계정 `tunnel`: 셸·tty·에이전트·X11 없음, 전달 목적지는 `forward_pg_targets_json` 에 적은 RDS 이름:5432 만, 역방향 수신은 5432 만 (sshd `Match User tunnel`).
- 중계 보안 그룹: 정방향 목적지가 있을 때만 VPC 안 5432 로 나가는 규칙 1개. 없으면 나가는 규칙 0개 (예전과 같다).
- 이 파드: 루트 아님(nobody), 읽기 전용 루트, 권한 0, 클러스터 API 토큰 없음. 중계 호스트 키 고정(`StrictHostKeyChecking=yes`, 처음 보는 키는 거부).
- NetworkPolicy: 들어오는 것은 같은 네임스페이스 CNPG 인스턴스의 5432 만, 나가는 것은 DNS·중계 22(`relay.cidr`)·(역방향이면) CNPG 5432 만.
- 비밀키는 차트 값에 넣지 않는다 (Helm 기록에 남는다). Secret 으로 따로 만든다.
- 복제 연결 자체도 TLS 다 (`sslmode=require`, 터널 안에서 CNPG 와 RDS 가 직접 TLS). DRAFT(ai): 주소가 `db-tunnel` 이라 RDS 인증서 이름 확인(`verify-full`)은 못 한다. 대신 중계 호스트 키 고정과 PermitOpen 으로 목적지를 묶는다.

## 순서 (클라우드에서 온프레로)

```
# 1. 터널 키 (온프레 관리 기기에서. 개인키는 레포·채팅에 남기지 않는다)
ssh-keygen -t ed25519 -N "" -C onprem-db-tunnel -f ./db-tunnel

# 2. 중계 EC2 (사람이 apply). 기존 변수에 아래 셋을 더한다
#    tunnel_public_key       = 1 의 db-tunnel.pub 내용
#    forward_pg_targets_json = ["<RDS 엔드포인트>:5432"]
#    tunnel_reverse          = true   (롤백 창 역복제까지 쓸 때)

# 3. 중계 호스트 키 (apply 뒤 한 번. 가능하면 EC2 콘솔 출력의 지문과 대조)
ssh-keyscan -t ed25519 <relay public_ip> > relay_known_hosts

# 4. 온프레 클러스터 (CNPG 가 있는 앱 네임스페이스)
kubectl -n app-<앱> create secret generic db-tunnel-key --from-file=id=./db-tunnel
helm upgrade --install db-tunnel deploy/helm/onprem-db-tunnel -n app-<앱> \
  --set relay.host=<relay public_ip> --set relay.cidr=<relay public_ip>/32 \
  --set-string relay.knownHosts="$(cat relay_known_hosts)" \
  --set forward.target=<RDS 엔드포인트>:5432
kubectl -n app-<앱> rollout status deploy/db-tunnel   # 준비 = 정방향 입구가 열림

# 5. 워커 복제 주소 (packages/replication endpointFromEnv)
#    REPL_SOURCE_PEER_URL = 온프레 CNPG 가 구독할 출발 주소 = 정방향 터널
#      postgres://<복제 계정>:<비밀번호>@db-tunnel.app-<앱>.svc.cluster.local:5432/<DB>?sslmode=require
#    REPL_TARGET_URL      = 워커가 온프레 CNPG 에 관리 SQL 을 넣는 주소 = 역방향 터널 (reverse.enabled=true)
#      postgres://<관리 계정>:<비밀번호>@<중계 사설 IP>:5432/<DB>   + REPL_TARGET_SSLMODE=require
#    REPL_TARGET_PEER_URL = 컷오버 뒤 RDS 가 온프레를 구독할 주소(롤백 창 역복제) = 같은 역방향 터널
#      postgres://<복제 계정>:<비밀번호>@<중계 사설 IP>:5432/<DB>?sslmode=require
#    워커가 중계 5432 에 닿아야 한다: 같은 VPC 이거나 중계 extra_pg_cidrs_json 에 워커 나가는 IP/32

# 끝나면: helm uninstall db-tunnel, Secret 삭제, 중계 destroy, 키 파일 폐기
```

`forward.target` 의 글자는 중계 `forward_pg_targets_json` 과 같아야 한다. sshd `PermitOpen` 은 이름을 그대로 비교한다.

## 앱 차트 안 터널 (끌어오기 모델, 사람 손 없음)

위 순서는 사람이 `kubectl`·`helm` 으로 하는 시연용이다. 같은 터널을 앱 차트(`gitops/charts/app`)가 `dbTunnel` 값으로 그린다. 워커가 이전을 시작할 때 배포 값에 넣고, Argo CD 가 끌어와 적용하고, 정리 때 값을 빼면 지운다.

| 값 | 뜻 |
|---|---|
| `dbTunnel.relay.host` / `port`(기본 22) / `knownHosts`(필수) | 중계 주소와 호스트 키 고정. `host` 가 IPv4 면 나가는 22 를 그 주소/32 로만 연다. 이름이면 포트만 묶는다 |
| `dbTunnel.keySecret`(필수) | 키 `id` = 개인키가 든 Secret. `sealedSecrets[]` 로 들어온다 |
| `dbTunnel.forward.target`(필수) | `"<출발 DB>:5432"`. 중계 `forward_pg_targets_json` 과 같은 글자 |
| `dbTunnel.reverse.enabled` / `cnpgName` | 역방향(-R)을 `<cnpgName>-rw:5432` 로. `cnpgName` 이 없으면 `postgres[]` 의 CNPG 가 하나일 때 그 이름 |
| `dbTunnel.image`(필수) | `@sha256:` 다이제스트 고정 |

- 구독 주소: Service `db-tunnel` (`db-tunnel.<namespace>.svc:5432`, `sslmode=require`).
- 이 차트와 다른 점: 정방향은 항상 켜고, 중계 계정은 `tunnel` 고정, 이름은 `db-tunnel` 고정, NetworkPolicy 는 같은 Cluster(`cnpg.io/cluster`)의 CNPG 인스턴스로만 묶는다.
- 같은 앱 차트에서 함께 쓰는 값: `postgres[].replication`(이전 전용 역할 `svc_migrate`, superuser 없음), `postgres[].certificates`(플랫폼이 준 서버 CA·TLS), `sealedSecrets[]`(역할 비밀번호·터널 키·서버 인증서를 봉인한 값, 범위 strict).
- 시험: `packages/adapters/test/onprem-migrate-chart.test.ts`, CI 값 `deploy/ci/values/v2-onprem-migrate.json`(`deploy/ci/check-gitops.sh` 가 스키마 검사).

## 아직 안 된 것

- 워커가 관리 SQL 을 역방향 터널로 온프레 CNPG 에 넣는 것은 시연용이다 (ADR-005 원칙 위반: 플랫폼이 온프레 DB 관리자 접속을 쥔다). 원칙대로라면 클러스터 안 실행기(W7)다.
- 워커가 중계 5432 에 닿는 길(같은 VPC 또는 `extra_pg_cidrs_json`)은 플랫폼 망 구성에 따라 다르다. 실제 플랫폼에서는 안 해 봤다.
- 실제 AWS 에서 끝까지 (중계 EC2 + RDS) 는 안 해 봤다. 시험은 아래 VM 실측과 Terraform mock 까지다.

## 시험

- `bash deploy/ci/check-onprem-db-tunnel.sh`: 세 벌 렌더(정방향·양방향·역방향), 잘못된 값 7종 거부, 보안 모양 검사. CI `gitops` 작업에서 돈다.
- `infra/modules/aws/demo-relay/tests/mock.tftest.hcl`: 기본값은 tunnel 계정 없음, 정방향이면 나가는 규칙이 VPC 안 5432 하나뿐, PermitOpen·ForceCommand, 5432 아닌 목적지 거부.
- 온프레 VM 실측 (k3s v1.36.5, CNPG 1.30.1, 2026-11-04): VM 의 sshd 를 위와 같은 `Match User tunnel` 블록으로 중계처럼 두고, 가짜 RDS(CNPG) → 터널 → 온프레 CNPG 구독.
  - 처음 복사 1000줄, 새로 넣은 100줄이 108ms 안에 도착. 출발 쪽 복제 연결 TLSv1.3.
  - 터널 파드를 지운 사이에 넣은 100줄도 새 파드가 붙은 뒤 도착.
  - CNPG 가 아닌 파드에서 `db-tunnel:5432` 는 막힘, CNPG 파드에서는 닿음.
  - 역방향: 중계 0.0.0.0:5432 로 Postgres SSLRequest 를 보내면 온프레 CNPG 가 `S` 로 답함.
  - tunnel 계정으로 셸 실행 거부, 허가 안 된 목적지(kube API 443) `-L` 거부, 5432 아닌 `-R` 거부.
- 같은 VM 에서 실제 복제 코드(`packages/replication` `Migration`)로 이전 한 번 전체 (2026-11-04):
  워커 → 출발(가짜 RDS) 직접, 워커 → 중계 5432(역방향) → 온프레 CNPG, 온프레 CNPG → `db-tunnel`(정방향) → 출발.
  - 사전 점검 통과 (경고 DB-06 `max_slot_wal_keep_size=-1` 하나, 터널과 무관한 CNPG 기본값)
  - `sync`: 워커가 출발에 발행, 역방향 터널로 온프레에 구독을 만들고 1200줄 복사, 새 50줄 따라옴 (줄 수 일치)
  - `cutover`: 쓰기 멈춤 96ms, 상태 reverse
  - 롤백 창: 온프레(새 주인)에 넣은 20줄이 역방향 터널로 출발에 도착
  - `rollback`: 출발로 되돌림 ok, `teardown` 뒤 남은 복제 객체 0개, 양쪽 1270줄
