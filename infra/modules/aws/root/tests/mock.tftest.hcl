# 진짜 AWS 없이 plan 만: 고정 루트 + kinds 모양 확인 (정상 + 거부). 자원은 안 만든다
mock_provider "aws" {
  mock_data "aws_eks_cluster" {
    defaults = {
      endpoint              = "https://ABC.gr7.ap-northeast-2.eks.amazonaws.com"
      certificate_authority = [{ data = "bW9jaw==" }]
      vpc_config            = [{ cluster_security_group_id = "sg-0123456789abcdef0" }]
    }
  }
  mock_data "aws_eks_cluster_auth" {
    defaults = { token = "mock-token" }
  }
}
mock_provider "kubernetes" {}

variables {
  expected_account_id   = "123456789012"
  region                = "ap-northeast-2"
  app_name              = "shop"
  tenant_id             = "t-aaaa1111"
  cluster_name          = "platform-eks"
  vpc_id                = "vpc-0123456789abcdef0"
  db_subnet_ids_json    = "[\"subnet-a\",\"subnet-b\"]"
  k8s_namespace         = "app-shop"
  app_role_boundary_arn = "arn:aws:iam::123456789012:policy/platform-app-boundary"
  postgres_json = jsonencode([
    { id = "shop-db", name = "shop-db-ab12", major_version = "16", storage_gb = 20, storage_max_gb = null, instance_class = null, ha = null, read_replicas = null, parameters_json = "{\"max_connections\":200}", logical_replication = true, allow_from_json = "[\"web\",\"api\"]", public = false, peer_cidrs_json = "[]", public_subnet_ids_json = null, deletion_protection = true },
  ])
  namespace_json = jsonencode([{ name = "app-shop", quota_cpu_m = null, quota_memory_mi = null }])
  identity_json = jsonencode([
    { id = "api", name = "app-shop-api", service_account = "api", secret_names_json = "[\"JWT_SECRET\",\"SHARED\"]" },
    { id = "web", name = "app-shop-web", service_account = "web", secret_names_json = "[\"SHARED\"]" },
  ])
}

run "plan_all_kinds" {
  command = plan
  assert {
    condition     = module.postgres["shop-db"].link.port == "5432" && module.postgres["shop-db"].public == false
    error_message = "postgres link 출력·비공개 설정이 다름"
  }
  assert {
    condition     = length(module.identity) == 2 && length(module.namespace) == 1
    error_message = "for_each 키(IR id) 별로 신원 2개·네임스페이스 1개여야 함"
  }
  # 같은 이름 시크릿(SHARED)은 id 가 앞선 api 만 만든다
  assert {
    condition     = length(module.identity["api"].secret_arns) == 2 && length(module.identity["web"].secret_arns) == 0
    error_message = "공유 시크릿 그릇은 한 신원만 만들어야 함"
  }
}

run "plan_cluster_less_rds_only" {
  command = plan
  variables {
    cluster_name = ""
  }
  assert {
    condition     = length(module.namespace) == 0 && length(module.identity) == 0 && length(module.postgres) == 1
    error_message = "클러스터 없으면 RDS 만"
  }
  assert {
    condition     = output.cluster_endpoint == "" && output.cluster_ca_certificate == ""
    error_message = "클러스터 없으면 허브 cluster Secret 재료도 빈 값"
  }
}

# Argo CD 허브: 앱 구역 하나에 그룹 platform:deploy → ClusterRole platform-deploy-app 묶음 하나 (실행 그룹 VAP 가 받는 모양 그대로)
run "hub_deploy_binding_in_app_namespace_only" {
  command = plan
  variables {
    hub_deploy = true
  }
  assert {
    condition     = module.namespace["app-shop"].hub_subject == "platform:deploy"
    error_message = "허브 묶음 주체는 그룹 platform:deploy 하나 (고객 svc-deploy 접근 항목 그룹)"
  }
  assert {
    condition     = module.namespace["app-shop"].hub_role_ref.kind == "ClusterRole" && module.namespace["app-shop"].hub_role_ref.name == "platform-deploy-app"
    error_message = "허브 묶음은 ClusterRole platform-deploy-app 만 (실행 그룹이 bind 할 수 있는 유일한 역할)"
  }
  assert {
    condition     = output.cluster_endpoint == "https://ABC.gr7.ap-northeast-2.eks.amazonaws.com" && output.cluster_ca_certificate == "bW9jaw=="
    error_message = "허브 cluster Secret 재료는 도착 EKS 의 주소·CA 그대로"
  }
}

