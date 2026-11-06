# 팀 환경 준비 (다섯 명이 같은 회사에서 동시에 이전 시험)

상태: AI 초안

칸마다 회사(테넌트)가 따로다: slot-1 은 `dev-company`(회사 번호 `11111111-1111-4111-8111-111111111111`), slot-2~5 는 등록부 칸의 `tenant` 회사. 회사가 다르면 회사 단위 큐 몫·환경 목록·환경 이름이 따로라 서로 막지 않고 동시에 이전한다. 가입은 같은 초대 코드로 하고, 그 칸의 회사로 들어간다. 각자 자기 클라우드 계정에 출발·도착 환경을 만들어 연결하고, 누가 무엇을 쓰는지는 [`registry.yaml`](registry.yaml)에 적는다.
11/06 실측(`src-aws-sample` → `GCP-sample`)에서 멈춘 곳을 미리 피하는 순서다. 근거: 이슈 #317, PR #313·#316·#323.

## 0. 규칙 (등록부 맨 위와 같음)

- 환경 하나에 진행 중인 이전은 하나다 (플랫폼 잠금). 회사가 칸마다 달라 남의 환경은 콘솔에 안 보인다
- AWS 계정 하나에 환경을 여럿 연결해도 된다. 새로 연결하는 환경은 역할 이름에 환경 꼬리가 붙는다(`svc-observe-<환경 앞 8자>` 등, 마이그레이션 0056 이후). 그래서 같은 계정이어도 자기 환경을 따로 만들어 연결하면 이전 잠금을 남과 나누지 않는다. 계정의 두 번째 스택부터는 권한 경계 `platform-app-boundary` 를 만들지 않는다(`CreateBoundaryPolicy=false`, `npm run env:connect` 가 `aws iam get-policy` 로 보고 알아서 넣음). 경계를 만든 첫 스택은 마지막에 지운다. 이미 연결된 옛 환경(꼬리 없음, 예: `src-aws-sample`)은 그대로 같이 써도 된다 (자세히: [`infra/onboarding/README.md`](../../infra/onboarding/README.md) "한 계정에 여럿")
- GCP 전용 프로젝트는 한 사람만 쓴다. 환경 층 이름(`platform-target` 등)이 고정이라 같이 쓰면 부딪힌다
- 공유 환경(slot-1: `src-aws-sample`, `GCP-sample`)은 팀 채널에 "쓴다/다 썼다"를 알리고 쓴다

## 1. 가입

1. 운영자가 초대 코드를 따로(개인 메시지로) 준다. 코드 원문은 어디에도 붙여 넣지 않는다
2. 콘솔에서 **회원가입** → 자기 칸의 로그인 아이디(`registry.yaml` 의 `login`) + 초대 코드 + 새 비밀번호
3. 가입하면 자기 칸 `environments` 에 적힌 환경이 콘솔에 생긴다 (이름으로 찾아서 없을 때만 만든다. 있는 환경은 안 바꾼다)
4. 환경을 더하려면 `registry.yaml` 자기 칸에 적고 PR → 운영자가 반영. 그다음 아래 연결 명령을 돌린다

```bash
bash tools/team-env.sh slot-2          # 자기 칸의 GCP 연결 명령을 값까지 채워 찍는다 (실행은 안 함)
bash tools/team-env.sh slot-2 --check  # 읽기 전용 gcloud 로 프로젝트·API 가 다 있는지만 본다
bash tools/team-env.sh slot-2 source   # 자기 칸 환경마다 출발 샘플 앱을 올리는 명령 (3절, 실행은 안 함)
```

## 2. GCP 도착 (전용 프로젝트)

1. 빈 전용 프로젝트를 만들고 결제 계정을 붙인다 (원래 프로젝트와 다른 것, 다른 사람과 겹치지 않는 것)
   ```bash
   gcloud projects create <전용>
   gcloud billing projects link <전용> --billing-account=<결제 계정 ID>
   ```
