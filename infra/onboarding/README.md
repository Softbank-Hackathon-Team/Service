# 고객 AWS 연결 템플릿

상태: AI 초안

`aws-connect.json`은 고객 계정에 **관찰 역할(`svc-observe`)** 과 **실행 역할(`svc-operate`)** 을 만드는 CloudFormation 템플릿이다. 비밀 키는 주고받지 않는다. 고객이 역할을 만들어 주면 플랫폼이 임시 권한으로 빌려 쓴다.
새로 연결하는 환경은 역할·실행 정책 이름 끝에 환경 꼬리가 붙는다 (`svc-observe-<환경 앞 8자>` 등, 아래 "한 계정에 여럿"). 이 문서의 `svc-observe`·`svc-operate`·`svc-deploy`·`svc-operate-policy` 는 그 꼬리를 뺀 이름이다.

> 자동 생성 파일이다. 직접 고치지 않는다. 고치려면 `packages/adapters/scripts/aws-connect-template.ts`를 바꾸고
> `npx tsx packages/adapters/scripts/export-permissions.ts infra/permissions`를 다시 돌린다. (실행 정책과 어긋나지 않게 같은 생성기가 만든다)

## 무엇을 만드나
| 자원 | 내용 |
|---|---|
| `svc-observe` | AWS 관리형 `ViewOnlyAccess` 하나 + 인라인 `observe-extra`(GuardDuty 읽기 5, EKS 읽기 3, IAM 근거 읽기 6, 데이터 자원 메타데이터 읽기 12: S3 7·CloudWatch 1·SQS 2·ElastiCache 2, 그 밖에 플랫폼이 부르는 읽기 명령 전부의 권한: RDS·EC2·ELB·ECR·Secrets Manager 목록(이름만)·Service Quotas 등 총 38개). 쓰기 0, 객체·메시지·비밀값 읽기 0 |
| `svc-operate` | 이전에 필요한 서비스만 허용하는 관리형 정책(`svc-operate-policy`). 앱 역할(`app-*`)은 권한 경계가 붙어야만 만들 수 있음 |
| `platform-app-boundary` | 앱 역할이 가질 수 있는 최대 권한. 실행 정책이 요구한다. `svc-operate` 자신에게는 붙이지 않는다 |
| EKS 접근 항목 2개 | 관찰 = `AmazonEKSViewPolicy`(클러스터 범위), 실행 = 그룹 `platform:operate`만 |
| (선택) `svc-deploy` + 접근 항목 | ID-1: `ArgoHubRoleArn`을 줄 때만. Argo CD 허브가 빌리는 배포 역할(IAM 권한 0) → 그룹 `platform:deploy`. 권한은 앱 네임스페이스 RoleBinding으로만(`infra/permissions/eks-deploy-rbac.yaml`, 클러스터 범위 없음). 신뢰 = 허브 역할에게 `sts:AssumeRole` + `sts:TagSession`(Pod Identity 세션 태그【추정】). ExternalId 없음(Argo가 못 넘김【추정】) TODO(human) |
| 신뢰 정책(두 역할 공통) | 주체 = 플랫폼 워커 역할 하나, 동작 = `sts:AssumeRole`·`sts:TagSession`·`sts:SetSourceIdentity`, 조건 = `sts:ExternalId` 일치 |

신뢰 정책에 `TagSession`·`SetSourceIdentity`가 있어야 한다. 플랫폼 발급기가 역할을 빌릴 때 항상 태그와 SourceIdentity를 넣기 때문에, 빠지면 AssumeRole이 전부 AccessDenied가 된다.

