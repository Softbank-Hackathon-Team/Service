# 진짜 GCP 없이 plan 만: 고정 루트 + kinds 모양 확인 (정상 + 거부). 자원은 안 만든다
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
  postgres_json = jsonencode([
    { id = "shop-db", name = "shop-db-ab12", major_version = "16", storage_gb = 20, storage_max_gb = null, instance_class = null, ha = null, read_replicas = null, parameters_json = "{\"max_connections\":200}", logical_replication = true, allow_from_json = "[\"api\"]", public = false, peer_cidrs_json = "[]", public_subnet_ids_json = null, deletion_protection = true },
  ])
  namespace_json = jsonencode([{ name = "app-shop", quota_cpu_m = 2000, quota_memory_mi = 4096 }])
  identity_json = jsonencode([
    { id = "api", name = "app-shop-api", service_account = "api", secret_names_json = "[\"JWT_SECRET\",\"SHARED\"]" },
    { id = "web", name = "app-shop-web", service_account = "web", secret_names_json = "[\"SHARED\"]" },
  ])
}

run "plan_all_kinds" {
  command = plan
  assert {
    condition     = module.postgres["shop-db"].link.port == "5432"
    error_message = "postgres link 출력이 다름"
  }
  assert {
    condition     = length(module.identity) == 2 && length(module.namespace) == 1
    error_message = "for_each 키(IR id) 별로 신원 2개·네임스페이스 1개여야 함"
  }
  assert {
    condition     = length(module.identity["api"].secret_ids) == 2 && length(module.identity["web"].secret_ids) == 0
    error_message = "공유 시크릿 그릇은 한 신원만 만들어야 함"
  }
}

run "plan_cluster_less_db_only" {
  command = plan
  variables {
    cluster_name = ""
  }
  assert {
    condition     = length(module.namespace) == 0 && length(module.identity) == 0 && length(module.postgres) == 1
    error_message = "클러스터 없으면 DB 만"
  }
}

run "plan_without_postgres" {
  command = plan
  variables {
    postgres_json = "[]"
  }
  assert {
    condition     = length(module.postgres) == 0
    error_message = "postgres 가 없어야 함"
  }
}

# 거부: 지원 안 하는 버전
run "reject_bad_version" {
  command = plan
  variables {
    postgres_json = jsonencode([{ id = "shop-db", name = "x", major_version = "9", storage_gb = 20 }])
  }
  expect_failures = [var.postgres_json]
}

# 거부: 같은 IR id 두 번
run "reject_duplicate_id" {
  command = plan
  variables {
    identity_json = jsonencode([
      { id = "api", name = "app-shop-api", service_account = "api" },
      { id = "api", name = "app-shop-api2", service_account = "api" },
    ])
  }
  expect_failures = [var.identity_json]
}

# 거부: SA 이름이 30자 초과 (IR id 를 그대로 쓰면 생기는 사고)
run "reject_long_sa_name" {
  command = plan
  variables {
    identity_json = jsonencode([{ id = "api", name = "app-${join("", [for i in range(40) : "a"])}", service_account = "api" }])
  }
  expect_failures = [var.identity_json]
}

# --- A5 종류: cache·objectStore·queue (정상)
run "plan_a5_kinds" {
  command = plan
  variables {
    cache_json        = jsonencode([{ id = "sessions", name = "shop-sessions-ab12", ha = null }])
    object_store_json = jsonencode([{ id = "uploads", name = "shop-uploads-ab12", versioning = true }])
    queue_json        = jsonencode([{ id = "jobs", name = "shop-jobs-ab12", ordered = false }])
  }
  assert {
    condition     = length(module.cache) == 1 && length(module.object_store) == 1 && length(module.queue) == 1
    error_message = "for_each 키(IR id) 별로 하나씩이어야 함"
  }
  assert {
    condition     = contains(keys(output.link_outputs), "sessions") && output.link_outputs["uploads"].name == "shop-uploads-ab12" && output.link_outputs["jobs"].name != ""
    error_message = "link_outputs 키가 LINK_OUTPUTS(cache host·port·url / objectStore name·url / queue url·name)와 달라짐"
  }
}

# 기본 빈 배열이면 안 만든다 (기존 동작 그대로)
run "plan_a5_default_empty" {
  command = plan
  assert {
    condition     = length(module.cache) + length(module.object_store) + length(module.queue) == 0
    error_message = "기본값에선 A5 종류가 없어야 함"
  }
}

# 거부: 같은 IR id 두 번
run "reject_a5_duplicate_id" {
  command = plan
  variables {
    queue_json = jsonencode([{ id = "jobs", name = "a-jobs" }, { id = "jobs", name = "b-jobs" }])
  }
  expect_failures = [var.queue_json]
}

# 거부: 버킷 이름 규칙 위반 (대문자)
run "reject_bad_bucket_name" {
  command = plan
  variables {
    object_store_json = jsonencode([{ id = "uploads", name = "Bad_Name" }])
  }
  expect_failures = [var.object_store_json]
}
