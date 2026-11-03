# I9: service-cloudrun 모듈 흉내 시험 (자원 안 만듦: mock_provider). 크기 고르기·입구·검증
mock_provider "google" {}

variables {
  project_id            = "demo-project"
  region                = "asia-northeast3"
  service_account_email = "app-shop-api@demo-project.iam.gserviceaccount.com"
  cfg = {
    id             = "shop-api"
    name           = "app-shop-api-1a2b"
    image          = "asia-northeast3-docker.pkg.dev/demo-project/app/shop-api@sha256:abababababababababababababababababababababababababababababababab"
    cpu_milli      = 500
    mem_mib        = 1024
    port           = 8080
    min_instances  = 2
    max_instances  = 6
    target_cpu_pct = 70
    health_path    = "/healthz"
    env_json       = "[{\"name\":\"LOG_LEVEL\",\"value\":\"info\"}]"
    secrets_json   = "[{\"name\":\"DATABASE_PASSWORD\",\"secret\":\"app-shop-shop-db\",\"key\":\"password\"}]"
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
      image         = "r/x@sha256:abababababababababababababababababababababababababababababababab"
      min_instances = 1
      max_instances = 1
      identity      = "x"
    }
  }
  expect_failures = [var.cfg]
}