## 파라미터
| 이름 | 설명 |
|---|---|
| `ExternalId` | 플랫폼이 연결 화면에서 알려 준 값을 그대로 (32자 이상). NoEcho가 아니라 빠른 생성 링크로 넘길 수 있다 |
| `PlatformPrincipalArn` | 플랫폼 워커 **역할 또는 사용자** ARN (데모 계정은 사용자 키). `:root`·assumed-role 은 패턴이 거부한다. API 설정 검사와 같은 규칙 (DRAFT(ai)) |
| `EksClusterName` | 이전 대상 EKS 클러스터 이름 |
| `ArgoHubRoleArn` | 선택. 플랫폼 Argo CD 허브 역할 ARN = `infra/modules/aws/platform` 출력 `argocd_hub_role_arn` (차트 `argocd.hubRoleArn` → API 설정 `ARGO_HUB_ROLE_ARN`, 있으면 링크가 채움). 비우면 배포 역할 없음 |
| `CreateBoundaryPolicy` | 기본 `true`. 같은 계정에 `infra/modules/aws/env`가 이미 `platform-app-boundary`를 만들었으면 `false`. F17: 연결 링크가 알아서 `false`를 넣는 경우 = 링크 요청에 `?boundaryPolicyExists=true`(CLI `env:connect`가 `aws iam get-policy`로 확인해 붙임) 또는 고객 계정 번호 = 플랫폼 주체 계정 |
| `RoleSuffix` | 기본 `""` (= 예전 고정 이름). 연결 링크가 채운다: `-<환경 번호 앞 8자>` (= 스택 이름 `svc-connect-<같은 8자>` 의 꼬리). 역할 셋·실행 정책 이름 끝에 붙는다. 모양 `^$\|^-[0-9a-f]{8}$` |

## 올리는 곳 (S3)
- TODO(human): 템플릿을 둘 S3 버킷·키 (25번 계획 H-L2). 빠른 생성 링크는 `templateURL`로 이 위치를 가리킨다
- 이 레포의 세션에서는 올리지 않는다(실자원). 위치가 정해지면 사람이 올린다

## 고객이 누르는 순서
1. 연결 화면의 "AWS 연결" 링크를 연다 (CloudFormation 빠른 생성: 템플릿·`ExternalId`·`PlatformPrincipalArn`이 미리 채워짐)
2. `EksClusterName`을 입력하고, 같은 계정에 `platform-app-boundary` 정책이 이미 있으면 `CreateBoundaryPolicy`를 `false`로 바꾼다
3. "IAM 리소스를 만들 수 있음" 확인란에 체크하고 스택을 만든다 (`CAPABILITY_NAMED_IAM`: 역할 이름을 정해 만들어서 필요)
4. 스택이 `CREATE_COMPLETE`가 되면 연결 화면에서 "확인"을 누른다 (플랫폼이 관찰 역할을 빌려 읽기를 확인)
5. 실행 역할이 클러스터에서 일하려면 RBAC를 한 번 적용한다: `kubectl apply -f infra/permissions/eks-operate-namespace-rbac.yaml` (네임스페이스 관리 + 배포 RoleBinding 만들기, bind는 `platform-deploy-app` 하나만). 배포 역할을 쓰면 `eks-deploy-rbac.yaml`도 같이
   - 그 뒤로는 사람이 할 일이 없다 (플랫폼이 허브를 켰을 때, `ARGO_HUB_ROLE_ARN`): 이전마다 네임스페이스 모듈이 앱 구역에 `platform:deploy` RoleBinding 을 만들고(`infra/modules/aws/kinds/namespace`), 워커가 배포 커밋에 Argo CD cluster Secret(`tenants/<회사>/argocd/cluster-aws-eks.yaml`, namespaces 한정, `awsAuthConfig.roleARN` = 이 계정의 `svc-deploy`)을 같이 쓴다
   - 클러스터 범위 RBAC(위 두 파일)는 플랫폼 역할이 만들 수 없다 (실행 그룹에 ClusterRole 쓰기 권한이 없다). 그래서 한 번은 고객이 적용한다

