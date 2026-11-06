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

# B-2 (나): 그릇 이름(프로젝트 번호)은 apply 뒤에야 안다. 그래도 ESO 바인딩 키는 plan 에서 정해져야 for_each 가 된다
run "eso_binding_keys_known_before_apply" {
  command = plan
  variables {
    ingress_secret_names_json = jsonencode(["cloudflared-token"])
  }
  assert {
    condition     = toset(keys(google_secret_manager_secret_iam_member.eso)) == toset(["postgres/shop-db", "identity/api/JWT_SECRET", "identity/api/SHARED", "ingress/cloudflared-token"])
    error_message = "ESO 바인딩 키 = 그릇마다 하나, 값(그릇 이름)이 아직 없어도 plan 됨"
  }
}

run "hub_deploy_in_app_namespace_only" {
  command = plan
  variables {
    hub_principal = "t-0123456789abcdef0123456789ab@platform-proj.iam.gserviceaccount.com"
  }
  assert {
    condition     = module.namespace["app-shop"].hub_subject == var.hub_principal
    error_message = "앱 구역 RoleBinding 주체는 회사 전용 플랫폼 SA"
  }
  assert {
    condition     = !contains(module.namespace["app-shop"].hub_role_resources, "secrets") && !contains(module.namespace["app-shop"].hub_role_resources, "rolebindings")
    error_message = "허브 Role 에 Secret·RBAC 쓰기가 없어야 함"
  }
  assert {
    condition     = toset(module.namespace["app-shop"].hub_role_wildcard_verbs) == toset(["get", "list", "watch"])
    error_message = "허브 Role 의 모든 종류(*) 규칙은 읽기(get·list·watch)만 (Argo CD 캐시용)"
  }
}

run "hub_deploy_off_by_default" {
  command = plan
  assert {
    condition     = module.namespace["app-shop"].hub_subject == null
    error_message = "hub_principal 이 비면 허브 권한을 만들지 않음"
  }
}

