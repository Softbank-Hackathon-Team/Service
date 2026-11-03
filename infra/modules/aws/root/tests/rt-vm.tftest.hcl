# RUNTIMEMAP v2: VM(EC2) 연결 흉내 시험 (자원 안 만듦). env 조각 합치기·비밀 그릇·DB 가 VM 보안 그룹을 받음·ECS 자원 0 + 거부
mock_provider "aws" {
  mock_data "aws_ssm_parameter" {
    defaults = { value = "ami-0123456789abcdef0" }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
}
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
  vm_json = jsonencode([
    { id           = "shop-api", name = "shopapi-1a2b3c", role_name = "app-shopapi-1a2b3c", image = "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/api@sha256:abababababababababababababababababababababababababababababababab",
      command_json = null, args_json = jsonencode(["--serve"]), cpu_milli = 3000, mem_mib = 6000, port = 8080, instances = 2, health_path = "/healthz",
      env_json = jsonencode([
        { name = "LOG_LEVEL", parts = [{ lit = "info", ref = null }] },
        { name = "DB_URL", parts = [{ lit = "pg://", ref = null }, { lit = null, ref = "shop-db.host" }, { lit = ":", ref = null }, { lit = null, ref = "shop-db.port" }] },
      ]),
      secrets_json = jsonencode([{ name = "DATABASE_PASSWORD", secret = "platform/t-aaaa1111/shop/shop-db", key = "password" }]),
    identity = "shop-api", public = true },
  ])
}

run "vm_wired" {
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
    condition     = length(module.vm) == 1 && length(aws_security_group.svc) == 1
    error_message = "VM 모듈 1개 + DB 가 받아 줄 보안 그룹 하나"
  }
  assert {
    condition     = length(aws_ecs_cluster.svc) == 0 && length(aws_service_discovery_http_namespace.svc) == 0 && length(module.service) == 0
    error_message = "VM 만 있으면 ECS 자원 0"
  }
  assert {
    condition     = jsondecode(local.vm_cfg["shop-api"].env_json)[1].value == "pg://db.example.internal:5432" && jsondecode(local.vm_cfg["shop-api"].env_json)[0].value == "info"
    error_message = "확정값 조각은 그대로, ref 는 DB link 출력으로"
  }
  assert {
    condition     = keys(aws_secretsmanager_secret.svc) == ["platform/t-aaaa1111/shop/shop-db"]
    error_message = "비밀 그릇 = VM 이 쓰는 이름"
  }
}

run "no_vm_unchanged" {
  command = plan
  variables {
    vm_json = "[]"
  }
  assert {
    condition     = length(module.vm) == 0 && length(aws_security_group.svc) == 0
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