### 이미 연결한 고객: 배포 역할 더하기 (허브를 켠 뒤 한 번)
플랫폼이 허브 역할을 켜기 전에 연결한 스택에는 `svc-deploy` 가 없다. 그대로 두면 EKS 도착 배포가 Argo CD 로그인 실패로 멈춘다 (`ARGO_*` 실패, 사유에 AccessDenied).
1. CloudFormation 콘솔 → 연결 스택(`svc-connect-<환경 앞 8자>`) → 업데이트 → "현재 템플릿 교체" → 새 템플릿 주소(연결 화면 링크의 `templateURL`)
2. 파라미터 `ArgoHubRoleArn` = 플랫폼이 알려 준 허브 역할 ARN (연결 화면에서 링크를 새로 받으면 채워져 있다). 나머지 값은 그대로
3. "IAM 리소스를 만들 수 있음" 체크 → 업데이트. `UPDATE_COMPLETE` 뒤 출력에 `DeployRoleArn` 이 보이면 된다
4. 도착 EKS 에 한 번: `kubectl apply -f infra/permissions/eks-operate-namespace-rbac.yaml -f infra/permissions/eks-deploy-rbac.yaml` (이미 적용했으면 그대로 다시 적용해도 바뀌지 않는다)
5. 같은 업데이트로 관찰 역할에 `ec2:DescribeSubnets` 가 더해진다 (도착 EKS 의 서브넷 읽기, `TF_FACT_*` 없이 도착 사실을 얻는 데 필요). 업데이트 뒤 도착 환경 화면을 한 번 열면 플랫폼이 다시 읽는다

CLI 로 하려면 (값은 화면에서 복사). 예전 스택에 `SourceDbSecurityGroupId`·`SourceDbInstanceId` 가 있으면 그 둘도 `UsePreviousValue=true` 로 더한다 (없던 스택에 붙이면 거부된다).
`RoleSuffix` 를 가진 스택(꼬리 붙은 새 연결)이면 `ParameterKey=RoleSuffix,UsePreviousValue=true` 도 더한다. 꼬리 없는 옛 스택은 빼면 기본값 `""` 이라 역할 이름이 안 바뀐다 (역할 교체 없음):
```bash
aws cloudformation update-stack --stack-name svc-connect-<환경 앞 8자> --template-url <templateURL> --capabilities CAPABILITY_NAMED_IAM \
  --parameters ParameterKey=ExternalId,UsePreviousValue=true ParameterKey=PlatformPrincipalArn,UsePreviousValue=true \
    ParameterKey=EksClusterName,UsePreviousValue=true ParameterKey=CreateBoundaryPolicy,UsePreviousValue=true \
    ParameterKey=ArgoHubRoleArn,ParameterValue=<허브 역할 ARN>
aws cloudformation wait stack-update-complete --stack-name svc-connect-<환경 앞 8자>
```

## IAM 확인 체크 (고객이 눈으로 확인)
- [ ] 역할 `svc-observe`의 신뢰 주체가 **역할 또는 사용자 ARN 하나**(우리가 알려 준 값)이고 `:root`가 아니다
- [ ] 두 역할의 신뢰 정책에 `sts:ExternalId` 조건이 있다
- [ ] `svc-observe`에 붙은 관리형 정책이 `ViewOnlyAccess` 하나뿐이다 (`ReadOnlyAccess`는 S3·DynamoDB 데이터까지 읽어서 쓰지 않는다)
- [ ] `svc-observe`가 비밀값(`secretsmanager:GetSecretValue`, `ssm:GetParameter*`)·객체(`s3:GetObject`)·큐 메시지(`sqs:ReceiveMessage`)·버킷 정책 본문(`s3:GetBucketPolicy`)·`kms:Decrypt`를 읽지 못한다
- [ ] `svc-operate`에는 `app-*` 역할 외의 IAM 쓰기가 없다
- 참고: `ViewOnlyAccess`의 `Describe*`/`List*`는 설정값(예: ConfigMap 값)을 읽을 수 있다. 플랫폼은 읽되 저장하지 않는다

