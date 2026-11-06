# #317 가: 앱 신원 = KSA 직접 주체 (GSA·Workload Identity SA 바인딩 없음). 진짜 GCP 없이 plan 만 (자원 안 만듦)
mock_provider "google" {}

variables {
  cfg = {
    id                = "api"
    name              = "app-shop-api"
    service_account   = "api"
    secret_names_json = "[\"JWT_SECRET\",\"db.url\"]"
  }
  app_name               = "shop"
  project_id             = "demo-project"
  project_number         = "123456789012"
  namespace              = "app-shop"
  labels                 = { managed-by = "platform" }
  owned_secret_names     = ["JWT_SECRET", "db.url"]
  extra_readable_secrets = ["projects/demo-project/secrets/app-shop-shop-db-db-password"]
}

run "reads_bound_to_ksa_principal" {
  command = plan
  assert {
    condition     = output.principal == "principal://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/demo-project.svc.id.goog/subject/ns/app-shop/sa/api"
    error_message = "주체 = 프로젝트 번호 + GKE 워크로드 풀(<프로젝트 id>.svc.id.goog) + 구역/KSA"
  }
  assert {
    condition     = length(google_secret_manager_secret_iam_member.read) == 3 && alltrue([for b in google_secret_manager_secret_iam_member.read : b.member == output.principal && b.role == "roles/secretmanager.secretAccessor"])
    error_message = "자기 그릇 2 + DB 비밀번호 1 을 KSA 주체가 그릇 단위로 읽는다"
  }
  assert {
    condition     = google_secret_manager_secret_iam_member.read["own-db.url"].secret_id == "projects/demo-project/secrets/app-shop-db-url"
    error_message = "그릇 이름은 . 도 - 로 (TF4-3, Builder remoteKey 와 같은 규칙)"
  }
}

# 비밀이 없는 신원(옮긴 권한만)도 주체는 있다 — root grants.tf 가 이 주체에 버킷·토픽·구독 역할을 준다
run "no_secrets_still_has_principal" {
  command = plan
  variables {
    cfg                    = { id = "worker", service_account = "worker" }
    owned_secret_names     = []
    extra_readable_secrets = []
  }
  assert {
    condition     = length(google_secret_manager_secret_iam_member.read) == 0 && length(google_secret_manager_secret.s) == 0 && endswith(output.principal, "/subject/ns/app-shop/sa/worker")
    error_message = "비밀 없으면 바인딩 0, 주체만"
  }
}

# 거부: 프로젝트 번호 자리에 프로젝트 id 가 오면 IAM 이 주체를 못 알아본다
run "reject_project_id_as_number" {
  command = plan
  variables {
    project_number = "demo-project"
  }
  expect_failures = [var.project_number]
}
