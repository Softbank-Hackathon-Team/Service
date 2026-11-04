# GitHub Actions → ECR 푸시 권한 (.github/workflows/build-ecr.yml). AWS 장기 키 없이 GitHub OIDC 토큰으로만 역할을 빌린다
#   provider: 계정에 하나만 둘 수 있다. 이미 있으면 create_github_oidc_provider = false 로 두고 data 로 찾는다
#   역할:     이 레포의 허용 ref(main, v* 태그)에서 돈 워크플로만 빌린다. 권한은 플랫폼 ECR 4개에 이미지 올리기뿐 (EKS·S3 등 없음)

# 계정에 token.actions.githubusercontent.com provider 가 이미 있으면 false (aws iam list-open-id-connect-providers 로 확인)
variable "create_github_oidc_provider" {
  type    = bool
  default = true
}
# 역할을 빌릴 수 있는 레포의 OIDC sub 접두사
# 레포가 use_immutable_subject 를 쓰므로 sub 가 ID 형태. gh api repos/<org>/<repo>/actions/oidc/customization/sub 의 sub_claim_prefix 값
# 이름 형태(repo:<org>/<repo>)는 받지 않는다: 이름을 바꾸거나 같은 이름으로 다시 만든 레포가 역할을 빌리지 못하게
variable "github_sub_prefix" {
  type    = string
  default = "repo:Softbank-Hackathon-Team@349390931/Service@1437237370"
  validation {
    condition     = can(regex("^repo:[A-Za-z0-9_.-]+@[0-9]+/[A-Za-z0-9_.-]+@[0-9]+$", var.github_sub_prefix))
    error_message = "github_sub_prefix 는 repo:<소유자>@<소유자 ID>/<레포>@<레포 ID> 모양이어야 한다 (이름 형태·와일드카드 불가)."
  }
}
# 역할을 빌릴 수 있는 git ref. OIDC 토큰 sub 의 ref: 뒤 부분과 StringLike 로 비교한다
# 다른 브랜치에서 workflow_dispatch 로 돌리면 여기서 막힌다 (의도된 동작)
# refs/heads/*, refs/tags/* 처럼 브랜치·태그 전체를 여는 값은 받지 않는다
variable "github_allowed_refs" {
  type    = list(string)
  default = ["refs/tags/v*", "refs/heads/main"]
  validation {
    condition = length(var.github_allowed_refs) > 0 && alltrue([
      for r in var.github_allowed_refs : (startswith(r, "refs/heads/") || startswith(r, "refs/tags/")) && !can(regex("^refs/(heads|tags)/\\*+$", r))
    ])
    error_message = "github_allowed_refs 는 비울 수 없고, 각 값은 refs/heads/ 또는 refs/tags/ 로 시작해야 하며, refs/heads/* · refs/tags/* 같은 전체 와일드카드는 안 된다."
  }
}

locals {
  github_oidc_url          = "https://token.actions.githubusercontent.com"
  github_oidc_provider_arn = var.create_github_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : data.aws_iam_openid_connect_provider.github[0].arn
  github_subjects          = [for r in var.github_allowed_refs : "${var.github_sub_prefix}:ref:${r}"]
}

# thumbprint_list 는 생략: AWS 가 GitHub OIDC 는 신뢰 CA 로 검증해 지문을 쓰지 않는다
resource "aws_iam_openid_connect_provider" "github" {
  count          = var.create_github_oidc_provider ? 1 : 0
  url            = local.github_oidc_url
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc_provider ? 0 : 1
  url   = local.github_oidc_url
}

resource "aws_iam_role" "github_ecr_push" {
  name        = "${var.name}-github-ecr-push"
  description = "GitHub Actions (${var.github_sub_prefix}) pushes platform images to ECR"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = local.github_oidc_provider_arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = { "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com" }
        StringLike   = { "token.actions.githubusercontent.com:sub" = local.github_subjects }
      }
    }]
  })
}

resource "aws_iam_role_policy" "github_ecr_push" {
  name = "push-platform-images"
  role = aws_iam_role.github_ecr_push.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # 로그인 토큰은 저장소 단위로 좁힐 수 없다 (AWS 가 Resource "*" 만 받음)
      { Sid = "EcrLogin", Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
      {
        Sid    = "PushPlatformImages"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
          "ecr:PutImage",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer",
          "ecr:DescribeImages",
        ]
        Resource = [for r in aws_ecr_repository.app : r.arn]
      },
    ]
  })
}

# GitHub repo variable AWS_ROLE_ARN 에 넣는 값
output "github_actions_ecr_role_arn" { value = aws_iam_role.github_ecr_push.arn }
