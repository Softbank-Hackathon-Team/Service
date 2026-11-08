# AWS → 온프레 → AWS 연속 측정 순서

기준: 2026-11-07 22:20 KST 점검. 플랫폼 helm rev44 (`sha-d7cf8e5`), VM Agent rev15 (`sha-d7cf8e5`).

## 지금 설정 (아침 측정과 다른 점)

| 항목 | 아침 (a5f79727·ce031c29) | 지금 |
|---|---|---|
| 롤백 창 `ROLLBACK_WINDOW_SEC` | 120초 | **20초** |
| 리허설 확인 `REHEARSAL_POLL_SEC` | 60초 | **15초** |
| 트래픽 100% 관측 `TRAFFIC_OBSERVE_SEC` | 30초 | **10초** |
| 워커의 Agent 보고 확인 | 5초 | **1초** |
| VM Argo git 확인 | 30초 (+5초) | **10초 (+2초)** |
| VM Agent 보고·폴더 찾기 | 30초 | **10초** |
| terraform provider | 매번 내려받기 | 이미지에 포함 (#379) |

그래서 아침 숫자와 그대로 비교하면 안 된다. 클라우드 도착 트래픽 이동은 여전히 흉내(`MOCK_TRAFFIC=1`)다.

## 0. 시작 전 (터미널)

```bash
bash tools/demo/migration-timing.sh up
```

```bash
bash tools/demo/migration-timing.sh ready aws-onprem
```

`=> 시작해도 된다`가 나와야 한다.

## 1. AWS → 온프레

1. 콘솔에서 이전을 만든다. 출발 `demo2-aws-source`, 도착 `demo2-onprem-target`.
2. **만든 직후** 터미널에서 실행한다.

   ```bash
   bash tools/demo/migration-timing.sh watch latest
   ```

3. 명세 확정·계획 승인은 콘솔에서 누른다. 기다린 시간은 표에 "사람"으로 따로 잡힌다.
4. 완료되면 표가 `tools/demo/runs/<id8>-demo2-aws-source-to-demo2-onprem-target.md`로 저장된다.

## 2. 사이 (온프레 → AWS 전에)

- **도착 네임스페이스 삭제가 필요하다.** 아침 ce031c29가 만든 `app-shop-api`가 도착 EKS에 남아 있다. 남아 있으면 terraform이 네임스페이스를 못 만든다. 내 계정은 권한이 없으니 클러스터 관리자에게 부탁한다.
- **VM 인벤토리가 새로 올 때까지 기다린다.** 약 5분 주기다. 1번이 끝나면서 지운 `db-tunnel`이 빠진 스냅숏이어야 한다.
- 아래가 `=> 시작해도 된다`가 될 때까지 기다린다. 막힌 항목이 그대로 찍힌다.

  ```bash
  bash tools/demo/migration-timing.sh ready onprem-aws
  ```

## 3. 온프레 → AWS

1. 콘솔에서 이전을 만든다. 출발 `demo2-onprem-target`, 도착 `demo2-aws-source`.
2. 만든 직후 실행한다.

   ```bash
   bash tools/demo/migration-timing.sh watch latest
   ```

3. **`SECRET_VALUES_MISSING`으로 멈추면** 비밀값을 채우고 콘솔에서 재개한다. 값은 화면에 나오지 않는다.

   ```bash
   AWS_PROFILE=softbank bash Service/tools/real/fill-app-secrets-onprem-aws.sh
   ```

4. 완료되면 `tools/demo/runs/<id8>-demo2-onprem-target-to-demo2-aws-source.md`로 저장된다.

## 4. 끝나면

```bash
bash tools/demo/migration-timing.sh down
```

## 막히면

- `watch` 화면의 `[실패 코드]`를 본다. 멈춤 시간은 표에 "멈춤"으로 따로 잡혀, 순수 소요에서 빠진다.
- 표를 지금까지 기준으로 다시 뽑으려면 다음을 실행한다.

  ```bash
  bash tools/demo/migration-timing.sh report <id8>
  ```

- 이 순서를 한 번 더 돌리려면 다시 초기화해야 한다. 초기화 대상: 출발 RDS 울타리 해제, VM DB 비우기, Cloudflare 정리, 도착 네임스페이스 삭제.
