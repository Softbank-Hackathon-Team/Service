# infra: 도착 환경 Terraform 모듈

상태: AI 초안

```
packages/adapters  toTerraform(spec, target) ──► infra/modules/<환경>/app   (앱마다, 승인 후 apply)
                   toHelmValues(spec, out)  ──► gitops/charts/app          (Argo CD가 배포)
사람이 한 번       terraform apply            ──► infra/modules/<환경>/env   (클러스터·VPC·저장소)
```

| 폴더 | 무엇을 만드나 | 누가 돌리나 |
|---|---|---|
| `modules/aws/bootstrap` | 플랫폼 계정 Terraform state 버킷(S3, 퍼블릭 차단·버전 관리·암호화·TLS 강제). 이름은 고정 `sb-iron-platform-tfstate`(겹치면 `-var bucket_name=...` 으로 바꾸고 `aws/platform/backend.tf` 의 `bucket` 도 같이 바꾼다). state 는 사람이 자기 자격 증명으로 읽고 쓴다 | 사람, 로컬 state, 맨 처음 한 번 |
| `modules/aws/env` | VPC(공개2·사설2) + NAT 1 + EKS + Pod Identity 애드온 + ECR `platform` + ESO·ClusterSecretStore | 사람, 로컬 세션, 한 번 |
| `modules/aws/platform` | VPC·EKS(노드 그룹 3개: general·cred·sandbox. sandbox 노드 gVisor(runsc) 설치는 `sandbox_gvisor_enabled`, 기본 끔)·ECR·RDS·증거 S3 + Pod Identity(worker·api·ESO, `pod-identity.tf`. 고객 이전 state 위치가 정해지지 않아 워커 state 권한은 넣지 않음)·비밀 그릇 `platform/app`·`platform/cloudflared`. 비밀 연동·입구 차트는 `deploy/helm/platform` | 사람, 한 번 |
| `modules/aws/app` | RDS Postgres(논리 복제 켬, 비밀번호는 RDS가 Secrets Manager에 관리) + 보안 그룹 + 시크릿 그릇 + 앱 IAM 역할(Pod Identity) | worker, 승인된 plan만 |
| `modules/gcp/env` | VPC + Cloud SQL 사설 연결(PSA) + Cloud NAT + GKE(Workload Identity) + Artifact Registry + ESO·ClusterSecretStore | 사람, 한 번 |
| `modules/gcp/app` | Cloud SQL Postgres(사설 IP, logical_decoding) + DB 사용자·비밀번호 시크릿 + 시크릿 그릇 + 앱 SA(Workload Identity) | worker |
| `modules/onprem/app` | k3s 네임스페이스 + 할당량 + 기본 차단 네트워크 정책 (DB는 차트의 CNPG Cluster) | worker |
| `modules/azure/app` | Mock: Postgres Flexible + Key Vault + 관리 ID. validate·mock plan까지만, apply 안 함 | 없음 |
| `onprem/bootstrap.sh` | k3s + CloudNativePG 오퍼레이터 + ESO + 플랫폼 RBAC | 사람, 한 번 |
| `charts/` | Terraform `helm_release` 가 쓰는 작은 차트 (`cluster-secret-store`: env 모듈이 ESO 뒤에 설치). 사람·Argo CD 가 직접 설치하지 않음 | env 모듈(Terraform) |
| `permissions/` | 앱 모듈 plan/apply/destroy 최소 권한 (AWS 정책 JSON, GCP 커스텀 역할, k8s ClusterRole). 자동 생성 | 계정 세팅 때 |

## 규칙
- 어댑터 계약(`TfVars`)이 평평한 값만 받으므로 목록은 `*_json` 문자열로 넘기고 모듈에서 `jsondecode`.
- 모듈을 고치면 `npm run gen:digests -w @svc/adapters` (모듈 지문 → planHash). 안 하면 테스트가 깨진다.
- 권한표를 고치면 `npx tsx packages/adapters/scripts/export-permissions.ts infra/permissions`.
- `modules/aws/env` kubectl 관리자: 변수 `admin_principal_arn`(선택). 주면 그 IAM role/user에 access entry + `AmazonEKSClusterAdminPolicy`(클러스터 범위), 비우면 `bootstrap_cluster_creator_admin_permissions = true`(terraform 돌린 주체가 admin, 데모용). 이 값을 나중에 바꾸면 EKS가 다시 만들어진다. DRAFT(ai)
- 이 레포의 클라우드 세션에서는 `init -backend=false`, `validate`, `test`(mock)만. **apply/destroy는 사람 승인 후 로컬에서만.**

## 실행 순서
`aws/bootstrap` → `aws/env`·`aws/platform` → 앱(worker). 정리는 역순, bootstrap 맨 마지막.
- bootstrap destroy 전에 버킷의 모든 버전·삭제 마커를 비워야 한다 (`force_destroy=false` + 버전 관리).
- `aws/env`·`gcp/env`: ESO·ClusterSecretStore 는 기본으로 안 만든다(`create_eso=false`). 클러스터가 뜬 뒤 같은 `-var` 에 `-var create_eso=true` 를 더해 apply 한다. 그 뒤 기본값으로 다시 apply 하면(up 스크립트 등) ESO 가 지워진다.

```
cd infra/modules/aws/bootstrap
terraform init
terraform apply -var expected_account_id=$(aws sts get-caller-identity --query Account --output text)
cd ../platform
terraform init
terraform apply -var expected_account_id=$(aws sts get-caller-identity --query Account --output text)
```
- 이미 로컬 state 로 platform 을 apply 한 적이 있으면 `terraform init -migrate-state` 로 옮긴다.
- bootstrap 의 로컬 `terraform.tfstate` 는 레포 밖에 보관한다. 잃어버려도 버킷은 남고 `terraform import` 로 다시 잡는다.