## 한 계정에 여럿 (역할 이름 꼬리)
예전에는 역할 이름이 고정(`svc-observe`·`svc-operate`)이라 한 AWS 계정에 연결이 하나뿐이었다 (두 번째 스택이 역할 이름 충돌로 되돌아감, 25번 H-L14). 이제 환경마다 이름이 다르다.
- **새 연결**: 연결 링크가 처음(확인 문구를 새로 만들 때) 환경 꼬리 `-<환경 번호 앞 8자>` 를 정해 플랫폼 DB(`environments.aws_role_suffix`, 마이그레이션 0056)에 적고 `param_RoleSuffix` 로 넘긴다. 역할 = `svc-observe-<8자>`·`svc-operate-<8자>`(·`svc-deploy-<8자>`), 실행 정책 = `svc-operate-policy-<8자>`. 같은 계정에 연결 스택을 몇 개 둬도 안 부딪힌다
- **이미 연결한 환경**: 꼬리 없음(NULL) 그대로. 고객이 할 일 없음. 새 템플릿으로 스택을 업데이트해도 `RoleSuffix` 기본값 `""` 이라 이름이 안 바뀐다. 이 배포 전에 링크를 받아 둔 환경(고객 대기·실패·만료)도 같은 링크를 다시 받으면 꼬리 없이 그대로다 (이미 옛 이름 스택을 만들었을 수 있어서). 꼬리를 붙이려면 연결을 해제한 뒤 다시 연결한다 (새 확인 문구·새 스택)
- 플랫폼이 고객 역할 ARN 을 만드는 곳은 모두 환경 꼬리를 쓴다: 워커 역할 빌리기(`apps/worker/src/platform.ts` `roleRefFor`), 연결 확인의 실행 역할 확인(`packages/adapters/src/verify/aws.ts`), 권한 확인 흉내 평가(`packages/adapters/src/permissions/check.ts`), Argo CD 배포 역할(`apps/worker/src/gitops/bundle.ts` `clusterAccess`)
- 플랫폼 쪽 빌리기 권한: 워커 역할은 `svc-observe`·`svc-operate` 와 `svc-observe-*`·`svc-operate-*`, 허브 역할은 `svc-deploy`·`svc-deploy-*` 를 빌릴 수 있다 (`infra/modules/aws/platform` `pod-identity.tf`·`argocd-hub.tf`)
- **같이 쓰는 것 — 권한 경계 `platform-app-boundary`**: 이름에 꼬리를 붙이지 않는다. 실행 정책 조건(`iam:PermissionsBoundary`)과 앱 층 Terraform 이 이 이름 하나를 가리키고 내용도 같다. 계정의 첫 연결 스택이 만들고(`CreateBoundaryPolicy=true`), 두 번째부터는 `false` 로 만든다 (CLI `env:connect` 는 `aws iam get-policy` 로 확인해 `?boundaryPolicyExists=true` 를 붙이고, 화면은 고객에게 묻는다). 경계를 만든 스택을 먼저 지우면 남은 스택의 앱 역할 만들기가 막힌다 → 그 스택을 마지막에 지우거나, 남은 스택을 `CreateBoundaryPolicy=true` 로 업데이트한다
- 같이 써도 되는 것: EKS 접근 항목은 (클러스터, 역할 ARN) 마다라 역할 이름이 다르면 같은 클러스터에 둘이어도 된다. 관찰 인라인 `observe-permcheck` 는 이 계정의 `svc-*` 역할을 흉내 평가할 수 있다 (같은 고객 계정 안, 판정만 돌려받는 읽기). 그 밖의 인라인 정책은 역할마다 따로다
- 다른 환경 것과 섞이지 않는 것: 실행 역할 `svc-operate-<8자>` 가 만드는 앱 자원 이름(`app-*`, `platform/*` 저장소)은 이전마다 이름이 다르다. 같은 계정의 두 실행 역할은 서로의 `app-*` 를 바꿀 수 있는 같은 권한을 가진다 (계정 단위 정책이라 예전과 같음)
- 아직 남은 것 (TODO(human)): Argo CD cluster Secret 은 회사마다 클라우드 종류 하나(`tenants/<회사>/argocd/cluster-aws-eks.yaml`)라, 한 회사가 **서로 다른 EKS 두 곳을 도착**으로 쓰면 뒤 것이 앞 것을 덮는다. 출발 환경이나 같은 클러스터면 상관없다

