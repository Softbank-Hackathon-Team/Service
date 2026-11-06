# Argo CD 허브 신원 (argocd-hub.tf). 진짜 AWS 없이 plan 만
mock_provider "aws" {
  override_during = plan
}
# 연결 템플릿 버킷은 이미 있는 버킷을 data 로 읽는다 (mock.tftest.hcl 과 같은 고정값)
override_data {
  target = data.aws_s3_bucket.connect_template
  values = { id = "svc-connect-template-5f2cb764", arn = "arn:aws:s3:::svc-connect-template-5f2cb764", region = "ap-northeast-2" }
}
override_resource {
  target          = aws_iam_role.argocd_hub
  override_during = plan
  values          = { arn = "arn:aws:iam::123456789012:role/platform-argocd-hub" }
}
variables {
  expected_account_id = "123456789012"
}

run "hub_identity" {
  command = plan
  assert {
    condition     = aws_iam_role.argocd_hub.name == "platform-argocd-hub" && [for st in jsondecode(aws_iam_role.argocd_hub.assume_role_policy).Statement : st.Principal] == [{ Service = "pods.eks.amazonaws.com" }]
    error_message = "허브 역할 이름은 platform-argocd-hub, Pod Identity(pods.eks.amazonaws.com)만 믿는다"
  }
  assert {
    condition     = toset([for a in aws_eks_pod_identity_association.argocd_hub : "${a.namespace}/${a.service_account}"]) == toset(["argocd/argocd-application-controller", "argocd/argocd-server"])
    error_message = "허브 역할은 argocd 의 application-controller·server 두 서비스 계정에만 묶인다 (repo-server·applicationset 은 클러스터에 안 붙음)"
  }
  assert {
    condition     = jsondecode(aws_iam_role_policy.argocd_hub.policy).Statement == [{ Sid = "AssumeCustomerDeployRole", Effect = "Allow", Action = ["sts:AssumeRole", "sts:TagSession"], Resource = ["arn:aws:iam::*:role/svc-deploy"] }]
    error_message = "허브 권한은 고객 svc-deploy 빌리기 하나뿐 (role/* · 다른 동작 없음)"
  }
  assert {
    condition     = output.argocd_hub_role_arn == "arn:aws:iam::123456789012:role/platform-argocd-hub"
    error_message = "출력 argocd_hub_role_arn = 고객 템플릿 ArgoHubRoleArn 에 넣을 값 (역할 ARN)"
  }
}