## 환경 층 자동 생성 (`ENV_LAYER_AUTO`, GCP 도착만)

상태: AI 초안. 아키텍처 이전 9단계의 "4 기반 생성". 도착 GCP 프로젝트(`gcp_target_project`)에 GKE 가 없으면 worker 가 apply 단계 맨 앞에서 `modules/gcp/env` 로 VPC·GKE·Artifact Registry·ESO 를 만든다.

| 항목 | 내용 |
|---|---|
| 켜기 | worker env `ENV_LAYER_AUTO=1` (DRAFT(ai) 기본 꺼짐. 꺼져 있으면 예전과 같다: `TF_FACT_*` 또는 `TF_FACTS_MISSING`) |
| 사실 고르는 순서 | ① DB `environment_layers` 줄이 ready ② worker `TF_FACT_*` ③ 둘 다 없고 켜져 있으면 만든다. 도착 프로젝트에 클러스터가 이미 있는데 ①이 없으면 만들지 않고 `NEEDS_HUMAN` |
| 승인 | 계획서 `envLayer.mode=create` + 확인 항목 `env_layer_create`(GKE 비용 고지). apply 는 계획 때의 입력 지문(`varsHash`)·모듈 지문이 같을 때만 만든다 |
| 실행 | 작업 폴더 `TF_WORK_DIR/<회사>/env-<환경 id>/`, 1차 `create_eso=false`(클러스터) → 2차 `create_eso=true`(ESO). 두 번이 예산 `TF_ENV_LAYER_BUDGET_SEC`(DRAFT 1800초)를 나눠 쓰고, 켜져 있으면 apply 큐 기한에 그만큼 더한다 |
| 자격 | B-2: 만드는 동안만 고객 `svc-env` 를 빌린다 (`STEP_ROLES.env_layer`, 역할 `platform_env` = 읽기 + 만들기, 지우기 없음). 노드는 고객 `svc-gke-node` 로 돈다(`node_service_account`). 못 빌리면 `ENV_LAYER_CRED_MISSING` 으로 멈춘다 (worker 자기 SA·`svc-operate` 로 만들지 않음). 고객이 `gcp-connect.sh` 를 다시 실행하면 생긴다 |
| state | 작업 폴더 로컬 파일 (`envLayerBackend()` 한 곳, TODO(human): 원격 저장) |
| 실패 | 줄 `status=failed`, 이전은 `ENV_LAYER_APPLY_FAILED`. 만들다 만 자원은 지우지 않는다. 다시 계획·apply 하면 같은 state 로 이어 만든다 |

운영 주의
- 비용: e2-standard-2 노드 2대 + Cloud NAT + 고정 외부 IP 1개가 이전이 끝나도 계속 과금된다.
- 이전의 롤백·정리(target-destroy)는 환경 층을 지우지 않는다 (환경 소유). 지울 때는 사람이 그 작업 폴더에서
  `cd modules/gcp/env && terraform destroy -var-file=../../../terraform.tfvars.json` 뒤 DB 줄을 지운다. 먼저 그 환경을 쓰는 이전이 없는지 확인한다.
  `google_service_networking_connection` 은 ABANDON 이라 피어링은 `gcloud services vpc-peerings delete` 로 따로 지운다 (위 UPREV 주석).
- worker 디스크(#265 EBS)를 잃으면 state 도 잃는다. 그때는 `terraform import` 로 다시 잡거나 줄을 ready 로 두고 사실만 쓴다.
- TODO(human) B-2: ESO 신원(GSA·`app-` secretAccessor·Workload Identity 바인딩)은 `svc-env` 권한 밖이다 (svc-eso setIamPolicy·프로젝트 setIamPolicy 금지). 정할 때까지 2차(`create_eso=true`)가 403 으로 `ENV_LAYER_APPLY_FAILED`(failedPhase=eso) 가 된다. 1차 클러스터는 남고, 결정 뒤 다시 계획·apply 하면 같은 state 로 이어 만든다.

## 검증 명령
```
cd infra/modules/aws/app
terraform init -backend=false
terraform validate
npx tsx ../../../../packages/adapters/scripts/write-tfvars.ts /tmp/tfvars
terraform test -var-file=/tmp/tfvars/aws.tfvars.json
```
기대 출력: `Success! The configuration is valid.` 그리고 `Success! 2 passed, 0 failed.`

```
cd infra/modules/aws/env
terraform init -backend=false
terraform validate
terraform test
```
기대 출력: `Success! The configuration is valid.` 그리고 `Success! 8 passed, 0 failed.` (access 5: kubectl admin 두 갈래 + 잘못된 ARN 거부 + EKS 끔/켬, eso 3: create_eso=true / create_eks=false 면 켜도 0개 / 기본은 0개)

```
cd infra/modules/gcp/env
terraform init -backend=false
terraform validate
terraform test
```
기대 출력: `Success! The configuration is valid.` 그리고 `Success! 5 passed, 0 failed.` (mock 2: GKE 켬/끔, eso 3: create_eso=true / create_gke=false 면 켜도 0개 / 기본은 0개)

```
cd infra/modules/aws/bootstrap
terraform init -backend=false
terraform validate
terraform test
```
기대 출력: `Success! The configuration is valid.` 그리고 `Success! 1 passed, 0 failed.` (버킷 이름·보호 설정)
