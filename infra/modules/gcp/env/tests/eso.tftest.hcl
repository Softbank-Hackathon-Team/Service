# ESO + ClusterSecretStore: 기본(create_eso=false)은 없음, create_eso=true 면 설치, 클러스터 없으면(create_gke=false) 켜도 없음
mock_provider "google" {
  override_during = plan # 가짜 이메일·번호를 plan 에서 바로 본다
  mock_data "google_project" {
    defaults = { number = "123456789012" }
  }
  mock_resource "google_service_account" {
    defaults = { email = "platform-target-eso@demo-proj.iam.gserviceaccount.com", name = "projects/demo-proj/serviceAccounts/platform-target-eso@demo-proj.iam.gserviceaccount.com" }
  }
}
mock_provider "helm" {}
mock_provider "kubernetes" {}
variables {
  project_id = "demo-proj"
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
    condition     = helm_release.eso[0].namespace == "external-secrets" && helm_release.eso[0].name == "external-secrets" && helm_release.eso[0].create_namespace
    error_message = "ESO 는 external-secrets/external-secrets (aws/platform 과 같은 이름)"
  }
  assert {
    condition     = google_service_account_iam_member.eso_wi[0].member == "serviceAccount:demo-proj.svc.id.goog[external-secrets/external-secrets]" && google_service_account_iam_member.eso_wi[0].role == "roles/iam.workloadIdentityUser"
    error_message = "WI member 는 <project>.svc.id.goog[external-secrets/external-secrets]"
  }
  assert {
    condition     = yamldecode(helm_release.eso[0].values[0]).serviceAccount.annotations["iam.gke.io/gcp-service-account"] == "platform-target-eso@demo-proj.iam.gserviceaccount.com" && yamldecode(helm_release.eso[0].values[0]).installCRDs
    error_message = "ESO KSA 에 GSA annotation, installCRDs=true"
  }
  assert {
    condition     = google_project_iam_member.eso_secret_access[0].role == "roles/secretmanager.secretAccessor" && google_project_iam_member.eso_secret_access[0].condition[0].expression == "resource.name.startsWith(\"projects/123456789012/secrets/app-\")"
    error_message = "읽기 권한은 app- 접두어 비밀만 (프로젝트 번호 기준)"
  }
  assert {
    condition     = yamldecode(helm_release.secret_store[0].values[0]).name == "gcp-secret-manager" && yamldecode(helm_release.secret_store[0].values[0]).provider == "gcpsm" && yamldecode(helm_release.secret_store[0].values[0]).gcpsm.projectID == "demo-proj"
    error_message = "store 이름 gcp-secret-manager (deploy/ci/values/gcp.json 과 같음), gcpsm projectID"
  }
  assert {
    condition     = output.secret_store_name == "gcp-secret-manager" && output.eso_service_account_email != ""
    error_message = "출력: store 이름·ESO SA 이메일"
  }
}
run "eso_no_gke" {
  command = plan
  variables {
    create_gke = false
    create_eso = true
  }
  assert {
    condition     = length(helm_release.eso) == 0 && length(helm_release.secret_store) == 0 && length(google_service_account.eso) == 0 && length(google_project_iam_member.eso_secret_access) == 0
    error_message = "create_gke=false 면 create_eso=true 여도 ESO 관련 0개"
  }
  assert {
    condition     = output.secret_store_name == "" && output.eso_service_account_email == ""
    error_message = "GKE 없으면 출력 빈 값"
  }
}
# 기본값: up 스크립트(-auto-approve)가 클러스터를 만드는 apply 에는 ESO 가 안 섞인다
run "eso_default_off" {
  command = plan
  assert {
    condition     = length(helm_release.eso) == 0 && length(helm_release.secret_store) == 0 && length(google_service_account.eso) == 0 && length(google_container_cluster.this) == 1
    error_message = "기본(create_eso=false)은 GKE 만 있고 ESO 는 없음"
  }
  assert {
    condition     = output.secret_store_name == ""
    error_message = "ESO 없으면 store 이름 출력 빈 값"
  }
}
