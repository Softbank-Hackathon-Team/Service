# 고객 AWS 연결 템플릿

상태: AI 초안

`aws-connect.json`은 고객 계정에 **관찰 역할(`svc-observe`)** 과 **실행 역할(`svc-operate`)** 을 만드는 CloudFormation 템플릿이다. 비밀 키는 주고받지 않는다. 고객이 역할을 만들어 주면 플랫폼이 임시 권한으로 빌려 쓴다.

> 자동 생성 파일이다. 직접 고치지 않는다. 고치려면 `packages/adapters/scripts/aws-connect-template.ts`를 바꾸고
> `npx tsx packages/adapters/scripts/export-permissions.ts infra/permissions`를 다시 돌린다. (실행 정책과 어긋나지 않게 같은 생성기가 만든다)

## 무엇을 만드나
| 자원 | 내용 |
|---|---|
| `svc-observe` | AWS 관리형 `ViewOnlyAccess` 하나 + 인라인 `observe-extra`(GuardDuty 읽기 5, EKS 읽기 3, IAM 근거 읽기 6, 데이터 자원 메타데이터 읽기 12: S3 7·CloudWatch 1·SQS 2·ElastiCache 2, 그 밖에 플랫폼이 부르는 읽기 명령 전부의 권한: RDS·EC2·ELB·ECR·Secrets Manager 목록(이름만)·Service Quotas 등 총 38개). 쓰기 0, 객체·메시지·비밀값 읽기 0 |
| `svc-operate` | 이전에 필요한 서비스만 허용하는 관리형 정책(`svc-operate-policy`). 앱 역할(`app-*`)은 권한 경계가 붙어야만 만들 수 있음 |
| `platform-app-boundary` | 앱 역할이 가질 수 있는 최대 권한. 실행 정책이 요구한다. `svc-operate` 자신에게는 붙이지 않는다 |
| EKS 접근 항목 2개 | 관찰 = `AmazonEKSViewPolicy`(클러스터 범위), 실행 = 그룹 `platform:operate`만 |
| 신뢰 정책(두 역할 공통) | 주체 = 플랫폼 워커 역할 하나, 동작 = `sts:AssumeRole`·`sts:TagSession`·`sts:SetSourceIdentity`, 조건 = `sts:ExternalId` 일치 |

신뢰 정책에 `TagSession`·`SetSourceIdentity`가 있어야 한다. 플랫폼 발급기가 역할을 빌릴 때 항상 태그와 SourceIdentity를 넣기 때문에, 빠지면 AssumeRole이 전부 AccessDenied가 된다.

## 파라미터
| 이름 | 설명 |
|---|---|
| `ExternalId` | 플랫폼이 연결 화면에서 알려 준 값을 그대로 (32자 이상). NoEcho가 아니라 빠른 생성 링크로 넘길 수 있다 |
| `PlatformPrincipalArn` | 플랫폼 워커 **역할** ARN. 사용자·`:root`는 패턴이 거부한다 |
| `EksClusterName` | 이전 대상 EKS 클러스터 이름 |
| `CreateBoundaryPolicy` | 기본 `true`. 같은 계정에 `infra/modules/aws/env`가 이미 `platform-app-boundary`를 만들었으면 `false` |

## 올리는 곳 (S3)
- TODO(human): 템플릿을 둘 S3 버킷·키 (25번 계획 H-L2). 빠른 생성 링크는 `templateURL`로 이 위치를 가리킨다
- 이 레포의 세션에서는 올리지 않는다(실자원). 위치가 정해지면 사람이 올린다

## 고객이 누르는 순서
1. 연결 화면의 "AWS 연결" 링크를 연다 (CloudFormation 빠른 생성: 템플릿·`ExternalId`·`PlatformPrincipalArn`이 미리 채워짐)
2. `EksClusterName`을 입력하고, 같은 계정에 `platform-app-boundary` 정책이 이미 있으면 `CreateBoundaryPolicy`를 `false`로 바꾼다
3. "IAM 리소스를 만들 수 있음" 확인란에 체크하고 스택을 만든다 (`CAPABILITY_NAMED_IAM`: 역할 이름이 고정이라 필요)
4. 스택이 `CREATE_COMPLETE`가 되면 연결 화면에서 "확인"을 누른다 (플랫폼이 관찰 역할을 빌려 읽기를 확인)
5. 실행 역할이 클러스터에서 일하려면 RBAC를 한 번 적용한다: `kubectl apply -f infra/permissions/eks-operate-namespace-rbac.yaml` (네임스페이스 관리만)

