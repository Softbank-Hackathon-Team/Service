# GitHub Actions → ECR 푸시 역할 (github_oidc.tf). 진짜 AWS 없이 plan만
# 모듈 전체를 plan 하므로 mock.tftest.hcl 과 같은 고정값이 필요하다 (계산값: SG ID, 클러스터 SG ID, OIDC 주소, 버킷 ARN)
mock_provider "aws" {
  override_during = plan
  mock_resource "aws_eks_cluster" {
    defaults = {
      vpc_config = { cluster_security_group_id = "sg-0cluster" }
      identity   = [{ oidc = [{ issuer = "https://oidc.eks.ap-northeast-2.amazonaws.com/id/MOCK" }] }]
    }
  }
  mock_resource "aws_security_group" {
    defaults = { id = "sg-0db" }
  }
  mock_resource "aws_route_table" {
    defaults = { route = [] }
  }
  mock_resource "aws_iam_openid_connect_provider" {
    defaults = { arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" }
  }
  mock_data "aws_iam_openid_connect_provider" {
    defaults = { arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com#existing" }
  }
}
override_resource {
  target          = aws_subnet.private_db[0]
  override_during = plan
  values          = { id = "subnet-0db-a" }
}
override_resource {
  target          = aws_subnet.private_db[1]
  override_during = plan
  values          = { id = "subnet-0db-c" }
}
override_resource {
  target          = aws_security_group.node["general"]
  override_during = plan
  values          = { id = "sg-0general" }
}
override_resource {
  target          = aws_security_group.node["cred"]
  override_during = plan
  values          = { id = "sg-0cred" }
}
override_resource {
  target          = aws_security_group.node["sandbox"]
  override_during = plan
  values          = { id = "sg-0sandbox" }
}
override_resource {
  target          = aws_s3_bucket.evidence
  override_during = plan
  values          = { arn = "arn:aws:s3:::platform-evidence-123456789012" }
}
# 푸시 정책이 저장소 ARN 4개만 가리키는지 보려고 ARN 을 고정한다
override_resource {
  target          = aws_ecr_repository.app["svc-api"]
  override_during = plan
  values          = { arn = "arn:aws:ecr:ap-northeast-2:123456789012:repository/svc-api" }
}
override_resource {
  target          = aws_ecr_repository.app["svc-worker"]
  override_during = plan
  values          = { arn = "arn:aws:ecr:ap-northeast-2:123456789012:repository/svc-worker" }
}
override_resource {
  target          = aws_ecr_repository.app["svc-agent-worker"]
  override_during = plan
  values          = { arn = "arn:aws:ecr:ap-northeast-2:123456789012:repository/svc-agent-worker" }
}
override_resource {
  target          = aws_ecr_repository.app["svc-web"]
  override_during = plan
  values          = { arn = "arn:aws:ecr:ap-northeast-2:123456789012:repository/svc-web" }
}
# 출력(역할 ARN)을 plan 에서 비교하려고 고정
override_resource {
  target          = aws_iam_role.github_ecr_push
  override_during = plan
  values          = { arn = "arn:aws:iam::123456789012:role/platform-github-ecr-push" }
}
variables {
  expected_account_id = "123456789012"
}

run "github_oidc_provider_created" {
  command = plan
  assert {
    condition     = length(aws_iam_openid_connect_provider.github) == 1 && length(data.aws_iam_openid_connect_provider.github) == 0
    error_message = "기본값이면 provider 를 만들고 data 로 찾지 않아야 함"
  }
  assert {
    condition     = aws_iam_openid_connect_provider.github[0].url == "https://token.actions.githubusercontent.com" && aws_iam_openid_connect_provider.github[0].client_id_list == toset(["sts.amazonaws.com"])
    error_message = "provider 주소는 token.actions.githubusercontent.com, 대상(aud)은 sts.amazonaws.com 하나여야 함"
  }
  assert {
    condition     = jsondecode(aws_iam_role.github_ecr_push.assume_role_policy).Statement[0].Principal.Federated == "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    error_message = "역할은 만든 provider 를 믿어야 함"
  }
}

run "github_trust_policy" {
  command = plan
  assert {
    condition = (
      length(jsondecode(aws_iam_role.github_ecr_push.assume_role_policy).Statement) == 1 &&
      jsondecode(aws_iam_role.github_ecr_push.assume_role_policy).Statement[0].Action == "sts:AssumeRoleWithWebIdentity" &&
      jsondecode(aws_iam_role.github_ecr_push.assume_role_policy).Statement[0].Condition.StringEquals == { "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com" }
    )
    error_message = "신뢰 정책은 AssumeRoleWithWebIdentity 하나, aud = sts.amazonaws.com (StringEquals)"
  }
  assert {
    condition = toset(jsondecode(aws_iam_role.github_ecr_push.assume_role_policy).Statement[0].Condition.StringLike["token.actions.githubusercontent.com:sub"]) == toset([
      "repo:Softbank-Hackathon-Team@349390931/Service@1437237370:ref:refs/tags/v*",
      "repo:Softbank-Hackathon-Team@349390931/Service@1437237370:ref:refs/heads/main",
    ])
    error_message = "sub 는 이 레포(ID 형태)의 v* 태그와 main 브랜치만 허용해야 함"
  }
  assert {
    condition     = !anytrue([for s in jsondecode(aws_iam_role.github_ecr_push.assume_role_policy).Statement[0].Condition.StringLike["token.actions.githubusercontent.com:sub"] : startswith(s, "repo:Softbank-Hackathon-Team/")])
    error_message = "이름 형태 sub(repo:<org>/<repo>)는 허용하면 안 됨 (레포가 use_immutable_subject)"
  }
  assert {
    condition     = aws_iam_role.github_ecr_push.name == "platform-github-ecr-push" && output.github_actions_ecr_role_arn == "arn:aws:iam::123456789012:role/platform-github-ecr-push"
    error_message = "역할 이름은 <name>-github-ecr-push, 출력 github_actions_ecr_role_arn 은 그 ARN"
  }
}

run "github_push_policy_least_privilege" {
  command = plan
  assert {
    condition = [for st in jsondecode(aws_iam_role_policy.github_ecr_push.policy).Statement : st.Resource if st.Resource == "*"] == ["*"] && [
      for st in jsondecode(aws_iam_role_policy.github_ecr_push.policy).Statement : st.Action if st.Resource == "*"
    ] == [["ecr:GetAuthorizationToken"]]
    error_message = "Resource \"*\" 는 ecr:GetAuthorizationToken 한 문장뿐이어야 함"
  }
  assert {
    condition = toset(flatten([for st in jsondecode(aws_iam_role_policy.github_ecr_push.policy).Statement : st.Resource if st.Resource != "*"])) == toset([
      "arn:aws:ecr:ap-northeast-2:123456789012:repository/svc-api",
      "arn:aws:ecr:ap-northeast-2:123456789012:repository/svc-worker",
      "arn:aws:ecr:ap-northeast-2:123456789012:repository/svc-agent-worker",
      "arn:aws:ecr:ap-northeast-2:123456789012:repository/svc-web",
    ])
    error_message = "푸시 권한은 플랫폼 ECR 저장소 4개에만 걸려야 함"
  }
  assert {
    condition = toset(flatten([for st in jsondecode(aws_iam_role_policy.github_ecr_push.policy).Statement : st.Action])) == toset([
      "ecr:GetAuthorizationToken",
      "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload",
      "ecr:PutImage", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:DescribeImages",
    ]) && alltrue([for st in jsondecode(aws_iam_role_policy.github_ecr_push.policy).Statement : st.Effect == "Allow"])
    error_message = "ECR 로그인·푸시 액션 9개 외의 권한이 없어야 함 (ecr:* 나 다른 서비스 없음)"
  }
}

run "github_existing_provider" {
  command = plan
  variables {
    create_github_oidc_provider = false
  }
  assert {
    condition     = length(aws_iam_openid_connect_provider.github) == 0 && length(data.aws_iam_openid_connect_provider.github) == 1
    error_message = "false 면 provider 를 만들지 않고 data 로 찾아야 함"
  }
  assert {
    condition     = jsondecode(aws_iam_role.github_ecr_push.assume_role_policy).Statement[0].Principal.Federated == "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com#existing"
    error_message = "false 면 역할은 이미 있는 provider(data)를 믿어야 함"
  }
}

run "github_custom_refs" {
  command = plan
  variables {
    github_allowed_refs = ["refs/heads/main"]
  }
  assert {
    condition     = jsondecode(aws_iam_role.github_ecr_push.assume_role_policy).Statement[0].Condition.StringLike["token.actions.githubusercontent.com:sub"] == ["repo:Softbank-Hackathon-Team@349390931/Service@1437237370:ref:refs/heads/main"]
    error_message = "허용 ref 를 줄이면 sub 도 그만큼만 허용해야 함"
  }
}

run "reject_name_form_sub_prefix" {
  command = plan
  variables {
    github_sub_prefix = "repo:Softbank-Hackathon-Team/Service"
  }
  expect_failures = [var.github_sub_prefix]
}

run "reject_wildcard_sub_prefix" {
  command = plan
  variables {
    github_sub_prefix = "repo:Softbank-Hackathon-Team@349390931/*"
  }
  expect_failures = [var.github_sub_prefix]
}

run "reject_bad_ref" {
  command = plan
  variables {
    github_allowed_refs = ["*"]
  }
  expect_failures = [var.github_allowed_refs]
}

# 브랜치·태그 전체를 여는 값은 하나라도 섞이면 거부
run "reject_full_wildcard_ref" {
  command = plan
  variables {
    github_allowed_refs = ["refs/tags/v*", "refs/heads/*"]
  }
  expect_failures = [var.github_allowed_refs]
}

run "reject_full_wildcard_tag_ref" {
  command = plan
  variables {
    github_allowed_refs = ["refs/tags/*"]
  }
  expect_failures = [var.github_allowed_refs]
}
