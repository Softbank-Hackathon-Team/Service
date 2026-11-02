# TA13: 관리형 컨테이너(ECS) 연결 흉내 시험 (자원 안 만듦). env 조각 합치기·비밀 그릇·DB 가 ECS 보안 그룹을 받음 + 거부
mock_provider "aws" {}
mock_provider "kubernetes" {}

variables {
  expected_account_id   = "123456789012"
  region                = "ap-northeast-2"
  app_name              = "shop"
  tenant_id             = "t-aaaa1111"
  cluster_name          = ""
  vpc_id                = "vpc-0123456789abcdef0"
  db_subnet_ids_json    = "[\"subnet-a\",\"subnet-b\"]"
  k8s_namespace         = "app-shop"
  app_role_boundary_arn = "arn:aws:iam::123456789012:policy/platform-app-boundary"
  postgres_json = jsonencode([
    { id = "shop-db", name = "shop-db-ab12", major_version = "16", storage_gb = 20, storage_max_gb = null, instance_class = null, ha = null, read_replicas = null, parameters_json = "{}", logical_replication = true, allow_from_json = "[]", public = false, peer_cidrs_json = "[]", public_subnet_ids_json = null, deletion_protection = true },
  ])
  service_json = jsonencode([
    { id           = "shop-api", name = "shopapi-1a2b3c", role_name = "app-shopapi-1a2b3c", image = "r/api@sha256:abababababababababababababababababababababababababababababababab",
      command_json = null, args_json = null, cpu_milli = 500, mem_mib = 1024, port = 8080, min_instances = 2, max_instances = 6, target_cpu_pct = 70, health_path = "/healthz",
      env_json = jsonencode([
        { name = "LOG_LEVEL", parts = [{ lit = "info", ref = null }] },
        { name = "DB_URL", parts = [{ lit = "pg://", ref = null }, { lit = null, ref = "shop-db.host" }, { lit = ":", ref = null }, { lit = null, ref = "shop-db.port" }] },
      ]),
      secrets_json = jsonencode([{ name = "DATABASE_PASSWORD", secret = "platform/t-aaaa1111/shop/shop-db", key = "password" }]),
    identity = "shop-api", public = true },
    { id           = "shop-web", name = "shopweb-1a2b3c", role_name = "app-shopweb-1a2b3c", image = "r/web@sha256:abababababababababababababababababababababababababababababababab",
      command_json = null, args_json = null, cpu_milli = null, mem_mib = null, port = 8080, min_instances = 2, max_instances = 2, target_cpu_pct = null, health_path = null,
      env_json     = jsonencode([{ name = "API_URL", parts = [{ lit = "http://", ref = null }, { lit = null, ref = "shop-api.host" }, { lit = ":8080", ref = null }] }]),
    secrets_json = "[]", identity = "shop-web", public = true },
  ])
}

# DB 주소는 plan 에선 아직 모름 → postgres 모듈 출력을 고정값으로 덮어 조각 합치기를 plan 에서 확인
run "ecs_services_wired" {
  command = plan
  override_module {
    target          = module.postgres["shop-db"]
    override_during = plan
    outputs = {
      link               = { host = "db.example.internal", port = "5432", url = "postgresql://db.example.internal:5432/shop", user = "app" }
      password_secret    = "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:rds!db-1"
      address            = "db.example.internal"
      public             = false
      ca_cert_identifier = "rds-ca-rsa2048-g1"
    }
  }
  assert {
    condition     = length(module.service) == 2 && length(aws_ecs_cluster.svc) == 1 && length(aws_service_discovery_http_namespace.svc) == 1
    error_message = "서비스 2개 + 공용 클러스터·이름 공간 하나"
  }
  assert {
    condition     = jsondecode(local.service_cfg["shop-web"].env_json)[0].value == "http://shop-api:8080"
    error_message = "서비스 주소 = Service Connect 이름(IR id)"
  }
  assert {
    condition     = jsondecode(local.service_cfg["shop-api"].env_json)[0].value == "info" && jsondecode(local.service_cfg["shop-api"].env_json)[1].value == "pg://db.example.internal:5432"
    error_message = "확정값 조각은 그대로, ref 는 DB link 출력으로"
  }
  assert {
    condition     = keys(aws_secretsmanager_secret.svc) == ["platform/t-aaaa1111/shop/shop-db"]
    error_message = "비밀 그릇 = 서비스가 쓰는 이름 합집합"
  }
  assert {
    condition     = length(module.identity) == 0 && length(module.namespace) == 0
    error_message = "클러스터 없으면 k8s 쪽 없음"
  }
}

run "no_service_unchanged" {
  command = plan
  variables {
    service_json = "[]"
  }
  assert {
    condition     = length(aws_ecs_cluster.svc) == 0 && length(aws_security_group.svc) == 0 && length(module.service) == 0
    error_message = "서비스가 없으면 ECS 자원 0 (기존 계획 그대로)"
  }
}

run "reject_duplicate_id" {
  command = plan
  variables {
    service_json = "[{\"id\":\"a\"},{\"id\":\"a\"}]"
  }
  expect_failures = [var.service_json]
}
