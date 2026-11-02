# infra: 도착 환경 Terraform 모듈

상태: AI 초안

```
packages/adapters  toTerraform(spec, target) ──► infra/modules/<환경>/app   (앱마다, 승인 후 apply)
                   toHelmValues(spec, out)  ──► gitops/charts/app          (Argo CD가 배포)
사람이 한 번       terraform apply            ──► infra/modules/<환경>/env   (클러스터·VPC·저장소)
```

| 폴더 | 무엇을 만드나 | 누가 돌리나 |
|---|---|---|
| `modules/aws/env` | VPC(공개2·사설2) + NAT 1 + EKS + Pod Identity 애드온 + ECR `platform` | 사람, 로컬 세션, 한 번 |
| `modules/aws/platform` | 플랫폼 자체 저장소: 이미지 ECR 4개(`svc-*`, 태그 변경 금지·올릴 때 스캔·최근 10개) + 플랫폼 DB(RDS Postgres 16, 사설, 비밀번호는 RDS가 Secrets Manager에 관리) + 증거 버킷(S3, 퍼블릭 차단·버전 관리·TLS 강제). VPC·EKS는 받기만 하고, 증거 쓰기 권한은 워커 역할 쪽에서 `evidence_bucket_arn`으로 붙인다 | 사람, 한 번 |
| `modules/aws/app` | RDS Postgres(논리 복제 켬, 비밀번호는 RDS가 Secrets Manager에 관리) + 보안 그룹 + 시크릿 그릇 + 앱 IAM 역할(Pod Identity) | worker, 승인된 plan만 |
| `modules/gcp/env` | VPC + Cloud SQL 사설 연결(PSA) + Cloud NAT + GKE(Workload Identity) + Artifact Registry | 사람, 한 번 |
| `modules/gcp/app` | Cloud SQL Postgres(사설 IP, logical_decoding) + DB 사용자·비밀번호 시크릿 + 시크릿 그릇 + 앱 SA(Workload Identity) | worker |
| `modules/onprem/app` | k3s 네임스페이스 + 할당량 + 기본 차단 네트워크 정책 (DB는 차트의 CNPG Cluster) | worker |
| `modules/azure/app` | Mock: Postgres Flexible + Key Vault + 관리 ID. validate·mock plan까지만, apply 안 함 | 없음 |
| `onprem/bootstrap.sh` | k3s + CloudNativePG 오퍼레이터 + ESO + 플랫폼 RBAC | 사람, 한 번 |
| `permissions/` | 앱 모듈 plan/apply/destroy 최소 권한 (AWS 정책 JSON, GCP 커스텀 역할, k8s ClusterRole). 자동 생성 | 계정 세팅 때 |

## 규칙
- 어댑터 계약(`TfVars`)이 평평한 값만 받으므로 목록은 `*_json` 문자열로 넘기고 모듈에서 `jsondecode`.
- 모듈을 고치면 `npm run gen:digests -w @svc/adapters` (모듈 지문 → planHash). 안 하면 테스트가 깨진다.
- 권한표를 고치면 `npx tsx packages/adapters/scripts/export-permissions.ts infra/permissions`.
- `modules/aws/env` kubectl 관리자: 변수 `admin_principal_arn`(선택). 주면 그 IAM role/user에 access entry + `AmazonEKSClusterAdminPolicy`(클러스터 범위), 비우면 `bootstrap_cluster_creator_admin_permissions = true`(terraform 돌린 주체가 admin, 데모용). 이 값을 나중에 바꾸면 EKS가 다시 만들어진다. DRAFT(ai)
- 이 레포의 클라우드 세션에서는 `init -backend=false`, `validate`, `test`(mock)만. **apply/destroy는 사람 승인 후 로컬에서만.**

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
기대 출력: `Success! The configuration is valid.` 그리고 `Success! 3 passed, 0 failed.` (kubectl admin 두 갈래 + 잘못된 ARN 거부)
