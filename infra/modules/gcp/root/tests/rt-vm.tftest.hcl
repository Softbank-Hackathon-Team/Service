# RUNTIMEMAP v2: VM(GCE) 연결 흉내 시험 (자원 안 만듦). env 조각 합치기·키별 비밀 그릇·Cloud Run 자원 0 + 거부
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
  vm_json = jsonencode([
    { id           = "shop-api", name = "shopapi-1a2b3c", role_name = "app-shopapi-1a2b3c", image = "asia-northeast3-docker.pkg.dev/demo-project/apps/api@sha256:abababababababababababababababababababababababababababababababab",
      command_json = null, args_json = null, cpu_milli = 500, mem_mib = 1024, port = 8080, instances = 2, health_path = null,
      env_json     = jsonencode([{ name = "LOG_LEVEL", parts = [{ lit = "info", ref = null }] }]),
      secrets_json = jsonencode([{ name = "DATABASE_PASSWORD", secret = "app-shop-shop-db-password", key = "password" }]),
    identity = "shop-api", public = true },
  ])
}

run "gce_vm_wired" {
  command = plan
  assert {
    condition     = length(module.vm) == 1 && keys(google_secret_manager_secret.svc) == ["app-shop-shop-db-password"]
    error_message = "VM 모듈 1개 + 키별 비밀 그릇"
  }
  assert {
    condition     = length(module.service) == 0 && length(data.google_project.this) == 0
    error_message = "VM 만 있으면 Cloud Run 자원 0"
  }
  assert {
    condition     = jsondecode(local.vm_cfg["shop-api"].env_json)[0].value == "info"
    error_message = "확정값 조각은 그대로"
  }
}

run "no_vm_unchanged" {
  command = plan
  variables {
    vm_json = "[]"
  }
  assert {
    condition     = length(module.vm) == 0 && length(google_secret_manager_secret.svc) == 0
    error_message = "VM 이 없으면 VM 자원 0 (기존 계획 그대로)"
  }
}

run "reject_duplicate_id" {
  command = plan
  variables {
    vm_json = "[{\"id\":\"a\",\"instances\":1,\"image\":\"x@sha256:abababababababababababababababababababababababababababababababab\"},{\"id\":\"a\",\"instances\":1,\"image\":\"x@sha256:abababababababababababababababababababababababababababababababab\"}]"
  }
  expect_failures = [var.vm_json]
}

run "reject_too_many_instances" {
  command = plan
  variables {
    vm_json = "[{\"id\":\"a\",\"instances\":21,\"image\":\"x@sha256:abababababababababababababababababababababababababababababababab\"}]"
  }
  expect_failures = [var.vm_json]
}

run "reject_unpinned_image" {
  command = plan
  variables {
    vm_json = "[{\"id\":\"a\",\"instances\":1,\"image\":\"x:latest\"}]"
  }
  expect_failures = [var.vm_json]
}
