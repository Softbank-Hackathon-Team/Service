mock_provider "google" {
  mock_resource "google_iam_workload_identity_pool" {
    defaults = {
      workload_identity_pool_id = "platform-hub"
      name                      = "projects/123456789/locations/global/workloadIdentityPools/platform-hub"
    }
  }
}

variables {
  project_id      = "platform-proj"
  eks_oidc_issuer = "https://oidc.eks.ap-northeast-2.amazonaws.com/id/EXAMPLE"
}

run "hub_only" {
  command = apply
  assert {
    condition     = strcontains(google_iam_workload_identity_pool_provider.eks.attribute_condition, "argocd:argocd-application-controller") && length(output.hub_principals) == 2
    error_message = "교환은 허브 계정 둘만"
  }
  assert {
    condition     = alltrue([for m in output.hub_principals : startswith(m, "principal://iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/platform-hub/subject/system:serviceaccount:argocd:")])
    error_message = "주체는 gcloud 가 받는 principal:// 모양이어야 한다"
  }
}

run "bad_issuer" {
  command = plan
  variables {
    eks_oidc_issuer = "http://oidc.example"
  }
  expect_failures = [var.eks_oidc_issuer]
}
