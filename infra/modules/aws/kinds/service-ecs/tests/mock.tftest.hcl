# I9: service-ecs 모듈 흉내 시험 (자원 안 만듦: mock_provider). Fargate 크기 고르기·자동 확장 켜기·검증
mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "000000000000" }
  }
}

variables {
  cluster_arn                   = "arn:aws:ecs:ap-northeast-2:000000000000:cluster/shop"
  subnet_ids                    = ["subnet-a", "subnet-b"]
  security_group_ids            = ["sg-1"]
  boundary_arn                  = "arn:aws:iam::000000000000:policy/platform-app-boundary"
  secret_arns                   = { "platform/t/shop/shop-db" = "arn:aws:secretsmanager:ap-northeast-2:000000000000:secret:platform/t/shop/shop-db-AbCdEf" }
  service_connect_namespace_arn = "arn:aws:servicediscovery:ap-northeast-2:000000000000:namespace/ns-1"
  region                        = "ap-northeast-2"
  cfg = {
    id             = "shop-api"
    name           = "app-shop-api-1a2b"
    role_name      = "app-shopapi-1a2b"
    image          = "000000000000.dkr.ecr.ap-northeast-2.amazonaws.com/shop-api@sha256:abababababababababababababababababababababababababababababababab"
    cpu_milli      = 500
    mem_mib        = 1024
    port           = 8080
    min_instances  = 2
    max_instances  = 6
    target_cpu_pct = 70
    health_path    = "/healthz"
    env_json       = "[{\"name\":\"LOG_LEVEL\",\"value\":\"info\"}]"
    secrets_json   = "[{\"name\":\"DATABASE_PASSWORD\",\"secret\":\"platform/t/shop/shop-db\",\"key\":\"password\"}]"
    identity       = "shop-api"
    public         = true
  }
}

run "fargate_size_and_autoscale" {
  command = plan
  assert {
    condition     = output.cpu_units == 512 && output.mem_mib == 1024
    error_message = "500m·1024Mi → Fargate 512/1024"
  }
  assert {
    condition     = output.autoscale
    error_message = "min<max + CPU 목표 → 자동 확장"
  }
  assert {
    condition     = aws_ecs_service.app.desired_count == 2
    error_message = "desired = min"
  }
}

run "fixed_without_target" {
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
    condition     = !output.autoscale && output.cpu_units == 256 && output.mem_mib == 512
    error_message = "크기 모르면 가장 작은 조합, 자동 확장 없음"
  }
}

run "reject_tag_image" {
  command = plan
  variables {
    cfg = {
      id            = "x"
      name          = "x"
      role_name     = "app-x"
      image         = "r/x:1.0"
      min_instances = 1
      max_instances = 1
      identity      = "x"
    }
  }
  expect_failures = [var.cfg]
}

# TA13: 역할 둘(경계 붙음)·비밀 valueFrom = 진짜 ARN + JSON 키·Service Connect 이름 = IR id
run "roles_secrets_service_connect" {
  command = plan
  assert {
    condition     = aws_iam_role.task.name == "app-shopapi-1a2b" && aws_iam_role.exec.name == "app-shopapi-1a2b-ex" && aws_iam_role.exec.permissions_boundary == var.boundary_arn
    error_message = "task·exec 역할 이름·경계"
  }
  assert {
    condition     = jsondecode(aws_ecs_task_definition.app.container_definitions)[0].secrets[0].valueFrom == "arn:aws:secretsmanager:ap-northeast-2:000000000000:secret:platform/t/shop/shop-db-AbCdEf:password::"
    error_message = "valueFrom = 그릇 ARN:키::"
  }
  assert {
    condition     = aws_ecs_service.app.service_connect_configuration[0].service[0].client_alias[0].dns_name == "shop-api" && aws_ecs_service.app.service_connect_configuration[0].service[0].client_alias[0].port == 8080
    error_message = "Service Connect 이름 = IR id, 포트 그대로"
  }
}

run "reject_role_name" {
  command = plan
  variables {
    cfg = {
      id            = "x"
      name          = "x"
      role_name     = "x-role"
      image         = "r/x@sha256:abababababababababababababababababababababababababababababababab"
      min_instances = 1
      max_instances = 1
      identity      = "x"
    }
  }
  expect_failures = [var.cfg]
}
