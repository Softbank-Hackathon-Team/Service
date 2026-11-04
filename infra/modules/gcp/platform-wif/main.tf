# 플랫폼 GCP 프로젝트의 구글 교환 창구: 플랫폼 EKS 의 Argo CD 허브가 키 없이 구글 토큰을 받는다.
# EKS 가 파드에 준 토큰(OIDC)을 믿고, 그 토큰으로 회사 전용 플랫폼 SA(t-<28자>@) 를 가장하게 한다.
# 허브 쪽 설정은 deploy/argocd/argo-cd.gke-login.values.yaml, 설치 순서는 deploy/helm/platform/README.md
# DRAFT(ai): AWS 타입 대신 OIDC 타입. AWS 타입은 구글 Go 라이브러리가 파드 단위 역할을 못 읽어 노드 역할을 공유하게 된다
terraform {
  required_version = ">= 1.11"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 7.0" }
  }
}

variable "project_id" { type = string }

# aws/platform 출력 cluster_oidc_issuer
variable "eks_oidc_issuer" {
  type = string
  validation {
    condition     = startswith(var.eks_oidc_issuer, "https://")
    error_message = "EKS OIDC 발급자 주소는 https:// 로 시작한다"
  }
}

locals {
  # 차트 기본 서비스 계정 이름. 컨트롤러는 배포, 서버는 화면의 로그 보기에 쓴다
  hub_subjects = [
    "system:serviceaccount:argocd:argocd-application-controller",
    "system:serviceaccount:argocd:argocd-server",
  ]
}

resource "google_project_service" "api" {
  for_each           = toset(["iam.googleapis.com", "iamcredentials.googleapis.com", "sts.googleapis.com"])
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_iam_workload_identity_pool" "hub" {
  project                   = var.project_id
  workload_identity_pool_id = "platform-hub"
  display_name              = "platform argocd hub"
  depends_on                = [google_project_service.api]
}

resource "google_iam_workload_identity_pool_provider" "eks" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.hub.workload_identity_pool_id
  workload_identity_pool_provider_id = "platform-eks"
  attribute_mapping                  = { "google.subject" = "assertion.sub" }
  # 이 EKS 안에서도 허브 계정 둘만 교환한다
  attribute_condition = "assertion.sub in ${jsonencode(local.hub_subjects)}"
  oidc {
    issuer_uri = var.eks_oidc_issuer
  }
}

# 허브 토큰 audience 와 create-cred-config 에 그대로 쓴다
output "provider_name" { value = google_iam_workload_identity_pool_provider.eks.name }
output "audience" { value = "//iam.googleapis.com/${google_iam_workload_identity_pool_provider.eks.name}" }

# 가장 권한은 여기서 주지 않는다. 회사 전용 플랫폼 SA(t-) 마다 infra/onboarding/gcp-platform-tenant-sa.sh 가 이 주체에게 준다.
# DRAFT(ai): 프로젝트 전체에 주고 조건으로 t- 만 거르는 길은 버림. IAM Conditions 의 resource.name 지원 목록에 서비스 계정이 없다
output "hub_principals" {
  value = [for s in local.hub_subjects : "principal://iam.googleapis.com/${google_iam_workload_identity_pool.hub.name}/subject/${s}"]
}
