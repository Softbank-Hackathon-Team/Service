# ESO + ClusterSecretStore: 기본(create_eso=false)은 없음, create_eso=true 면 설치, 클러스터 없으면(create_gke=false) 켜도 없음
mock_provider "google" {}
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
  # B-2 (나): KSA 가 그대로 IAM 주체 (gcp/root 가 비밀마다 principal://…/subject/ns/external-secrets/sa/external-secrets 에 준다)
  assert {
    condition     = yamldecode(helm_release.eso[0].values[0]).serviceAccount == { name = "external-secrets" } && yamldecode(helm_release.eso[0].values[0]).installCRDs
    error_message = "ESO KSA 는 이름만 (iam.gke.io/gcp-service-account annotation 없음), installCRDs=true"
  }
  assert {
    condition     = yamldecode(helm_release.secret_store[0].values[0]) == { name = "gcp-secret-manager", provider = "gcpsm", gcpsm = { projectID = "demo-proj" } }
    error_message = "store 이름 gcp-secret-manager (deploy/ci/values/gcp.json 과 같음), gcpsm 은 projectID 만 (auth 칸 없음)"
  }
  assert {
    condition     = output.secret_store_name == "gcp-secret-manager"
    error_message = "출력: store 이름"
  }
}
run "eso_no_gke" {
  command = plan
  variables {
    create_gke = false
    create_eso = true
  }
  assert {
    condition     = length(helm_release.eso) == 0 && length(helm_release.secret_store) == 0
    error_message = "create_gke=false 면 create_eso=true 여도 ESO 관련 0개"
  }
  assert {
    condition     = output.secret_store_name == ""
    error_message = "GKE 없으면 출력 빈 값"
  }
}
# 기본값: up 스크립트(-auto-approve)가 클러스터를 만드는 apply 에는 ESO 가 안 섞인다
run "eso_default_off" {
  command = plan
  assert {
    condition     = length(helm_release.eso) == 0 && length(helm_release.secret_store) == 0 && length(google_container_cluster.this) == 1
    error_message = "기본(create_eso=false)은 GKE 만 있고 ESO 는 없음"
  }
  assert {
    condition     = output.secret_store_name == ""
    error_message = "ESO 없으면 store 이름 출력 빈 값"
  }
}