run "hub_deploy_off_by_default" {
  command = plan
  assert {
    condition     = module.namespace["app-shop"].hub_subject == null
    error_message = "hub_deploy 가 꺼져 있으면 허브 묶음을 만들지 않음 (사람이 등록한 목적지만 쓰는 플랫폼)"
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

# 거부: 같은 IR id 두 번 (for_each 키 충돌을 변수 검증이 먼저 막음)
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

# 거부: 역할 이름이 64자 초과 (IR id 를 그대로 쓰면 생기는 사고)
run "reject_long_role_name" {
  command = plan
  variables {
    identity_json = jsonencode([{ id = "api", name = "app-${join("", [for i in range(70) : "a"])}", service_account = "api" }])
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
    condition     = module.cache["sessions"].link.port == "6379" && output.link_outputs["uploads"].name == "shop-uploads-ab12" && output.link_outputs["jobs"].name != ""
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

# JOBMOD: 예약 잡 (EventBridge Scheduler → ECS RunTask). 정상 + 거부
run "plan_jobs" {
  command = plan
  variables {
    job_json = jsonencode([
      { id = "nightly", name = "app-shop-nightly-ab12", schedule = "30 2 * * 1-5", time_zone = "Asia/Seoul", concurrency_policy = null, suspend = null, backoff_limit = 2, active_deadline_sec = null, restart_policy = "OnFailure", image = "r.example/shop@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", command_json = null, args_json = "[\"run\",\"nightly\"]", cpu_milli = 500, mem_mib = 1024, env_json = jsonencode([{ name = "DB_HOST", value = "<tf-output:link.shop-db.host>" }, { name = "MODE", value = "batch" }]), identity = "api" },
      { id = "monthly", name = "app-shop-monthly-cd34", schedule = "0 4 1 * *", time_zone = null, concurrency_policy = "Forbid", suspend = true, backoff_limit = null, active_deadline_sec = 600, restart_policy = null, image = "r.example/shop@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", command_json = null, args_json = null, cpu_milli = null, mem_mib = null, env_json = "[]", identity = "api" },
    ])
  }
  assert {
    condition     = module.job["nightly"].schedule_expression == "cron(30 2 ? * 2-6 *)" && module.job["monthly"].schedule_expression == "cron(0 4 1 * ? *)"
    error_message = "cron 5필드 → EventBridge 변환(요일 1-5 → 2-6, 일·요일 중 하나는 ?)이 다름"
  }
  assert {
    condition     = module.job["nightly"].cpu_units == 512 && module.job["nightly"].mem_mib == 1024 && module.job["monthly"].cpu_units == 256 && module.job["monthly"].mem_mib == 512
    error_message = "Fargate CPU·메모리 조합이 다름 (500m → 512, null → 256/512)"
  }
  assert {
    condition     = length(module.job["monthly"].unmapped_fields) == 2 && module.job["monthly"].unmapped_fields.concurrency_policy == "Forbid" && contains(keys(module.job["monthly"].unmapped_fields), "active_deadline_sec")
    error_message = "ECS 가 못 옮기는 칸(Forbid·active_deadline_sec)은 unmapped_fields 에 나와야 함"
  }
  assert {
    condition     = contains(keys(module.job["nightly"].unmapped_fields), "restart_policy") && !contains(keys(module.job["nightly"].unmapped_fields), "concurrency_policy")
    error_message = "restart_policy OnFailure 는 unmapped, 없는 칸은 안 나와야 함"
  }
}

run "plan_jobs_default_empty" {
  command = plan
  assert {
    condition     = length(module.job) == 0 && length(aws_ecs_cluster.svc) == 0
    error_message = "기본값에선 잡도 ECS 공용 자원도 없어야 함"
  }
}

# 거부: 날짜·요일 둘 다 정한 schedule
run "reject_job_dom_and_dow" {
  command = plan
  variables {
    job_json = jsonencode([{ id = "x", name = "app-shop-x-ab12", schedule = "0 4 1 * 1", image = "r.example/shop@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", env_json = "[]", identity = "api" }])
  }
  expect_failures = [var.job_json]
}

# 거부: 이름이 app- 로 시작하지 않음 / 같은 id 두 번 / 못 푼 자리표시
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
