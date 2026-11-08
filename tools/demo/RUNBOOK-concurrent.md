# 시연 두 개 동시 측정 순서 (AWS → GCP, AWS → 온프레)

기준: 2026-11-08 10:50 KST. 플랫폼 helm rev45 (`sha-18b856a`).

| 시연 | 출발 | 도착 | 앱 | 상태 |
|---|---|---|---|---|
| demo1 | `demo1-aws-source` (EKS `src-shop-jun`, RDS `jun-shop-db`) | `demo1-gcp-target` | 이전 기록의 앱 이름 `m1shop`, `m2shop` | 출발 DB 울타리는 확인 못 함 (플랫폼 클러스터에서 `jun-shop-db` 에 닿지 않음). 맡은 팀원이 확인 |
| demo2 | `demo2-aws-source` (EKS `platform-target`, RDS `sample-shop-db`) | `demo2-onprem-target` | `shop-api` | 초기화 끝, `ready aws-onprem` 통과 |

## 동시에 돌려도 되는 근거 (설정 실측)

- 회사당 동시 이전 상한 `TENANT_MAX_ACTIVE` 가 없다 (0 = 끔).
- 리허설 동시 실행 `SANDBOX_REHEARSAL_CONCURRENCY=5`, sandbox 노드 5대. 두 리허설이 줄 서지 않는다.
- 두 쌍은 출발 클러스터, 출발 RDS, 도착이 모두 다르다. 같은 것은 AWS 계정(`725072160743`)과 플랫폼 워커 1대뿐이다.
- 도메인 `shop.softbank-team-iron.com` 은 demo2 만 쓴다. GCP 도착은 트래픽 이동이 흉내(`MOCK_TRAFFIC=1`)라 Cloudflare 를 건드리지 않는다.

## 순서

1. 측정 파드를 띄우고 demo2 점검을 다시 본다.

   ```bash
   bash tools/demo/migration-timing.sh up
   ```

   ```bash
   bash tools/demo/migration-timing.sh ready aws-onprem
   ```

2. 콘솔에서 두 이전을 연달아 만든다.
   - demo1: 출발 `demo1-aws-source`, 도착 `demo1-gcp-target`
   - demo2: 출발 `demo2-aws-source`, 도착 `demo2-onprem-target`
3. 번호를 확인한다. 맨 위 두 줄이 방금 만든 두 건이다.

   ```bash
   bash tools/demo/migration-timing.sh list
   ```

4. 터미널 두 개에서 각각 지켜본다 (`latest` 대신 번호 앞 8자를 쓴다. 두 건이라 latest 는 하나만 잡는다).

   ```bash
   bash tools/demo/migration-timing.sh watch <demo1 번호>
   ```

   ```bash
   bash tools/demo/migration-timing.sh watch <demo2 번호>
   ```

5. 명세 확정, 계획 승인은 콘솔에서 누른다. 기다린 시간은 각 표에 "사람"으로 따로 잡힌다.
6. 둘 다 끝나면 표가 `tools/demo/runs/` 에 저장된다. 끝난 뒤 도메인이 어디로 가는지 본다 (demo2 는 VM 이어야 한다).

## 멈추면

- `SECRET_VALUES_MISSING` 은 온프레 → AWS 에서만 나온다. 이번 두 방향에서는 나오지 않는다.
- VM Agent 보고가 끊기면 VM DNS 를 본다. 2026-11-08 10:24 에 Hyper-V DNS(`172.27.64.1`)가 멈췄고, VM CoreDNS 가 `1.1.1.1`, `8.8.8.8` 로 묻게 바꿔 살렸다. 원래 설정 백업: VM `~/coredns-configmap-backup-20261108.yaml`.

## 끝나고 다시 하려면 (demo2)

```bash
bash tools/demo/reset-roundtrip.sh check
```

`src`, `vm`, `cf` 를 `run` 으로 되돌린다. `aws`, `ns` 는 온프레 → AWS 를 다시 할 때만 필요하다.
