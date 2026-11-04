# ESO + ClusterSecretStore: 기본(create_eso=false)은 없음, create_eso=true 면 설치, 클러스터 없으면(create_eks=false) 켜도 없음
mock_provider "aws" {
  override_during = plan # 가짜 역할 ARN 을 plan 에서 바로 본다
  mock_data "aws_availability_zones" {
    defaults = { names = ["ap-northeast-2a", "ap-northeast-2c"] }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/platform-target-external-secrets" }
  }
}
mock_provider "helm" {}
mock_provider "kubernetes" {}
variables {
  expected_account_id = "123456789012"
}
run "eso_on" {
  command = plan
  variables {
    create_eso = true
  }
  assert {
    condition     = length(helm_release.eso) == 1 && length(helm_release.secret_store) == 1
    error_message = "create_eso=true 면 ESO·store 릴리스 각 1개"
  }
  assert {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", helm_release.eso[0].version)) && helm_release.eso[0].version == "2.14.0" && helm_release.eso[0].repository == "https://charts.external-secrets.io"
    error_message = "ESO 차트 버전은 x.y.z 로 고정"
  }
  assert {
    condition     = helm_release.eso[0].namespace == "external-secrets" && helm_release.eso[0].name == "external-secrets" && helm_release.eso[0].create_namespace && yamldecode(helm_release.eso[0].values[0]).installCRDs
    error_message = "ESO 는 external-secrets 네임스페이스, installCRDs=true"
  }
  assert {
    condition     = aws_eks_pod_identity_association.eso[0].namespace == "external-secrets" && aws_eks_pod_identity_association.eso[0].service_account == "external-secrets" && yamldecode(helm_release.eso[0].values[0]).serviceAccount.name == "external-secrets"
    error_message = "Pod Identity 는 external-secrets/external-secrets (차트 SA 이름과 같아야 함)"
  }
  assert {
    condition     = jsondecode(aws_iam_role.eso[0].assume_role_policy).Statement[0].Principal.Service == "pods.eks.amazonaws.com" && toset(jsondecode(aws_iam_role.eso[0].assume_role_policy).Statement[0].Action) == toset(["sts:AssumeRole", "sts:TagSession"])
    error_message = "신뢰: pods.eks.amazonaws.com, AssumeRole + TagSession"
  }
  assert {
    condition = toset(jsondecode(aws_iam_role_policy.eso[0].policy).Statement[0].Resource) == toset([
      "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:platform/*",
      "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:rds!*",
    ]) && toset(jsondecode(aws_iam_role_policy.eso[0].policy).Statement[0].Action) == toset(["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"])
    error_message = "읽기 범위는 platform/* 와 rds!* 두 개, Get·Describe 만"
  }
  assert {
    condition     = yamldecode(helm_release.secret_store[0].values[0]).name == "aws-secrets-manager" && yamldecode(helm_release.secret_store[0].values[0]).provider == "aws" && yamldecode(helm_release.secret_store[0].values[0]).aws.region == "ap-northeast-2"
    error_message = "store 이름 aws-secrets-manager (deploy/ci/values/aws.json 과 같음), provider aws, region"
  }
  assert {
    condition     = output.secret_store_name == "aws-secrets-manager" && output.eso_role_arn == "arn:aws:iam::123456789012:role/platform-target-external-secrets"
    error_message = "출력: store 이름·ESO 역할 ARN"
  }
}
run "eso_no_eks" {
  command = plan
  variables {
    create_eks = false
    create_eso = true
  }
  assert {
    condition     = length(helm_release.eso) == 0 && length(helm_release.secret_store) == 0 && length(aws_iam_role.eso) == 0 && length(aws_eks_pod_identity_association.eso) == 0 && length(data.aws_eks_cluster_auth.this) == 0
    error_message = "create_eks=false 면 create_eso=true 여도 ESO 관련 0개"
  }
  assert {
    condition     = output.secret_store_name == "" && output.eso_role_arn == ""
    error_message = "EKS 없으면 출력 빈 값"
  }
}
# 기본값: up 스크립트(-auto-approve)가 클러스터를 만드는 apply 에는 ESO 가 안 섞인다
run "eso_default_off" {
  command = plan
  assert {
    condition     = length(helm_release.eso) == 0 && length(helm_release.secret_store) == 0 && length(aws_iam_role.eso) == 0 && length(aws_eks_pod_identity_association.eso) == 0 && length(aws_eks_cluster.this) == 1
    error_message = "기본(create_eso=false)은 EKS 만 있고 ESO 는 없음"
  }
  assert {
    condition     = output.secret_store_name == ""
    error_message = "ESO 없으면 store 이름 출력 빈 값"
  }
}