GCP→AWS 이전의 도착은 이미 연결한 AWS 환경 줄을 그대로 써도 되고(앞 이전의 출발이었어도 된다. 한 환경에 진행 중인 이전은 하나라는 잠금은 그대로), 같은 계정에 환경을 하나 더 연결해 따로 잠가도 된다. DB 중계기는 그 환경 `svc-operate<꼬리>` 의 인라인 `relay` 정책(`TargetDbRulesForRelay` 포함)으로 만들고 지운다.

## 확인 방법
- 이 레포 시험: `npm test` (`packages/adapters/test/onboarding-template.test.ts`가 모양·권한 범위를 고정, 클라우드 호출 없음)
- 문법 확인(자원 안 만듦, 사람 환경에서): `aws cloudformation validate-template --template-body file://infra/onboarding/aws-connect.json`
- STUB: `AmazonEKSViewPolicy` 이름과 `AWS::EKS::AccessEntry` 속성은 일반 지식 기준. 위 validate와 첫 실측으로 확인
- DRAFT(ai): 리허설 이미지 복사용 ECR 받기 세 동작(`ecr:GetAuthorizationToken`, `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer`)을 관찰 인라인에 넣었다. `ViewOnlyAccess`에 이미 있는지는 미확인. 이미 연결한 고객은 템플릿을 다시 적용해야 복사가 된다

# GCP 연결 (`gcp-connect.sh`)

키 파일은 만들지 않는다. 고객이 Cloud Shell에서 스크립트를 한 번 실행하면 아래가 생긴다.
결정 3번 A안: 도착 자원은 **이전 전용 프로젝트**(`TARGET_PROJECT_ID`)에만 만든다. 원래 프로젝트(`PROJECT_ID`)에는 읽기만 남는다.

| 만드는 것 | 어디 | 내용 |
|---|---|---|
| `svc-observe` SA | 원래 프로젝트 | 관찰(읽기만). 원래·전용 두 프로젝트에 `platform_observe`·`platform_observe_verify` 역할 |
| `svc-plan`·`svc-operate` SA | 전용 프로젝트 | 계획(읽기)·실행. 권한은 전용 프로젝트 안에서만 |
| `svc-env` SA (B-2) | 전용 프로젝트 | 환경 층(`infra/modules/gcp/env`: VPC·NAT·GKE·Artifact Registry·클러스터 안 ESO 설치) 만들기만. 플랫폼은 환경 층 단계에서만 빌린다. 지우기·IAM 정책 바꾸기 권한 없음 |
| `svc-gke-node` SA (B-2) | 전용 프로젝트 | GKE 노드 SA (기본 Compute SA 대신). `roles/logging.logWriter`·`roles/monitoring.metricWriter`·`roles/artifactregistry.reader` 만. 플랫폼은 빌리지 않는다 |
| 커스텀 역할 | 원래: `platform_observe`·`platform_observe_verify` / 전용: 그 둘 + `platform_observe_permcheck`(관찰 SA 가 플랫폼 역할 정의만 읽는 `iam.roles.get`, PERM-GATE) + `platform_plan`·`platform_operate`·`platform_operate_iam`·`platform_operate_db_secret`·`platform_env`(B-2)·`platform_hub_access`(회사 SA 에 `container.clusters.get` 만. Argo CD 허브의 GKE 접속용) | 권한 목록은 `infra/permissions`의 자동 생성 파일. `platform_observe`는 객체 내용·메시지·비밀값 권한 없음 |
| 조건부 바인딩 | 전용 프로젝트 | 실행 SA의 IAM 정책 변경(`_iam`)·DB 비밀(`_db_secret`)은 `app-` 접두어 SA·시크릿에만 닿는 조건 (DRAFT(ai)) |
| 노드 SA 붙이기 (B-2) | SA 단위 | `svc-gke-node` 자신의 정책에만 `svc-env` → `roles/iam.serviceAccountUser`(actAs). 프로젝트 전체 actAs 없음 (`permissions-lint` 가 DRY_RUN 출력으로 확인) |
| 빌리기 허용 | SA 단위 | 플랫폼의 **이 회사 전용 SA**(`t-<16진 28자>@...`) 하나에게, 네 고객 SA(`svc-observe`·`svc-plan`·`svc-operate`·`svc-env`) 각각에 `roles/iam.serviceAccountTokenCreator` (프로젝트 전체가 아님) |