run "hub_principal_rejects_other_identity" {
  command = plan
  variables {
    hub_principal = "someone@example.com"
  }
  expect_failures = [var.hub_principal]
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

# #317 가: 앱 신원은 GSA 없이 KSA 가 주체. 비밀 읽기·옮긴 권한 바인딩이 모두 그 주체에 간다 (SA 단위 setIamPolicy 없음)
run "identity_bindings_use_ksa_principal" {
  command = plan
  variables {
    object_store_json = jsonencode([{ id = "uploads", name = "app-shop-uploads-ab12", versioning = true }])
    identity_json = jsonencode([
      { id = "api", name = "app-shop-api", service_account = "api", secret_names_json = "[\"JWT_SECRET\"]",
      grants_json = jsonencode([{ kind = "objectStore", target = "uploads", role = "roles/storage.objectViewer", scope = "bucket" }]) },
      { id = "web", name = "app-shop-web", service_account = "web" },
    ])
  }
  assert {
    condition     = module.identity["api"].principal == "principal://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/demo-project.svc.id.goog/subject/ns/app-shop/sa/api"
    error_message = "신원 주체는 KSA app-shop/api (비밀 읽기 바인딩은 kinds/identity/tests 가 본다)"
  }
  assert {
    condition     = google_storage_bucket_iam_member.grant["api/uploads/roles/storage.objectViewer"].member == module.identity["api"].principal
    error_message = "옮긴 권한(버킷) 바인딩 주체도 KSA 주체"
  }
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

# JOBMOD: 예약 잡 (Cloud Scheduler → Cloud Run job). 정상 + 거부
run "plan_jobs" {
  command = plan
  variables {
    job_json = jsonencode([
      { id = "nightly", name = "app-shop-nightly-ab12", schedule = "30 2 * * 1-5", time_zone = "Asia/Seoul", concurrency_policy = null, suspend = null, backoff_limit = 2, active_deadline_sec = null, restart_policy = "OnFailure", image = "r.example/shop@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", command_json = null, args_json = "[\"run\",\"nightly\"]", cpu_milli = 500, mem_mib = 1024, env_json = jsonencode([{ name = "DB_HOST", value = "<tf-output:link.shop-db.host>" }, { name = "MODE", value = "batch" }]), identity = "api" },
      { id = "monthly", name = "app-shop-monthly-cd34", schedule = "0 4 1 * *", time_zone = null, concurrency_policy = "Forbid", suspend = true, backoff_limit = null, active_deadline_sec = 600, restart_policy = null, image = "r.example/shop@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", command_json = null, args_json = null, cpu_milli = null, mem_mib = null, env_json = "[]", identity = "api" },
    ])
  }
  assert {
    condition     = module.job["nightly"].cpu == 1 && module.job["nightly"].mem_mib == 1024 && module.job["monthly"].cpu == 1 && module.job["monthly"].mem_mib == 512
    error_message = "Cloud Run CPU·메모리가 다름 (500m → 1, null → 1/512)"
  }
  assert {
    condition     = module.job["nightly"].max_retries == 2 && module.job["monthly"].max_retries == 3
    error_message = "재시도 횟수가 다름 (backoff_limit 2, 없으면 Cloud Run 기본 3)"
  }
  assert {
    condition     = module.job["monthly"].unmapped_fields.concurrency_policy == "Forbid" && length(module.job["nightly"].unmapped_fields) == 0
    error_message = "Cloud Run 이 못 옮기는 칸(Forbid)은 unmapped_fields 에 나와야 함"
  }
}

run "plan_jobs_default_empty" {
  command = plan
  assert {
    condition     = length(module.job) == 0
    error_message = "기본값에선 잡이 없어야 함"
  }
}

run "reject_job_bad_name" {
  command = plan
  variables {
    job_json = jsonencode([{ id = "x", name = "shop-x", schedule = "0 4 * * *", image = "r.example/shop@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", env_json = "[]", identity = "api" }])
  }
  expect_failures = [var.job_json]
}
run "reject_job_duplicate_id" {
  command = plan
  variables {
    job_json = jsonencode([
      { id = "x", name = "app-shop-x-ab12", schedule = "0 4 * * *", image = "r.example/shop@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", env_json = "[]", identity = "api" },
      { id = "x", name = "app-shop-y-ab12", schedule = "0 5 * * *", image = "r.example/shop@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", env_json = "[]", identity = "api" },
    ])
  }
  expect_failures = [var.job_json]
}
run "reject_job_unresolved_placeholder" {
  command = plan
  variables {
    job_json = jsonencode([{ id = "x", name = "app-shop-x-ab12", schedule = "0 4 * * *", image = "r.example/shop@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", env_json = jsonencode([{ name = "A", value = "<tf-output:link.nope.host>" }]), identity = "api" }])
  }
  expect_failures = [terraform_data.job_env]
}

# 관리자 계정은 앱 계정과 이름·비밀이 다르고 이전(인스턴스 이름)마다 정해진다. app_login_sql 이면 앱 API 사용자를 만들지 않는다
run "admin_user_separate_from_app" {
  command = plan
  assert {
    condition     = output.db_admin_username == "svc_admin_${substr(sha256("shop-db-ab12"), 0, 10)}" && output.db_admin_username != output.db_username
    error_message = "관리자 계정 이름이 인스턴스 이름 해시가 아니거나 앱 계정과 같다"
  }
  assert {
    condition     = output.db_admin_password_secret_id == "app-shop-shop-db-admin-db-password" && output.db_password_secret_id == "app-shop-shop-db-db-password"
    error_message = "관리자 비밀 그릇이 앱 비밀 그릇과 따로여야 한다 (이름 끝 -db-password)"
  }
  assert {
    condition     = length(module.postgres["shop-db"].link.user) > 0 && output.db_username == "app"
    error_message = "앱 계정 출력은 그대로"
  }
}
