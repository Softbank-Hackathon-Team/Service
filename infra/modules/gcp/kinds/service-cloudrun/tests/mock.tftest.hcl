# I9: service-cloudrun 모듈 흉내 시험 (자원 안 만듦: mock_provider). 크기 고르기·입구·검증. TA13: SA·비밀 접근·호출 허용
mock_provider "google" {}

variables {
  project_id = "demo-project"
  region     = "asia-northeast3"
  secret_ids = { "app-shop-shop-db-password" = "app-shop-shop-db-password" }
  cfg = {
    id             = "shop-api"
    name           = "app-shop-api-1a2b"
    role_name      = "app-shopapi-1a2b"
    image          = "asia-northeast3-docker.pkg.dev/demo-project/app/shop-api@sha256:abababababababababababababababababababababababababababababababab"
    cpu_milli      = 500
    mem_mib        = 1024
    port           = 8080
    min_instances  = 2
    max_instances  = 6
    target_cpu_pct = 70
    health_path    = "/healthz"
    env_json       = "[{\"name\":\"LOG_LEVEL\",\"value\":\"info\"}]"
    secrets_json   = "[{\"name\":\"DATABASE_PASSWORD\",\"secret\":\"app-shop-shop-db-password\",\"key\":\"password\"}]"
    identity       = "shop-api"
    public         = true
  }
}

run "size_and_public" {
  command = plan
  assert {
    condition     = output.cpu == 1 && output.mem_mib == 1024
    error_message = "500m → 1 vCPU, 1024Mi 그대로"
  }
  assert {
    condition     = google_cloud_run_v2_service.app.ingress == "INGRESS_TRAFFIC_ALL"
    error_message = "입구가 오는 서비스는 외부"
  }
  assert {
    condition     = google_cloud_run_v2_service.app.template[0].scaling[0].min_instance_count == 2
    error_message = "min 그대로"
  }
}

run "internal_worker" {
  command = plan
  variables {
    cfg = {
      id            = "shop-worker"
      name          = "app-shop-worker-1a2b"
      role_name     = "app-shopworker-1a2b"
      image         = "r/w@sha256:abababababababababababababababababababababababababababababababab"
      min_instances = 1
      max_instances = 1
      identity      = "shop-worker"
    }
  }
  assert {
    condition     = google_cloud_run_v2_service.app.ingress == "INGRESS_TRAFFIC_INTERNAL_ONLY" && output.mem_mib == 512
    error_message = "입구 없음 → 내부 전용, 메모리 최소 512"
  }
}

run "reject_bad_name" {
  command = plan
  variables {
    cfg = {
      id            = "x"
      name          = "Bad_Name"
      role_name     = "app-x-1a2b"
      image         = "r/x@sha256:abababababababababababababababababababababababababababababababab"
      min_instances = 1
      max_instances = 1
      identity      = "x"
    }
  }
  expect_failures = [var.cfg]
}

run "sa_and_secret_access" {
  command = plan
  assert {
    condition     = google_service_account.app.account_id == "app-shopapi-1a2b" && length(google_secret_manager_secret_iam_member.read) == 1
    error_message = "SA 하나 + 쓰는 비밀 그릇마다 접근 하나"
  }
  assert {
    condition     = contains([for e in google_cloud_run_v2_service.app.template[0].containers[0].env : try(e.value_source[0].secret_key_ref[0].secret, "")], "app-shop-shop-db-password")
    error_message = "비밀 env = 루트가 만든 그릇 id"
  }
}

run "reject_bad_role_name" {
  command = plan
  variables {
    cfg = {
      id            = "x"
      name          = "x-1a2b"
      role_name     = "sa"
      image         = "r/x@sha256:abababababababababababababababababababababababababababababababab"
      min_instances = 1
      max_instances = 1
      identity      = "x"
    }
  }
  expect_failures = [var.cfg]
}
