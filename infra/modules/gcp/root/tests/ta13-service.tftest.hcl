# TA13: 관리형 컨테이너(Cloud Run) 연결 흉내 시험 (자원 안 만듦). env 조각 합치기·결정적 주소·키별 비밀 그릇 + 거부
mock_provider "google" {
  mock_data "google_project" {
    defaults = { number = "123456789" }
  }
}
mock_provider "kubernetes" {}
mock_provider "random" {}

variables {
  project_id       = "demo-project"
  region           = "asia-northeast3"
  app_name         = "shop"
  tenant_id        = "t-aaaa1111"
  k8s_namespace    = "app-shop"
  network_id       = "projects/demo-project/global/networks/platform"
  cluster_name     = ""
  cluster_location = "asia-northeast3-a"
  service_json = jsonencode([
    { id           = "shop-api", name = "shopapi-1a2b3c", role_name = "app-shopapi-1a2b3c", image = "r/api@sha256:abababababababababababababababababababababababababababababababab",
      command_json = null, args_json = null, cpu_milli = 500, mem_mib = 1024, port = 8080, min_instances = 2, max_instances = 6, target_cpu_pct = 70, health_path = "/healthz",
      env_json     = jsonencode([{ name = "LOG_LEVEL", parts = [{ lit = "info", ref = null }] }]),
      secrets_json = jsonencode([{ name = "DATABASE_PASSWORD", secret = "app-shop-shop-db-password", key = "password" }]),
    identity = "shop-api", public = true },
    { id           = "shop-web", name = "shopweb-1a2b3c", role_name = "app-shopweb-1a2b3c", image = "r/web@sha256:abababababababababababababababababababababababababababababababab",
      command_json = null, args_json = null, cpu_milli = null, mem_mib = null, port = 8080, min_instances = 2, max_instances = 2, target_cpu_pct = null, health_path = null,
      env_json     = jsonencode([{ name = "API_URL", parts = [{ lit = null, ref = "shop-api.url" }] }]),
    secrets_json = "[]", identity = "shop-web", public = true },
  ])
}

run "cloudrun_services_wired" {
  command = plan
  assert {
    condition     = length(module.service) == 2 && keys(google_secret_manager_secret.svc) == ["app-shop-shop-db-password"]
    error_message = "서비스 2개 + 키별 비밀 그릇"
  }
  assert {
    condition     = jsondecode(local.service_cfg["shop-web"].env_json)[0].value == "https://shopapi-1a2b3c-123456789.asia-northeast3.run.app"
    error_message = "서비스 주소 = 결정적 Cloud Run 주소"
  }
  assert {
    condition     = local.svc_subnetwork == "projects/demo-project/regions/asia-northeast3/subnetworks/platform-nodes"
    error_message = "VPC 서브넷 = env 층 이름 규칙"
  }
}

run "no_service_unchanged" {
  command = plan
  variables {
    service_json = "[]"
  }
  assert {
    condition     = length(module.service) == 0 && length(data.google_project.this) == 0 && length(google_secret_manager_secret.svc) == 0
    error_message = "서비스가 없으면 Cloud Run 자원 0"
  }
}

run "reject_duplicate_id" {
  command = plan
  variables {
    service_json = "[{\"id\":\"a\"},{\"id\":\"a\"}]"
  }
  expect_failures = [var.service_json]
}