이미 연결한 고객의 환경 층(B-2): 스크립트를 같은 값으로 **다시 실행**하면 `svc-env`·`svc-gke-node`·`platform_env` 와 위 바인딩만 새로 생긴다 (있는 것은 건너뜀). 다시 실행하지 않으면 환경 층 만들기가 `ENV_LAYER_CRED_MISSING` 으로 멈춘다.
`platform_env` 는 이미 있으면 바꾸지 않는다 (실행 역할과 같은 규칙). 첫 실측에서 권한이 모자라면 `gcloud iam roles update platform_env --project=<전용> --file=infra/permissions/gcp-env-custom-role.yaml` 로 고객이 직접 바꾼다.
ESO 신원은 이 스크립트가 만들지 않는다 (`svc-eso` 없음, B-2 (나)). ESO 는 클러스터 안 자기 KSA `external-secrets/external-secrets` 를 IAM 주체로 쓰고, 앱 층이 비밀마다 읽기를 준다 (`infra/README.md` "ESO 읽기 권한 (GCP)"). 그래서 첫 GKE 클러스터 전에 없는 GKE 풀에 미리 묶을 일이 없다.

이미 연결한 고객의 Argo CD 허브 권한: `gcp-connect.sh` 를 다시 돌리면 `platform_hub_access` 는 생기지만, 실행 역할은 권한이 늘면 할 수 있는 일이 늘어서 자동으로 바꾸지 않는다. 고객이 아래 명령으로 직접 더한다.

```bash
gcloud iam roles update platform_operate --project=<전용> --add-permissions=container.roleBindings.create,container.roleBindings.delete,container.roleBindings.get,container.roleBindings.update,container.roles.bind,container.roles.create,container.roles.delete,container.roles.escalate,container.roles.get,container.roles.update
```

이미 연결한 고객의 배포 이미지 복사 권한: 배포가 사설 이미지를 전용 프로젝트 Artifact Registry(`platform`, 환경 층이 만듦)에 다이제스트 그대로 올린다(worker `jobs/image-copy.ts`). 같은 이유로 실행 역할에 직접 더한다. 없으면 배포가 `IMAGE_COPY_FAILED` 로 멈춘다.

```bash
gcloud iam roles update platform_operate --project=<전용> --add-permissions=artifactregistry.repositories.downloadArtifacts,artifactregistry.repositories.uploadArtifacts
```

순서: 연결 화면에서 `PLATFORM_SA` 복사 → Cloud Shell에서 `PLATFORM_SA=... PROJECT_ID=<원래> TARGET_PROJECT_ID=<전용> ROLE_DIR=./permissions bash gcp-connect.sh`
(전용 프로젝트가 아직 없으면 `CREATE_TARGET_PROJECT=1`, 결제 계정을 따로 쓰려면 `BILLING_ACCOUNT=...`) → 출력된 두 프로젝트를 화면에 입력 → "확인".
전용 프로젝트에는 연결 확인·빌리기·첫 up 이 부르는 API 9개(cloudresourcemanager·serviceusage·iam·iamcredentials·sts·container·sqladmin·compute·secretmanager)를, 원래 프로젝트에는 iamcredentials·cloudresourcemanager 를 켠다(켜져 있으면 건너뜀).
`DRY_RUN=1`이면 명령만 출력한다. `PLATFORM_SA` 이름 규칙이 맞지 않거나 `TARGET_PROJECT_ID`가 없거나 원래 프로젝트와 같으면 아무것도 만들기 전에 멈춘다.

