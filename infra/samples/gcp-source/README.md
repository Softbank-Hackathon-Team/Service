# GCP 출발 샘플 (src-gcp-sample)

상태: AI 초안

GCP→온프레·GCP→AWS 이전 시험용 "고객이 이미 운영 중인 서비스"를 프로젝트 `iron-source-gcp`(리전 `asia-northeast3`)에 만든다. AWS 출발 샘플(`src-aws-sample`)과 모양을 맞췄다.
새 자원 정의는 없다. 기존 모듈 두 개(`modules/gcp/env`, `modules/gcp/kinds/postgres`)를 부르기만 한다.

| 무엇 | 값 |
|---|---|
| 네트워크 | VPC `platform-target` + 노드 서브넷 + Cloud SQL 사설 연결(PSA) + Cloud NAT(고정 IP 1개) |
| 클러스터 | GKE Standard 영역 클러스터 `platform-target` (`asia-northeast3-a`), e2-standard-2 노드 2대, 사설 노드 |
| 레지스트리 | Artifact Registry `platform` (env 모듈이 늘 만든다. 샘플은 안 씀) |
| DB | Cloud SQL Postgres 16 `sample-shop-db`, `db-f1-micro`, 20 GB, 사설 IP만, TLS 필수, `cloudsql.logical_decoding=on`, 백업 1개 |
| DB 안 | DB `shop`, 계정 `app`(비밀번호는 Secret Manager `app-shop-sample-shop-db-db-password`), 표 `orders` 100행 (`seed`) |
| 앱 | 네임스페이스 `real-app`: `shop-web`(nginx)·`shop-api`(http-echo), 이미지 digest 고정 (`app`) |
| state | GCS `gs://<프로젝트>-tfstate`, prefix `sample/gcp-source` (`backend.tf` 는 빈칸, init 때 받음) |

## AWS 샘플과의 대응

| AWS (`src-aws-sample`) | GCP (`src-gcp-sample`) |
|---|---|
| `modules/aws/env` (VPC + EKS `platform-target`) | `modules/gcp/env` (VPC + GKE `platform-target`) |
| `modules/aws/kinds/postgres` (RDS) | `modules/gcp/kinds/postgres` (Cloud SQL) |
| RDS `sample-shop-db`, `rds.logical_replication=1` | Cloud SQL `sample-shop-db`, `cloudsql.logical_decoding=on` |
| RDS 엔드포인트 → `__DB_HOST__` | Cloud SQL 사설 IP → `__DB_HOST__` |
| RDS 관리 비밀번호 (Secrets Manager) | `random_password` → Secret Manager |
| `tools/real/flow/sample-3tier-eks.yaml.tpl` | 같은 파일 그대로 |
| `orders` 100행 | 같은 표 모양, 100행 |

## 비용 【추정】

서울 리전 정가 기준, 할인·무료 등급은 빼고 계산했다. 실제 청구서로 확인하지 않았다.

| 항목 | 시간당 |
|---|---|
| GKE 영역 클러스터 관리비 | 약 $0.10 (결제 계정당 영역 클러스터 1개는 무료 크레딧으로 상쇄) |
| e2-standard-2 × 2 | 약 $0.17 |
| Cloud NAT + 고정 외부 IP | 약 $0.01 |
| Cloud SQL db-f1-micro + 20 GB SSD | 약 $0.02 |
| 합계 | **약 $0.30/시간 (하루 약 $7)** |

켜 둔 동안 계속 과금된다. 시험이 끝나면 `down` 한다.

## 명령 (Cloud Shell, 레포 루트)

```bash
bash tools/gcp-source.sh up     # API 켜기 → state 버킷 → terraform apply → kubeconfig. 25~35분
bash tools/gcp-source.sh app    # real-app 에 shop-web·shop-api. 2~3분
bash tools/gcp-source.sh seed   # orders 표 + 100행 (GKE 안 일회용 Job). 1~2분
bash tools/gcp-source.sh down   # real-app 삭제 → Cloud SQL → 피어링 → 나머지 destroy → 0 확인. 15~20분
```

- 모든 명령에 `--dry-run` 을 붙이면 클라우드에 쓰는 명령을 찍기만 한다.
- 로그는 `~/.svc-tf/gcp-source/<명령>-<시각>.log` 에 남는다. 화면에는 단계만 나온다.
- 프로젝트·버킷을 바꾸려면 `GCP_PROJECT=... TF_STATE_BUCKET=...` 를 앞에 붙인다.

## 주의

- Cloud SQL 은 사설 연결(PSA)이 있어야 만들어진다. env 모듈이 그 연결을 출력으로 내보내지 않아서 `module.db` 가 `module.env` 전체를 기다린다. 그래서 GKE 노드 풀까지 끝난 뒤에 DB 를 만들기 시작한다.
- PSA 연결은 env 모듈에서 `deletion_policy = "ABANDON"` 이다. `down` 은 `tools/demo-day.sh` 의 `d_gke` 와 같은 순서로 지운다. 먼저 Cloud SQL 을 지우고(`-target=module.db`), 다음에 gcloud 로 피어링을 지우고 state 에서 뺀다. 그 뒤에 나머지를 destroy 한다.
- 【추정】 Cloud SQL 인스턴스 이름은 지운 뒤 최대 1주일 동안 다시 쓸 수 없다. `down` 직후 `up` 을 다시 하면 `sample-shop-db` 에서 막힐 수 있다.
- state 버킷은 `down` 이 지우지 않는다. 지우려면 사람이 `gcloud storage rm -r gs://<버킷>` 을 실행한다.
- DB 비밀번호는 terraform state(GCS)에도 들어간다 (kinds/postgres 의 `random_password`). 버킷 읽기 권한을 좁게 둔다.