## IAM 확인 체크 (고객이 눈으로 확인)
- [ ] 역할 `svc-observe`의 신뢰 주체가 **역할 ARN 하나**(우리가 알려 준 값)이고 `:root`·사용자가 아니다
- [ ] 두 역할의 신뢰 정책에 `sts:ExternalId` 조건이 있다
- [ ] `svc-observe`에 붙은 관리형 정책이 `ViewOnlyAccess` 하나뿐이다 (`ReadOnlyAccess`는 S3·DynamoDB 데이터까지 읽어서 쓰지 않는다)
- [ ] `svc-observe`가 비밀값(`secretsmanager:GetSecretValue`, `ssm:GetParameter*`)·객체(`s3:GetObject`)·큐 메시지(`sqs:ReceiveMessage`)·버킷 정책 본문(`s3:GetBucketPolicy`)·`kms:Decrypt`를 읽지 못한다
- [ ] `svc-operate`에는 `app-*` 역할 외의 IAM 쓰기가 없다
- 참고: `ViewOnlyAccess`의 `Describe*`/`List*`는 설정값(예: ConfigMap 값)을 읽을 수 있다. 플랫폼은 읽되 저장하지 않는다

## 한 계정에 하나
역할 이름이 고정(`svc-observe`·`svc-operate`)이라 한 AWS 계정에 연결은 하나다. 같은 계정에 환경을 더 연결하려면 이름 규칙을 바꿔야 한다 (25번 H-L14).

## 확인 방법
- 이 레포 시험: `npm test` (`packages/adapters/test/onboarding-template.test.ts`가 모양·권한 범위를 고정, 클라우드 호출 없음)
- 문법 확인(자원 안 만듦, 사람 환경에서): `aws cloudformation validate-template --template-body file://infra/onboarding/aws-connect.json`
- STUB: `AmazonEKSViewPolicy` 이름과 `AWS::EKS::AccessEntry` 속성은 일반 지식 기준. 위 validate와 첫 실측으로 확인
- TODO(human): 이미지 저장소 읽기(`ecr:BatchGetImage` 등)가 `ViewOnlyAccess`에 없을 수 있음(미확인). 샌드박스 이미지 복사 때 관찰 인라인에 추가

# GCP 연결 (`gcp-connect.sh`)

키 파일은 만들지 않는다. 고객이 Cloud Shell에서 스크립트를 한 번 실행하면 아래가 생긴다.

| 만드는 것 | 내용 |
|---|---|
| SA 2개 | `svc-observe`(관찰), `svc-operate`(실행) |
| 커스텀 역할 3개 | `platform_observe`(읽기만. 데이터 자원 읽기 5개 + 둘레 자원·IAM 정책·방화벽·API 목록 등 읽기 전부 포함, 총 21개: `storage.buckets.list`·`storage.buckets.getIamPolicy`·`pubsub.topics.list`·`pubsub.subscriptions.list`·`redis.instances.list`, 객체 내용·메시지 권한 없음), `platform_operate`, `platform_operate_iam`(`infra/permissions`의 자동 생성 파일) |
| 프로젝트 연결 | 실행 SA의 IAM 정책 변경 권한은 `app-` 접두어 SA·시크릿에만 닿는 조건부 바인딩 |
| 빌리기 허용 | 플랫폼의 **이 회사 전용 SA**(`t-<16진 28자>@...`) 하나에게, 두 고객 SA 각각에 `roles/iam.serviceAccountTokenCreator` (프로젝트 전체가 아니라 SA 단위) |

순서: 연결 화면에서 `PLATFORM_SA` 복사 → Cloud Shell에서 `PLATFORM_SA=... PROJECT_ID=... ROLE_DIR=./permissions bash gcp-connect.sh` → 출력된 프로젝트 번호를 화면에 입력 → "확인".
`DRY_RUN=1`이면 명령만 출력한다. `PLATFORM_SA` 이름 규칙이 맞지 않으면 아무것도 만들기 전에 멈춘다.

- DRAFT(ai): 관찰 역할 권한 목록, 역할 ID 이름(`platform_observe` 등). 첫 실측 거부 로그로 보정
- TODO(human): 고객 프로젝트에서 `ROLE_DIR` 파일을 어떻게 전달할지(S3처럼 공개 위치 vs 스크립트에 내장)
- STUB: 이 스크립트는 레포 세션에서 실행하지 않음. 발급기(gcloud impersonate)는 별도 묶음
