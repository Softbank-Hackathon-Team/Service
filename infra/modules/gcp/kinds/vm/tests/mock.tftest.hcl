# RUNTIMEMAP v2: kinds/vm(GCE) 모듈 단독 시험 (자원 안 만듦). 머신 고르기·startup-script 내용·SA 이름 + 거부
mock_provider "google" {}

variables {
  cfg = {
    id           = "shop-api"
    name         = "shopapi-1a2b3c"
    role_name    = "app-shopapi-1a2b3c"
    image        = "asia-northeast3-docker.pkg.dev/demo-project/apps/api@sha256:abababababababababababababababababababababababababababababababab"
    command_json = "[\"/app/server\",\"--x\"]"
    cpu_milli    = 3000
    mem_mib      = 6000
    port         = 8080
    instances    = 2
    env_json     = "[{\"name\":\"LOG_LEVEL\",\"value\":\"info\"}]"
    secrets_json = "[{\"name\":\"DATABASE_PASSWORD\",\"secret\":\"s\",\"key\":\"password\"}]"
    identity     = "shop-api"
    public       = false
  }
  project_id = "demo-project"
  region     = "asia-northeast3"
  subnetwork = "projects/demo-project/regions/asia-northeast3/subnetworks/platform-nodes"
  secret_ids = { s = "app-shop-s-password" }
}

run "vm_shape_and_install" {
  command = plan
  assert {
    condition     = output.machine_type == "e2-standard-4" && length(google_compute_instance.app) == 2
    error_message = "cpu 3000·mem 6000 이상 가장 작은 e2-standard-4 (e2-standard-2 는 2vCPU), 대수 = instances"
  }
  assert {
    condition     = strcontains(local.startup, "systemctl enable --now platform-shop-api.service") && strcontains(local.startup, "LOG_LEVEL=info")
    error_message = "startup-script 가 systemd 유닛과 env 를 깔음"
  }
  assert {
    condition     = strcontains(local.startup, "gcloud secrets versions access latest --project demo-project --secret app-shop-s-password") && strcontains(local.startup, "docker login")
    error_message = "비밀은 시작 때 읽음, Artifact Registry 로그인"
  }
  assert {
    condition     = strcontains(local.startup, "--entrypoint '/app/server'") && strcontains(local.startup, "'--x'") && strcontains(local.startup, "-p 8080:8080")
    error_message = "command 는 entrypoint + 나머지 인자, 포트 전달"
  }
}

run "reject_bad_account_id" {
  command = plan
  variables {
    cfg = {
      id        = "a"
      name      = "a"
      role_name = "x"
      image     = "x@sha256:abababababababababababababababababababababababababababababababab"
      instances = 1
      identity  = "a"
    }
  }
  expect_failures = [var.cfg]
}