### 권한 갱신: 빠진 묶음만 맞추기 (PERM-GATE, `ONLY_BUNDLES`)
플랫폼은 단계 전에(사전 점검, 환경 화면 [다시 확인]) 고객 쪽 실제 상태를 관찰 역할로 읽어 **권한 묶음**(`infra/permissions/permission-bundles.json`, 권한표에서 자동 생성)과 견준다.
빠진 묶음이 있으면 화면이 고치는 링크를 준다.
- GCP: 연결과 같은 Cloud Shell 링크 + 명령에 `ONLY_BUNDLES=<묶음 id,…>`. 스크립트는 그 묶음의 역할에 **빠진 권한만 더하고**(있는 권한·고객이 따로 넣은 권한은 그대로), 그 역할 바인딩·그 묶음 API·빌리기 허용만 맞춘 뒤 끝난다. 실행 역할(`platform_operate`·`platform_env` …)도 이 모드에서만 더한다 (고객이 그 묶음을 골라 실행했으므로). 다시 돌리면 바꾸는 명령 0번
- 묶음 표: `infra/permissions/gcp-bundles.tsv` (첫 줄 `#version<TAB>N` = 권한 판). 새로 만드는 역할 설명 끝과 묶음 모드가 맞춘 역할 설명 끝에 `[perms vN]` 이 붙어 관찰 SA 가 고객 쪽 판을 읽는다
- AWS: 같은 연결 스택을 새 템플릿 판으로 업데이트한다 (콘솔 링크 또는 `aws cloudformation update-stack … UsePreviousValue=true`, 매개변수는 스택에 있는 값 그대로). 템플릿의 두 역할에 `platform-perms-version` 태그
- 확인에 쓰는 관찰 권한: GCP `platform_observe_permcheck`(`iam.roles.get`, 전용 프로젝트만), AWS 인라인 `observe-permcheck`(`iam:SimulatePrincipalPolicy`, 이 계정 `svc-*` 역할만). 없으면 막지 않고 "확인 못 함"으로 알린다

### 이미 연결한 고객: 관찰 역할 권한 갱신
플랫폼이 읽는 자원이 늘면 관찰 역할(`platform_observe`)에 읽기 권한이 더 필요하다. 예전 스크립트로 만든 고객의 역할에는 새 권한이 없다.
- 갱신 방법: 고객이 **같은 스크립트를 같은 값으로 다시 실행**한다. 스크립트가 `platform_observe` 의 권한 목록을 읽어 **빠진 권한만 더한다**(`gcloud iam roles update ... --add-permissions`). 있는 권한은 지우지 않고, 고객이 따로 넣은 권한도 그대로 둔다. 최신이면 `= 역할 platform_observe 권한 최신` 만 나오고 바꾸는 명령은 0번이다
- 리허설 이미지 복사가 출발 Artifact Registry(gcr.io 포함)에서 받으려면 `platform_observe` 에 `artifactregistry.repositories.downloadArtifacts` 가 있어야 한다. 이 줄이 없을 때 연결한 고객은 다시 실행해야 GCP 출발 리허설이 이미지를 받는다 (없으면 `copy_failed` 로 멈춤)
- 실행 역할(`platform_operate`, `platform_operate_iam`)은 자동으로 바꾸지 않는다. 권한이 늘면 할 수 있는 일이 늘기 때문에 사람이 파일을 보고 정한다 (TODO(human))
- 알림: 사용자가 누르는 "확인"에서 플랫폼이 선택 읽기 권한 11곳을 한 건씩 찔러 본다. 빠진 게 있어도 연결은 `connected` 로 두고, `verify_detail.missingPermissions`(권한 이름)와 `verify_detail.needsHuman`(고객이 할 일 한 줄)과 감사 기록 `env.verified` 에 남긴다. 주기 재확인은 찌르지 않는다. API가 꺼진 프로젝트·조직 정책은 권한 문제로 세지 않는다
- STUB: `verify_detail` 을 화면·API 응답에 보이는 일은 아직 없음 (입력층 묶음 몫). 권한 목록을 못 읽는 고객(`iam.roles.get` 없음)은 경고만 하고 바꾸지 않는다
- AWS는 CloudFormation 스택을 새 템플릿으로 **업데이트**한다 (역할 이름이 같아 인라인 정책만 바뀐다). 알림 경로는 아직 GCP만 있음

