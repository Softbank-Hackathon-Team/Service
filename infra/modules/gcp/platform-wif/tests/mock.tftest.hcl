mock_provider "google" {
  mock_resource "google_iam_workload_identity_pool" {
    defaults = {
      workload_identity_pool_id = "platform-hub"
      name                      = "projects/123456789/locations/global/workloadIdentityPools/platform-hub"
    }
  }
  mock_resource "google_service_account" {
    defaults = {
      name  = "projects/platform-proj/serviceAccounts/svc-worker@platform-proj.iam.gserviceaccount.com"
      email = "svc-worker@platform-proj.iam.gserviceaccount.com"
    }
  }
}

variables {
  project_id      = "platform-proj"
  eks_oidc_issuer = "https://oidc.eks.ap-northeast-2.amazonaws.com/id/EXAMPLE"
}

run "hub_and_worker_only" {
  command = apply
  assert {
    condition     = google_iam_workload_identity_pool_provider.eks.attribute_condition == "assertion.sub in [\"system:serviceaccount:argocd:argocd-application-controller\",\"system:serviceaccount:argocd:argocd-server\",\"system:serviceaccount:platform:worker\"]"
    error_message = "교환은 허브 계정 둘과 worker 만"
  }
  assert {
    condition     = length(output.hub_principals) == 2 && !anytrue([for m in output.hub_principals : strcontains(m, "platform:worker")])
    error_message = "worker 는 허브 주체가 아니다 (회사 SA 가장 권한이 허브 몫으로 나가면 안 된다)"
  }
  assert {
    condition     = google_service_account_iam_member.worker_federation.member == "principal://iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/platform-hub/subject/system:serviceaccount:platform:worker" && google_service_account_iam_member.worker_federation.role == "roles/iam.workloadIdentityUser"
    error_message = "svc-worker 는 worker 주체 하나만 가장한다"
  }
  assert {
    condition     = output.worker_principal == "serviceAccount:svc-worker@platform-proj.iam.gserviceaccount.com"
    error_message = "worker_principal 은 gcp-platform-tenant-sa.sh 가 받는 serviceAccount: 모양이어야 한다"
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
