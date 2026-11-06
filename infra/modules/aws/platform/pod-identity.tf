# 플랫폼 앱 파드 권한 (Pod Identity). 신뢰 정책은 main.tf 의 local.pod_trust (pods.eks.amazonaws.com 만 믿음)
#   worker: 고객 계정이 믿는 플랫폼 주체는 이 역할 하나 (고객 템플릿 PlatformPrincipalArn). 고객 역할 빌리기 + 증거 쓰기
#           state 권한은 없다: 고객 이전 state 위치가 정해지지 않아 넣지 않음
#   api:    증거 읽기만
#   agent-worker 는 클라우드 권한 0 이라 역할이 없다. 허브 Argo CD 역할은 다른 PR

locals {
  # 고객 역할 이름: packages/adapters/scripts/aws-connect-template.ts 의 OBSERVE_ROLE_NAME·OPERATE_ROLE_NAME 과 같아야 한다
  # DRAFT(ai): 고객 계정 번호를 미리 알 수 없어 계정 자리만 * 로 둔다. 역할 이름은 두 바탕으로 고정 (role/* 아님)
  #   한 계정에 환경 여럿 (0056): 새 연결은 이름 끝에 환경 꼬리 "-<16진 8자>" (템플릿 RoleSuffix) → 바탕-* 도 같이. 옛 연결은 꼬리 없는 이름 그대로
  customer_role_arns = ["arn:aws:iam::*:role/svc-observe", "arn:aws:iam::*:role/svc-operate", "arn:aws:iam::*:role/svc-observe-*", "arn:aws:iam::*:role/svc-operate-*"]
  # 리허설 이미지 복사 자리 (worker SANDBOX_IMAGE_REGISTRY = 출력 sandbox_image_registry). 회사별 저장소 sandbox/<회사>/<이름> 을 워커가 만든다
  # 플랫폼 ECR 은 샌드박스 접두어를 sandbox 하나만 쓴다 (네임스페이스·DNS 이름의 sbx- 와는 별개)
  sandbox_image_prefix = "sandbox"

  worker_statements = [
    {
      Sid    = "AssumeCustomerRoles"
      Effect = "Allow"
      # 고객 신뢰 정책이 AssumeRole·TagSession·SetSourceIdentity 셋을 허용하고, 발급기는 Tags·SourceIdentity 를 항상 넣는다
      # (aws-connect-template.ts trust 주석). 호출 쪽에도 SetSourceIdentity 가 없으면 AccessDenied 라 같이 넣는다
      Action   = ["sts:AssumeRole", "sts:TagSession", "sts:SetSourceIdentity"]
      Resource = local.customer_role_arns
    },
    {
      Sid      = "WriteEvidence"
      Effect   = "Allow"
      Action   = ["s3:PutObject"]
      Resource = ["${aws_s3_bucket.evidence.arn}/*"]
    },
    {
      Sid    = "SandboxImageLogin"
      Effect = "Allow"
      # 레지스트리 로그인 토큰. 이 동작은 자원 단위 제한을 받지 않아 * 다. 실제 받기·올리기는 아래 저장소 범위가 정한다
      Action   = ["ecr:GetAuthorizationToken"]
      Resource = ["*"]
    },
    {
      Sid    = "SandboxImagePush"
      Effect = "Allow"
      # 고객 이미지를 다이제스트로 복사해 넣기 (worker rehearsal/image-mirror.ts, 복사는 워커가 crane 으로). 샌드박스 접두어 아래만
      #   저장소 만들기 + 올리기 다섯 동작 + BatchGetImage(매니페스트 읽기: 복사 전후 crane digest 로 다이제스트 확인).
      #   층 받기(GetDownloadUrlForLayer)·지우기·정책 바꾸기는 없다. 샌드박스 노드는 자기 노드 역할로 받는다
      Action = [
        "ecr:CreateRepository", "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage",
      ]
      Resource = ["arn:aws:ecr:${var.region}:${var.expected_account_id}:repository/${local.sandbox_image_prefix}/*"]
    },
  ]
}

output "sandbox_image_registry" { value = "${var.expected_account_id}.dkr.ecr.${var.region}.amazonaws.com/${local.sandbox_image_prefix}" }

# 이름 platform-worker: 고객 연결 템플릿 시험(packages/adapters/test/onboarding-template.test.ts)이 이 이름을 예시로 쓴다
# DRAFT(ai): var.name 을 따르지 않고 고정. name 을 바꿔도 고객 템플릿 예시·bootstrap 주체 목록과 어긋나지 않게
resource "aws_iam_role" "worker" {
  name               = "platform-worker"
  assume_role_policy = local.pod_trust
}

resource "aws_iam_role_policy" "worker" {
  name   = "worker"
  role   = aws_iam_role.worker.id
  policy = jsonencode({ Version = "2012-10-17", Statement = local.worker_statements })
}

resource "aws_eks_pod_identity_association" "worker" {
  cluster_name    = aws_eks_cluster.this.name
  namespace       = "platform"
  service_account = "worker"
  role_arn        = aws_iam_role.worker.arn
}

resource "aws_iam_role" "api" {
  name               = "platform-api"
  assume_role_policy = local.pod_trust
}

resource "aws_iam_role_policy" "api" {
  name = "read-evidence"
  role = aws_iam_role.api.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "ReadEvidence", Effect = "Allow", Action = ["s3:GetObject"], Resource = ["${aws_s3_bucket.evidence.arn}/*"] },
      { Sid = "ListEvidence", Effect = "Allow", Action = ["s3:ListBucket"], Resource = [aws_s3_bucket.evidence.arn] },
    ]
  })
}

resource "aws_eks_pod_identity_association" "api" {
  cluster_name    = aws_eks_cluster.this.name
  namespace       = "platform"
  service_account = "api"
  role_arn        = aws_iam_role.api.arn
}