- DRAFT(ai): 관찰 역할 권한 목록, 역할 ID 이름(`platform_observe` 등). 첫 실측 거부 로그로 보정
- TODO(human): 고객 프로젝트에서 `ROLE_DIR` 파일을 어떻게 전달할지(S3처럼 공개 위치 vs 스크립트에 내장)
- STUB: 이 스크립트는 레포 세션에서 실행하지 않음. 발급기(gcloud impersonate)는 별도 묶음

## 연결 끊기 (고객이 할 일)
플랫폼 화면에서 연결을 끊으면(`DELETE /environments/:id`) 플랫폼 쪽은 환경을 `disconnected`로 바꾸고 빌린 임시 자격을 회수한다.
**고객 클라우드에 만든 역할·신뢰는 플랫폼이 지우지 않는다**(플랫폼에는 그 권한이 없다). 빌리기 길까지 완전히 닫으려면 고객이 아래를 한다.

GCP (Cloud Shell, 원래·전용 프로젝트 각각). `<플랫폼 SA>`는 연결 때 쓴 `PLATFORM_SA` 값
1. 빌리기 허용 걷기 (이것만 해도 플랫폼은 더 못 빌린다)
   - `gcloud iam service-accounts remove-iam-policy-binding svc-observe@<원래>.iam.gserviceaccount.com --project <원래> --member=serviceAccount:<플랫폼 SA> --role=roles/iam.serviceAccountTokenCreator`
   - 같은 명령을 `svc-plan@<전용>…`·`svc-operate@<전용>…`·`svc-env@<전용>…` 에 `--project <전용>` 으로
2. SA 지우기: `gcloud iam service-accounts delete svc-observe@<원래>.iam.gserviceaccount.com --project <원래> --quiet`, `svc-plan`·`svc-operate`·`svc-env`·`svc-gke-node` 는 `--project <전용>` (환경 층 GKE 를 먼저 지운다. 노드가 `svc-gke-node` 로 돈다)
3. 커스텀 역할 지우기: 원래 `platform_observe`·`platform_observe_verify`, 전용 그 둘 + `platform_observe_permcheck`·`platform_plan`·`platform_operate`·`platform_operate_iam`·`platform_operate_db_secret`·`platform_env`·`platform_hub_access`
   - `gcloud iam roles delete <역할> --project <프로젝트> --quiet` (지운 역할은 7일 안에 되살릴 수 있고 그동안 같은 이름으로 못 만든다)
   - SA 를 지우면 프로젝트 바인딩은 `deleted:` 로 남는다. 깨끗이 하려면 `gcloud projects remove-iam-policy-binding <프로젝트> --member=deleted:serviceAccount:… --role=projects/<프로젝트>/roles/<역할> --all`
4. 전용 프로젝트를 이전 전용으로만 썼다면 프로젝트째 끄기: `gcloud projects delete <전용>` (30일 안에 되살릴 수 있음)

AWS: 연결 스택을 지운다 — `aws cloudformation delete-stack --stack-name <연결 스택 이름>` 뒤 `aws cloudformation wait stack-delete-complete --stack-name <같은 이름>`.
`svc-observe`·`svc-operate`(·`svc-deploy`)·`svc-operate-policy`(새 연결은 모두 `-<8자>` 꼬리)와 신뢰 정책, EKS 접근 항목이 같이 지워진다. `platform-app-boundary` 를 스택이 만들었으면(`CreateBoundaryPolicy=true`) 그것도 — 같은 계정에 다른 연결 스택이 남아 있으면 이 스택을 마지막에 지운다 (위 "한 계정에 여럿").
EKS 에 손으로 적용한 RBAC(`eks-operate-namespace-rbac.yaml`·`eks-deploy-rbac.yaml`)는 `kubectl delete -f` 로 따로 지운다.

- DRAFT(ai): 끊기 버튼이 위 명령을 고객 화면에 보여 주는 일은 아직 없음(입력층 화면 몫). 지금은 이 문서만