2. `registry.yaml` 자기 칸에 GCP 환경을 적는다: `{ name: s2-gcp, provider: gcp, region: asia-northeast3, gcp: { original_project: <원래>, dedicated_project: <전용> } }`
3. `bash tools/team-env.sh <slot>` 이 찍은 줄을 위에서부터 차례로 실행한다 (두 프로젝트 소유자로 gcloud 로그인, 레포 루트). 손으로 치면 아래와 같다
   ```bash
   PLATFORM_SA=t-5b7095dff329bac5840a31c433e7@sb-iron-platform.iam.gserviceaccount.com \
   PROJECT_ID=<원래> TARGET_PROJECT_ID=<전용> bash infra/onboarding/gcp-connect.sh
   # 예전 스크립트로 이미 연결한 프로젝트면 아래도 (켜져 있거나 권한이 있으면 바뀌는 것 없음)
   gcloud services enable cloudbilling.googleapis.com --project=<원래>    # #313 PC-BILL
   gcloud services enable cloudbilling.googleapis.com --project=<전용>
   gcloud iam roles update platform_env --project=<전용> --add-permissions=compute.addresses.setLabels,compute.globalAddresses.setLabels,compute.instanceGroupManagers.get,serviceusage.operations.get
   gcloud iam roles update platform_operate --project=<전용> --add-permissions=compute.instanceGroupManagers.get,resourcemanager.projects.get,secretmanager.versions.enable,serviceusage.operations.get
   gcloud iam roles update platform_plan --project=<전용> --add-permissions=compute.instanceGroupManagers.get,serviceusage.operations.get
   ```
   `PLATFORM_SA` 는 그 칸 회사의 회사 전용 SA 다 (`t-<md5(회사 번호) 앞 28자>`, 비밀 아님, 연결 화면에도 같은 값이 보인다. `tools/team-env.sh` 가 칸 회사로 계산한다). `gcp-connect.sh` 를 다시 돌려도 이미 있는 `platform_env`·`platform_operate` 는 건너뛴다. 그래서 위 `roles update` 를 따로 친다 (#316).
4. **첫 앱 층 apply 뒤 (#317 14번)**: `TF_APPLY_FAILED` 에 `iam.serviceAccounts.setIamPolicy` 403 이 보이면, 앱 SA 마다 실행 SA 에 권한을 주고 다시 시도한다 (조건식이 SA 이름을 못 읽는 버그 우회. 이전마다 새 SA 가 생기면 또 한다)
   ```bash
   for sa in $(gcloud iam service-accounts list --project=<전용> --filter='email~^app-' --format='value(email)'); do
     gcloud iam service-accounts add-iam-policy-binding "$sa" --project=<전용> \
       --member=serviceAccount:svc-operate@<전용>.iam.gserviceaccount.com --role=projects/<전용>/roles/platform_operate_iam
   done
   ```
5. **Argo 동기화 전 (#317 21번, #323 이 모듈에 들어가기 전까지)**: `replicationcontrollers is forbidden … in the namespace "app-<앱>"` 이면 앱 네임스페이스에 읽기 Role 을 하나 더한다. Terraform 이 관리하는 `platform-deploy-app` 은 건드리지 않고 이름이 다른 Role 을 만든다. #323 이 들어오면 지운다
   ```bash
   gcloud container clusters get-credentials platform-target --project=<전용> --location=<클러스터 위치>
   kubectl apply -f - <<'EOF'
   apiVersion: rbac.authorization.k8s.io/v1
   kind: Role
   metadata: { name: argo-cache-read, namespace: app-<앱> }
   rules:
     - { apiGroups: ["*"], resources: ["*"], verbs: ["get", "list", "watch"] }
   ---
   apiVersion: rbac.authorization.k8s.io/v1
   kind: RoleBinding
   metadata: { name: argo-cache-read, namespace: app-<앱> }
   roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: argo-cache-read }
   subjects:
     - { apiGroup: rbac.authorization.k8s.io, kind: User, name: t-5b7095dff329bac5840a31c433e7@sb-iron-platform.iam.gserviceaccount.com }
   EOF
   # #323 반영 뒤: kubectl -n app-<앱> delete role,rolebinding argo-cache-read
   ```
   읽기는 그 네임스페이스의 Secret 까지 포함한다 (#323 과 같은 트레이드오프, 쓰기는 없음). EKS 도착이면 subject 를 `{ apiGroup: rbac.authorization.k8s.io, kind: Group, name: platform:deploy }` 로 바꾸고, #323 머지 뒤에는 `kubectl apply -f infra/permissions/eks-deploy-rbac.yaml` 로 대신한다.

## 3. 출발 샘플 앱 (GCP·AWS)

이전해 볼 "이미 운영 중인 서비스" 자리다. 모양은 하나: `shop-web`·`shop-api` + Postgres DB `shop` 의 `orders` 100행, 네임스페이스 `real-app`.
명령은 등록부 자기 칸에서 값까지 채워 찍는다. 찍힌 줄을 위에서부터 차례로 친다.

```bash
bash tools/team-env.sh slot-2 source   # 칸의 환경마다: gcp → tools/gcp-source.sh, aws → tools/aws-source-app.sh
```

- 환경마다 "이미 있는지" 읽기 줄이 있다. 이미 올라가 있으면 건너뛴다
- 공유 환경(slot-1)은 이미 올라가 있을 수 있다 (확인 줄로 본다). 팀 채널에 알리고 쓰고, `down` 은 치지 않는다
- `down` 은 주석으로만 찍힌다 (붙여 넣어도 지우지 않게)
- `app`·`seed` 의 기본 이미지는 태그라 `docker buildx` 로 digest 에 고정한다. Docker 가 없으면 `WEB_IMAGE`·`API_IMAGE`·`SEED_IMAGE` 를 `repo@sha256:<digest>` 로 export 한다 (그러면 Docker 없이 그대로 쓴다. 두 스크립트 같음)

### GCP

`tools/gcp-source.sh` 가 원래 프로젝트에 VPC·GKE `platform-target`·Cloud SQL `sample-shop-db` 까지 만든다 (`infra/samples/gcp-source`, 서울 고정). 약 $0.30/시간, 끝나면 `down`.
찍히는 줄은 `GCP_PROJECT=<원래> TF_STATE_BUCKET=<원래>-tfstate REGION=<등록부 region> bash tools/gcp-source.sh up|app|seed` 다. 줄 끝에 `--dry-run` 을 붙이면 명령 순서만 본다.

샘플도 `platform-target` 이름을 쓰니 **원래 프로젝트에만** 올린다 (전용 프로젝트에 올리면 도착 환경 층과 부딪힌다).

### AWS

`tools/aws-source-app.sh` 는 **이미 있는** EKS(등록부 `cluster`)와 RDS PostgreSQL(등록부 `db_instance`)에 앱만 올린다. EKS·RDS 는 만들지 않는다.

1. 먼저 만든다: 콘솔(EKS 클러스터 생성, RDS → PostgreSQL, **초기 데이터베이스 이름 `shop`**) 또는 aws CLI(`aws rds create-db-instance --engine postgres --db-name shop --manage-master-user-password …`). 마스터 비밀번호는 "Secrets Manager 에서 관리" 가 편하다 (찍힌 줄이 그 비밀 id 를 찾는다)
2. RDS 보안 그룹이 EKS 클러스터 보안 그룹에서 5432 를 받게 한다 (안 받으면 `seed` 가 300초 뒤 실패)
3. 등록부 자기 aws 환경 줄에 `db_instance: <그 RDS 식별자>` 를 적는다. 찍힌 줄은 **이 이름으로만** RDS 를 찾는다 (`--db-instance-identifier`). 같은 AWS 계정에 플랫폼 자기 DB(`platform-db`)가 있어서 "리전의 첫 PostgreSQL" 은 고르지 않는다. `db_instance` 가 없으면 DB·`app`·`seed` 줄 대신 채우라는 주석만 찍힌다
4. `team-env.sh <slot> source` 가 찍은 줄: kubeconfig(컨텍스트 이름 = 환경 이름) → 확인 → DB 값 → `app` → `seed`

앱 계정은 RDS 마스터와 따로다 (정본 샘플과 같음). 앱이 마스터로 붙으면 복제 점검 DB-08 이 이전을 멈춘다.

- `app`: `shop-api` 는 `DB_NAME=shop`·`DB_USER=shop_app` 으로 붙는다. `shop-db-app`(키 `password`)에는 `shop_app` 의 랜덤 비밀번호만 둔다 (이미 있으면 그대로). 마스터 비밀은 읽지 않는다
- `seed`: 일회용 Job 이 마스터로 붙어 `shop_app` 역할을 만들거나 비밀번호를 `shop-db-app` 값으로 맞추고, `CONNECT`(DB)·`SELECT/INSERT/UPDATE/DELETE`(`orders`)·`USAGE/SELECT`(`orders_id_seq`)를 준 뒤 `orders` + 100행 (표·채우기 SQL 은 `gcp-source.sh` 와 같음). 마스터 사용자·비밀번호는 임시 Secret `shop-seed-db` 에만 두고 Job 뒤(실패해도) 지운다. `shop-db-app` 값이 마스터 비밀번호와 같으면 멈춘다

| 입력 | 값 |
|---|---|
| `KUBE_CONTEXT` | 필수. 현재 컨텍스트는 쓰지 않는다 |
| `DB_HOST`·`DB_INSTANCE` | RDS 엔드포인트와 식별자 (찍힌 줄이 등록부 `db_instance` 로 채운다). `DB_INSTANCE` 를 주면 `DB_HOST` 가 그 RDS 엔드포인트인지 본다 |
| `DB_NAME` | 기본 `shop`. `postgres`·`template0`·`template1`·`rdsadmin` 은 거부 |
| `DB_PASSWORD_SECRET_ID` 또는 `DB_PASSWORD_FILE` | `seed` 만. 마스터 비밀번호: Secrets Manager id(RDS 관리 비밀 JSON 이면 `username`·`password`), 또는 한 줄 파일(600). 화면·명령줄에 안 쓴다 |
| `DB_MASTER_USER` | `seed` 만. 비우면 비밀 JSON 의 `username`, 없으면 `postgres`. `shop_app` 은 거부 |

`DB_HOST`·`DB_INSTANCE` 에 `platform-db` 가 들어 있으면 아무것도 하지 않고 끝 코드 2 로 멈춘다 (등록부 `db_instance` 에 적어도 `team-env.sh` 가 거부).

```bash
bash tools/aws-source-app.sh app  --dry-run   # 명령 순서만
bash tools/aws-source-app.sh app              # 네임스페이스 → Secret(api-secrets·shop-db-app 랜덤) → shop-web·shop-api (DB_USER=shop_app)
bash tools/aws-source-app.sh seed             # 마스터로 shop_app + orders 표 + 100행 (다시 돌려도 100행), 임시 마스터 Secret 지움
bash tools/aws-source-app.sh down             # 네임스페이스만 (라벨 m-import=1 인 것만). EKS·RDS·orders·shop_app 은 그대로
```

로그는 `~/.svc-tf/aws-source/<명령>-<시각>.log`, 화면에는 단계만 나온다.

## 4. AWS (출발 또는 도착)

1. 자기 AWS 계정이 등록부에 이미 연결돼 있으면(notes 의 계정 별칭) 새로 연결하지 않고 그 환경을 쓴다
2. 콘솔 → 그 AWS 환경 → **AWS 연결** 링크 → CloudFormation 빠른 생성(스택 `svc-connect-<환경 번호 앞 8자>`)

   | 파라미터 | 넣을 값 |
   |---|---|
   | `ExternalId`·`PlatformPrincipalArn` | 링크가 채워 둔 그대로 |
   | `EksClusterName` | 자기 EKS 이름 (등록부 `cluster`) |
   | `ArgoHubRoleArn` | 링크가 채운 그대로 (비어 있으면 도착 EKS 배포가 안 됨 → 운영자에게) |
   | `CreateBoundaryPolicy` | 계정에 `platform-app-boundary` 정책이 이미 있으면 `false`, 아니면 `true` |
   | `SourceDbSecurityGroupId`·`SourceDbInstanceId` | 온프레 복제를 쓸 때만 출발 RDS 보안 그룹·식별자. 아니면 빈칸 |

   "IAM 리소스를 만들 수 있음" 체크 → 만들기 → `CREATE_COMPLETE` 뒤 콘솔에서 **확인**
3. 클러스터 RBAC 한 번 (도착으로 쓰면 필수)
   ```bash
   kubectl --context <EKS 컨텍스트> apply -f infra/permissions/eks-operate-namespace-rbac.yaml -f infra/permissions/eks-deploy-rbac.yaml
   ```
4. 출발 Secret 을 `tools/secret-copy.py` 로 읽을 사람(자기 IAM 사용자)을 접근 항목에 넣는다 (#317 9번). 앱 네임스페이스 범위 읽기만
   ```bash
   aws eks create-access-entry --cluster-name <EKS> --principal-arn <내 IAM 사용자 ARN> --region ap-northeast-2
   aws eks associate-access-policy --cluster-name <EKS> --principal-arn <내 IAM 사용자 ARN> --region ap-northeast-2 \
     --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSAdminViewPolicy \
     --access-scope type=namespace,namespaces=<앱 네임스페이스>
   aws eks update-kubeconfig --name <EKS> --region ap-northeast-2 --alias <출발 컨텍스트>
   ```

## 5. 환경 확인 (하나씩)

- GCP 환경: 콘솔 연결 화면에 원래·전용 프로젝트를 넣고 **확인**. CLI 로는 `npm run env:connect -- verify --env <환경 번호> --account <원래> --target-project <전용>`
- 그다음 **환경 화면을 하나씩 연다**. 실자원 조회가 돌아 도착 사실·인벤토리를 읽는다. 앞 화면이 다 읽힌 뒤 다음 것을 연다. 여러 명이 동시에 열면 조회가 `[z70] timeout` 으로 전부 실패한다 (#317 1번, worker 공유) → 팀 채널에 "조회 중" 을 알린다

## 6. 이전 전에 할 일

1. 팀 채널에 쓸 환경을 알린다 (공유 환경이면 필수)
2. 앱 층 apply 가 비밀 그릇을 만든 뒤, 출발 Secret 값을 도착 비밀 저장소에 넣는다 (`--dry` 먼저)
   ```bash
   python3 tools/secret-copy.py --to gcp --app <앱> --project <전용> --context <출발 컨텍스트> --namespace <출발 네임스페이스> --dry
   python3 tools/secret-copy.py --to gcp --app <앱> --project <전용> --context <출발 컨텍스트> --namespace <출발 네임스페이스>
   ```
   AWS 도착이면 `--to aws --tenant 11111111-1111-4111-8111-111111111111 --region ap-northeast-2`
3. 도착 터널·지표 토큰 (값은 명령줄에 쓰지 않는다. 한 사람이 한 번만 넣는다 — #317 15번)
   ```bash
   read -rs TOKEN && printf '{"token":"%s"}' "$TOKEN" | gcloud secrets versions add app-<앱>-cloudflared-token --project=<전용> --data-file=- && unset TOKEN
   read -rs TOKEN && printf '{"token":"%s"}' "$TOKEN" | gcloud secrets versions add app-<앱>-svc-metric-token --project=<전용> --data-file=- && unset TOKEN
   gcloud secrets versions list app-<앱>-cloudflared-token --project=<전용>   # 버전이 하나인지
   ```
   지표 토큰은 도착 환경의 `POST /api/v1/environments/<환경 번호>/metric-token` 응답(한 번만 보인다)
4. 트래픽 LB 등록 (플랫폼 DB 접근이 필요해 운영자가 친다. `cf-check` LB 는 계정에 하나라 전환 단계는 한 번에 한 이전만)
   ```bash
   npm run cf:check -- --register=<이전 번호> --tenant=11111111-1111-4111-8111-111111111111
   ```

## 7. 멈추면 (11/06 실측에서 본 것)

| 코드·증상 | 할 일 |
|---|---|
| `[z70] timeout 10000ms` (환경 화면 "읽지 못함") | 동시 조회 과부하. 다른 사람 조회가 끝난 뒤 화면을 하나씩 다시 연다 (#317 1) |
| 사전 점검 `PC-BILL` block | 두 프로젝트에 `cloudbilling.googleapis.com` 켜기 (2-3) |
| `ENV_LAYER_CRED_MISSING` | 같은 값으로 `gcp-connect.sh` 다시 실행 (`svc-env`·`platform_env` 생김) |
| `TF_APPLY_FAILED` + `setLabels`·`instanceGroupManagers.get`·`versions.enable`·`projects.get`·`operations.get` 403 | 2-3 의 `roles update` 세 줄 (#316). 다시 시도 때만 나는 `projects.get` 도 같다 (#317 13) |
| `TF_APPLY_FAILED` + `iam.serviceAccounts.setIamPolicy` 403 | 2-4 앱 SA 바인딩 뒤 다시 시도 (#317 14) |
| `IMAGE_COPY_FAILED` | `platform_operate` 에 `artifactregistry.repositories.downloadArtifacts,artifactregistry.repositories.uploadArtifacts` 더하기 (`tools/team-env.sh` 3번 묶음) |
| `409 RETRY_BUDGET_EXHAUSTED` | 재시도 3번 소진. 원인을 고친 뒤 `acceptCustomerCost:true` 로 다시 시도 (#317 12) |
| `PLAN_EXPIRED` | 승인 2시간 지남. 다시 계획·승인 (#317 10) |
| `Error 409 … already exists` (입구 비밀) | 손으로 만든 그릇. `infra/README.md` 입구 비밀 절의 import 또는 지우고 다시 apply |
| `ARGO_NOT_CONFIGURED` | 플랫폼 차트 문제(#322). 운영자에게 알린다 |
| `there are no clusters with this name` (ApplicationSet) | 울타리 앱 → ApplicationSet 순서로 수동 새로고침 (#317 20). 운영자에게 |
| `replicationcontrollers is forbidden` (Argo ComparisonError) | 2-5 `argo-cache-read` Role (#317 21, #323) |
| `secret-copy.py` 가 출발 Secret 을 못 읽음 | 4-4 접근 항목·`AmazonEKSAdminViewPolicy` (#317 9) |
| `PERM_TABLE_MISSING` (GCP VM 도착) | 아직 지원 안 함. k8s 도착으로 (#317 18) |
| 캐시 있는 앱의 `-cache-auth` 비밀 403 | 아직 안 고침. 캐시 없는 앱으로 시험 (#317 17) |
| AI 원인 분석이 비어 있음 (`llm_key_missing`) | 플랫폼 설정 문제. 진행에는 영향 없음 (#317 5) |
