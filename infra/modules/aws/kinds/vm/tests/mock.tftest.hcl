# RUNTIMEMAP v2: kinds/vm(EC2) 모듈 단독 시험 (자원 안 만듦). 머신 고르기·user-data 내용·권한 경계 + 거부
mock_provider "aws" {
  mock_data "aws_ssm_parameter" {
    defaults = { value = "ami-0123456789abcdef0" }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
}

variables {
  cfg = {
    id           = "shop-api"
    name         = "shopapi-1a2b3c"
    role_name    = "app-shopapi-1a2b3c"
    image        = "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/api@sha256:abababababababababababababababababababababababababababababababab"
    args_json    = "[\"--serve\"]"
    cpu_milli    = 3000
    mem_mib      = 6000
    port         = 8080
    instances    = 2
    env_json     = "[{\"name\":\"LOG_LEVEL\",\"value\":\"info\"}]"
    secrets_json = "[{\"name\":\"DATABASE_PASSWORD\",\"secret\":\"platform/t/shop/db\",\"key\":\"password\"}]"
    identity     = "shop-api"
    public       = false
  }
  subnet_ids         = ["subnet-a", "subnet-b"]
  security_group_ids = ["sg-0123"]
  region             = "ap-northeast-2"
  boundary_arn       = "arn:aws:iam::123456789012:policy/platform-app-boundary"
  secret_arns        = { "platform/t/shop/db" = "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:platform/t/shop/db-AbCdEf" }
}

run "vm_shape_and_install" {
  command = plan
  assert {
    condition     = output.machine_type == "m6i.xlarge" && length(aws_instance.app) == 2
    error_message = "cpu 3000·mem 6000 이상 가장 작은 m6i.xlarge (t3 는 2vCPU), 대수 = instances"
  }
  assert {
    condition     = strcontains(local.user_data, "systemctl enable --now platform-shop-api.service") && strcontains(local.user_data, "LOG_LEVEL=info")
    error_message = "user-data 가 systemd 유닛과 env 를 깔음"
  }
  assert {
    condition     = strcontains(local.user_data, "aws secretsmanager get-secret-value") && !strcontains(local.user_data, "hunter2") && strcontains(local.user_data, "docker login")
    error_message = "비밀은 시작 때 읽음 (값은 user-data 에 없음), ECR 로그인"
  }
  assert {
    condition     = strcontains(local.user_data, "-p 8080:8080") && strcontains(local.user_data, "'--serve'")
    error_message = "포트·args 전달"
  }
  assert {
    condition     = aws_iam_role.app.permissions_boundary == "arn:aws:iam::123456789012:policy/platform-app-boundary" && startswith(aws_iam_role.app.name, "app-")
    error_message = "역할은 app- 이름 + 권한 경계"
  }
}

run "reject_unpinned_image" {
  command = plan
  variables {
    cfg = {
      id        = "a"
      name      = "a"
      role_name = "app-a"
      image     = "x:latest"
      instances = 1
      identity  = "a"
    }
  }
  expect_failures = [var.cfg]
}
