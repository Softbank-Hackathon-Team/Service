# 시연 환경 인계 (2026-11-08 12시 기준)

## 지금 상태

| 시연 | 이전 | 결과 | 브라우저 주소 |
|---|---|---|---|
| demo1 | `demo1-aws-source` → `demo1-gcp-target` (앱 `ironshop1`) | completed, GCP Cloud SQL 100건, 지문 `71df6929` | 공개 주소 없음. `kubectl port-forward` 로만 열림 (아래 "GCP 앱이 localhost 로만 열리는 이유") |
| demo2 | `demo2-aws-source` → `demo2-onprem-target` (앱 `shop-api`) | completed, VM CNPG 102건, 지문 `32678dc4` | https://shop.softbank-team-iron.com |

- 시간 기록: `tools/demo/runs/a3d161d5-*.md`, `tools/demo/runs/97c9ccda-*.md`
- 출발 앱 두 개 모두 ironshop 이미지(PR #385)로 돌고 있다. web `ironshop-web@sha256:9e9b51cb…`, api `ironshop-api@sha256:60d913c7…`(DB 위치 표시 수정본. 소스는 PR #388, #385 브랜치로 머지 대기)

## UI 를 바꿔 다시 시연할 때

1. 새 이미지를 출발 두 곳에 올린다 (namespace `real-app`, deployment `shop-web`·`shop-api`).
   `aws-source-app.sh app` 은 Namespace 를 apply 해서 namespace 권한 사용자는 실패한다. `kubectl set image` 를 쓴다.
2. GCP 이전은 **앱 이름을 새로** 준다 (예: `ironshop2`). 같은 이름이면 Terraform 이 이미 있는 비밀 그릇을 다시 만들다 부딪힌다 (상태가 이전마다 따로라서).
3. 온프레 이전은 같은 앱 이름 `shop-api` 를 쓰므로, 다시 하려면 demo2 를 먼저 초기화한다 (`tools/demo/RUNBOOK-concurrent.md`).

## 비밀 값: 클릭 한 번에 끝나게 해 둔 것

플랫폼은 비밀 값을 옮기지 않는다 (APP-20). 고객이 자기 도구로 넣는 것이 전제다. 시연에서는 "고객이 이미 넣었다" 로 두기 위해 아래를 준비했다.

- **GCP**: `tools/demo/gcp-secret-filler.sh` 가 10초마다 `iron-target-gcp` 의 빈 `app-<앱>-api-secrets` 그릇을 찾아 출발 `real-app/api-secrets` 값으로 채운다. 이전이 자원 생성 단계에서 그릇을 만들고, 배포 직전 검사 전에 채워진다.
  - 실행: `SRC_KUBECONFIG=<src-shop-jun 를 읽을 수 있는 kubeconfig> bash tools/demo/gcp-secret-filler.sh` (켜 둔 채로 이전을 시작)
  - 값은 화면·인자에 안 나온다. DB 비밀번호 그릇은 플랫폼(Cloud SQL)이 채우므로 건드리지 않는다.
  - 출발 클러스터 `src-shop-jun` 읽기 권한은 행사용 임시 access entry 다. 행사 뒤 지운다.
- **온프레**: 비밀은 플랫폼 vault 와 봉인 비밀로 들어가서 멈추지 않는다. 할 일 없음.

## VM 이 끊겼던 이유와 고친 것

- 원인: VM 은 Hyper-V Default Switch 의 DHCP 가 준 DNS `172.27.64.1` 을 썼다. 이 DNS 가 10:24 에 죽어서 (1) Agent 하트비트, (2) containerd 의 이미지 받기(`ghcr.io` 이름 풀이 실패, `ImagePullBackOff`)가 막혔다. demo2 의 `AGENT_DEPLOY_TIMEOUT` 이 이것이다.
- 고친 것:
  - CoreDNS 가 1.1.1.1·8.8.8.8 로 묻게 바꿈 (파드 안 이름 풀이). 백업 `~/coredns-configmap-backup-20261108.yaml`
  - 호스트 DNS 를 영구로 1.1.1.1·8.8.8.8 로 고정 (`tools/demo/vm-fix-dns.sh`: resolved 설정 + netplan `use-dns: false`). 백업 `/root/netplan-backup-*`
  - DNS 고정 중 `netplan apply` 가 DHCP 를 갱신해 VM IP 가 172.27.67.51 → 172.27.78.123 으로 바뀌었다. k3s 는 옛 IP 로 API 를 알리고 있어서 파드가 API 에 못 닿았다 (Agent 하트비트 `no route to host`).
    `tools/demo/vm-fix-ip.sh` 로 172.27.67.51 을 eth0 에 고정 주소로 더하고 (DHCP 주소와 함께), netplan 과 k3s `node-ip` 에 적었다. 재부팅해도 같은 주소로 뜬다.
- 남은 위험: Windows 호스트의 Default Switch 대역(172.27.64.0/20)이 바뀌면 고정 주소가 맞지 않는다 (추정). 그때는 60-public-dns.yaml 의 addresses 와 k3s `node-ip` 를 새 대역으로 고친다.

## GCP 앱이 localhost 로만 열리는 이유와 도메인 붙이는 법

- **지금 여는 법**: 노트북에서 `kubectl -n app-ironshop1 port-forward svc/shop-web 18081:80` 을 띄우고 http://localhost:18081 을 연다.
  GKE 접속에는 `gke-gcloud-auth-plugin` 이 필요하다 (`gcloud components install gke-gcloud-auth-plugin`, 그다음 `gcloud container clusters get-credentials platform-target --zone asia-northeast3-a --project iron-target-gcp`).
  포트 포워드는 그 노트북 안에서만 열린다. 다른 사람·휴대폰에서는 안 열린다.
- **왜 공개 주소가 없나**:
  - GKE 의 `shop-web`·`shop-api` 는 `ClusterIP` 뿐이고 Ingress·LoadBalancer 가 없다. 클러스터 밖에서 닿는 주소가 아예 없다.
  - demo1 출발 앱(`src-shop-jun` `real-app`)부터 Ingress 가 없었다. 플랫폼은 출발의 공개 호스트를 읽어 도착으로 옮기는데, 옮길 호스트가 없었다.
  - 출발에 호스트가 있어도 GCP 도착은 플랫폼이 Cloudflare LB 를 만들지 않는다 (`apps/worker/src/traffic-entry.ts` 의 TODO(human)). 온프레 도착만 자동이다.
- **"DNS 로 포트 포워딩해서 도메인을 띄우면 되나?" → 안 된다.**
  DNS 는 이름을 IP 로 바꿔 줄 뿐이다. `localhost:18081` 은 노트북 자기 자신이라 인터넷에서 닿는 IP 가 아니다.
  DNS 줄이 가리킬 수 있는 것은 (1) 공인 IP 가 있는 입구 또는 (2) Cloudflare 터널뿐이다.
- **도메인을 붙이는 방법** (위에서 아래로 추천 순):

  | 방법 | 하는 일 | 장점 | 단점 |
  |---|---|---|---|
  | GKE 안 Cloudflare 터널 | Cloudflare 에 터널을 하나 새로 만들고, GKE `app-<앱>` 에 cloudflared 를 띄워 `http://shop-web:80` 으로 보낸다. DNS 에 `gcp.softbank-team-iron.com` CNAME → `<터널id>.cfargotunnel.com` | 온프레와 같은 방식. 들어오는 포트·공인 IP 가 없다. 노트북이 꺼져도 열린다 | Cloudflare 자원 2개(터널, DNS 줄)가 생긴다. VM 이 쓰는 터널 토큰을 같이 쓰면 트래픽이 섞이므로 반드시 새 터널 |
  | GKE LoadBalancer / Ingress | `shop-web` 앞에 외부 IP 를 받고 DNS A 줄을 단다 | 클라우드 기본 방식 | 공인 IP 가 열린다. 매니페스트는 Argo 가 관리해서 손으로 바꾼 Service 는 되돌려진다 (selfHeal). gitops 로 넣어야 한다 |
  | 노트북 임시 터널 | `cloudflared tunnel --url http://localhost:18081` | 계정 자원 0, 1분 | 주소가 무작위 `*.trycloudflare.com`, 노트북과 포트 포워드가 살아 있는 동안만 |

- **제품으로 고치려면**: GCP 도착에서도 `prepareTrafficEntry` 가 Cloudflare LB 와 도착 전용 터널을 만들고, 그 터널 토큰을 GCP Secret Manager `cloudflared-token` 그릇에 넣어야 한다 (`apps/worker/src/gitops/ingress-secrets.ts` 가 지금은 공용 토큰으로 채운다. 같은 파일의 TODO(human) 참고). 그리고 출발 앱에 Ingress 호스트가 있어야 한다.

## 알려진 빈칸

- GCP 도착은 공개 도메인을 자동으로 만들지 않는다 (`apps/worker/src/traffic-entry.ts`, TODO(human)). 트래픽 이동도 흉내(mock)다.
- 리허설 샌드박스가 RoleBinding 직후 NetworkPolicy 를 만들 때 권한 반영이 늦으면 403 으로 멈춘다 (`packages/agent/src/ai/vcluster.ts:313-323`). 재개하면 지나간다. 재시도 수정은 행사 뒤.
- Argo 가 새 커밋을 늦게 보면 GCP 앱이 `namespace ... is not managed` 로 몇 분 멈춘다. Argo 에서 `t-11111111-fence` 를 hard refresh 하면 바로 풀린다.
