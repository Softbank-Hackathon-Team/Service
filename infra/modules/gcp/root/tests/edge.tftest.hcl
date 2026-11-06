# VTA2h: 경계값·거부 경로 보강. 진짜 GCP 없이 plan 만 (mock provider)
mock_provider "google" {
  mock_data "google_container_cluster" {
    defaults = {
      endpoint    = "10.0.0.2"
      master_auth = [{ cluster_ca_certificate = "bW9jaw==" }]
    }
  }
  mock_data "google_client_config" {
    defaults = { access_token = "mock-token" }
  }
  mock_data "google_project" {
    defaults = { number = "123456789012" }
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
  cluster_name     = "platform-gke"
  cluster_location = "asia-northeast3-a"
  postgres_json    = "[]"
  namespace_json   = "[]"
  identity_json    = "[]"
}

# #317 가: 신원 = KSA 직접 주체 (GSA 없음). 주체는 프로젝트 번호(data.google_project) + WI 풀 + 구역/KSA
run "identity_is_ksa_principal" {
  command = plan
  variables {
    identity_json = jsonencode([{ id = "api", name = "app-shop-api", service_account = "api" }])
  }
  assert {
    condition     = module.identity["api"].principal == "principal://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/demo-project.svc.id.goog/subject/ns/app-shop/sa/api"
    error_message = "신원 주체는 KSA app-shop/api 의 principal:// (프로젝트 번호는 data.google_project)"
  }
  assert {
    condition     = output.identity_principals == { api = module.identity["api"].principal } && output.app_principal == module.identity["api"].principal
    error_message = "출력 identity_principals·app_principal 은 신원 주체"
  }
}

# name 은 예전 GSA account_id 였다. GSA 가 없어 길이·접두어를 보지 않는다 (예전 30자·app- 거부는 없앰)
run "identity_name_not_checked" {
  command = plan
  variables {
    identity_json = jsonencode([
      { id = "api", name = "app-${join("", [for i in range(40) : "a"])}", service_account = "api" },
      { id = "web", name = "shop-web", service_account = "web" },
    ])
  }
  assert {
    condition     = length(module.identity) == 2 && endswith(module.identity["web"].principal, "/subject/ns/app-shop/sa/web")
    error_message = "name 과 상관없이 KSA 마다 주체 하나"
  }
}

# 거부: JSON 이 아닌 입력 (변수 검증이 먼저 막아야 함)
run "reject_postgres_not_json" {
  command = plan
  variables {
    postgres_json = "not json"
  }
  expect_failures = [var.postgres_json]
}

# 거부: id 규칙 (대문자·밑줄·빈 값)
run "reject_postgres_upper_id" {
  command = plan
  variables {
    postgres_json = jsonencode([{ id = "Shop-DB", name = "x", major_version = "16", storage_gb = 20 }])
  }
  expect_failures = [var.postgres_json]
}
run "reject_postgres_underscore_id" {
  command = plan
  variables {
    postgres_json = jsonencode([{ id = "shop_db", name = "x", major_version = "16", storage_gb = 20 }])
  }
  expect_failures = [var.postgres_json]
}

# 거부: 버전 경계 (14·18 은 지원 밖)
run "reject_postgres_version_18" {
  command = plan
  variables {
    postgres_json = jsonencode([{ id = "shop-db", name = "x", major_version = "18", storage_gb = 20 }])
  }
  expect_failures = [var.postgres_json]
}

# 거부: postgres id 중복
run "reject_postgres_duplicate_id" {
  command = plan
  variables {
    postgres_json = jsonencode([
      { id = "shop-db", name = "a", major_version = "16", storage_gb = 20 },
      { id = "shop-db", name = "b", major_version = "16", storage_gb = 20 },
    ])
  }
  expect_failures = [var.postgres_json]
}

# 정상: 버전 15·17 통과
run "postgres_versions_15_17_ok" {
  command = plan
  variables {
    postgres_json = jsonencode([
      { id = "a-db", name = "a-db-1111", major_version = "15", storage_gb = 20 },
      { id = "b-db", name = "b-db-2222", major_version = "17", storage_gb = 20 },
    ])
  }
  assert {
    condition     = length(module.postgres) == 2
    error_message = "15·17 은 통과해야 함"
  }
}

# 경계: postgres 가 2개면 평평한 출력(복제 대상)은 비고, link_outputs 는 둘 다
run "two_postgres_flat_outputs_empty" {
  command = plan
  variables {
    postgres_json = jsonencode([
      { id = "a-db", name = "a-db-1111", major_version = "16", storage_gb = 20 },
      { id = "b-db", name = "b-db-2222", major_version = "16", storage_gb = 20 },
    ])
  }
  assert {
    condition     = output.db_private_ip == "" && output.db_password_secret_id == "" && output.db_connection_name == ""
    error_message = "postgres 가 2개면 v1 평평한 출력은 비어야 함"
  }
  assert {
    condition     = length(keys(output.link_outputs)) == 2
    error_message = "link_outputs 는 id 별로 둘 다"
  }
}

# 경계: 종류가 모두 비면 아무것도 안 만들고 평평한 출력은 빈 값
run "all_empty_lists" {
  command = plan
  assert {
    condition     = length(module.postgres) == 0 && length(module.identity) == 0 && length(module.namespace) == 0
    error_message = "빈 목록은 아무것도 안 만듦"
  }
  assert {
    condition     = output.app_principal == "" && output.namespace == "" && output.db_private_ip == "" && length(output.identity_principals) == 0
    error_message = "빈 출력"
  }
}

# 경계: 클러스터가 없으면 identity·namespace 목록이 있어도 건너뜀
run "cluster_less_skips_k8s_kinds" {
  command = plan
  variables {
    cluster_name   = ""
    namespace_json = jsonencode([{ name = "app-shop", quota_cpu_m = null, quota_memory_mi = null }])
    identity_json  = jsonencode([{ id = "api", name = "app-shop-api", service_account = "api" }])
  }
  assert {
    condition     = length(module.namespace) == 0 && length(module.identity) == 0
    error_message = "클러스터 없으면 k8s 쪽 종류 건너뜀"
  }
}

# 정상: 신원이 없으면 대표 출력이 빈 값
run "no_identity_empty_role_output" {
  command = plan
  variables {
    namespace_json = jsonencode([{ name = "app-shop", quota_cpu_m = null, quota_memory_mi = null }])
  }
  assert {
    condition     = output.app_principal == "" && output.namespace == "app-shop" && length(data.google_project.this) == 0
    error_message = "신원 없음 → app_principal 빈 값·프로젝트 읽기 없음, namespace 는 이름"
  }
}
