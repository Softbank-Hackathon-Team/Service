# kind: service (AWS ECS Fargate 서비스). 관리형 컨테이너 출발(ECS)을 ECS 로 옮길 때 (재현성 기본, 설계 23번 ②).
# 변수 모양 = packages/contracts/src/tf-kinds.ts ServiceTfVars. TA13: 루트(aws/root) service_json 으로 붙음. env_json 은 루트가 조각을 합친 [{name, value}]
# 원칙: null 이면 상품 기본값(DRAFT 표시), IR 값은 지어내지 않음. 비밀 값은 모듈이 모른다 (Secrets Manager ARN 으로만 넘김)
# TODO(human): N8 — ECS 출발의 기본 도착 실행 방식 (ECS 유지 vs EKS). 이 모듈은 "유지" 쪽
terraform {
  required_version = ">= 1.11"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "cfg" {
  type = object({
    id             = string
    name           = string
    role_name      = string
    image          = string
    command_json   = optional(string)
    args_json      = optional(string)
    cpu_milli      = optional(number)
    mem_mib        = optional(number)
    port           = optional(number)
    min_instances  = number
    max_instances  = number
    target_cpu_pct = optional(number)
    health_path    = optional(string)
    env_json       = optional(string, "[]")
    secrets_json   = optional(string, "[]")
    identity       = string
    public         = optional(bool, false)
  })
  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.cfg.image))
    error_message = "이미지는 digest 로 고정 (재현성)."
  }
  validation {
    condition     = var.cfg.min_instances >= 0 && var.cfg.max_instances >= var.cfg.min_instances && var.cfg.max_instances <= 100
    error_message = "0 <= min_instances <= max_instances <= 100."
  }
  validation {
    condition     = length(var.cfg.name) >= 1 && length(var.cfg.name) <= 255
    error_message = "ECS 서비스 이름은 1~255자."
  }
  validation {
    condition     = startswith(var.cfg.role_name, "app-") && length(var.cfg.role_name) <= 61
    error_message = "역할 이름은 app- 로 시작, 61자 이하 (실행 역할은 뒤에 -ex)."
  }
}
# env 층 사실 (TF_FACT_*) — 클러스터·서브넷·보안 그룹은 env 층이 만든다 (11/2 회의 D2: 모듈화는 app 층만)
variable "cluster_arn" { type = string }
variable "subnet_ids" { type = list(string) }
variable "security_group_ids" { type = list(string) }
variable "region" { type = string }
# TA13: 역할 두 개(앱이 쓰는 task 역할 + 이미지·로그·비밀을 읽는 실행 역할)를 이 모듈이 만든다. 둘 다 플랫폼 권한 경계를 붙임
# TODO(human): 경계(platform-app-boundary)가 지금은 비밀 읽기만 허용 → 실행 역할의 ECR pull·로그 쓰기가 경계에 막힘. 경계 넓히기는 보안 승인 몫
variable "boundary_arn" { type = string }
# 비밀 이름 → Secrets Manager ARN (루트가 만든 그릇). valueFrom 은 진짜 ARN 이어야 JSON 키를 고를 수 있다
variable "secret_arns" {
  type    = map(string)
  default = {}
}
# 서비스끼리 부르는 이름 (Service Connect, dns = IR id). null 이면 안 켬
variable "service_connect_namespace_arn" {
  type    = string
  default = null
}
# 입구가 이 서비스로 오면 ALB 대상 그룹 (null = 내부 전용)
variable "target_group_arn" {
  type    = string
  default = null
}
variable "tags" {
  type    = map(string)
  default = {}
}

locals {
  # DRAFT(ai): Fargate 는 CPU·메모리 조합이 정해져 있다 → IR 값 이상인 가장 작은 조합. 모르면 256/512 (가장 작은 크기)
  cpu_units = var.cfg.cpu_milli == null ? 256 : [for c in [256, 512, 1024, 2048, 4096] : c if c >= ceil(var.cfg.cpu_milli * 1024 / 1000)][0]
  mem_floor = { 256 = 512, 512 = 1024, 1024 = 2048, 2048 = 4096, 4096 = 8192 }
  mem_mib   = max(local.mem_floor[local.cpu_units], var.cfg.mem_mib == null ? 0 : ceil(var.cfg.mem_mib / 1024) * 1024)
  env       = jsondecode(coalesce(var.cfg.env_json, "[]"))
  secrets   = jsondecode(coalesce(var.cfg.secrets_json, "[]"))
  container = merge(
    {
      name        = var.cfg.id
      image       = var.cfg.image
      essential   = true
      environment = [for e in local.env : { name = e.name, value = e.value }]
      # Secrets Manager 이름 + JSON 키 → valueFrom ARN 꼴 (값은 ECS 가 실행 때 읽음)
      secrets = [for s in local.secrets : {
        name      = s.name
        valueFrom = "${var.secret_arns[s.secret]}:${s.key}::"
      }]
      portMappings = var.cfg.port == null ? [] : [{ name = local.port_name, containerPort = var.cfg.port, protocol = "tcp" }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.app.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = var.cfg.id
        }
      }
    },
    var.cfg.command_json == null ? {} : { entryPoint = jsondecode(var.cfg.command_json) },
    var.cfg.args_json == null ? {} : { command = jsondecode(var.cfg.args_json) },
  )
  autoscale = var.cfg.target_cpu_pct != null && var.cfg.max_instances > var.cfg.min_instances
  port_name = "p${coalesce(var.cfg.port, 0)}"
  # 실행 역할이 읽을 비밀 ARN (이 서비스가 쓰는 것만)
  read_arns = distinct([for s in local.secrets : var.secret_arns[s.secret]])
  trust = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

data "aws_caller_identity" "me" {}

resource "aws_iam_role" "task" {
  name                 = var.cfg.role_name
  permissions_boundary = var.boundary_arn
  assume_role_policy   = local.trust
  tags                 = var.tags
}

resource "aws_iam_role" "exec" {
  name                 = "${var.cfg.role_name}-ex"
  permissions_boundary = var.boundary_arn
  assume_role_policy   = local.trust
  tags                 = var.tags
}

# 관리형 정책(AmazonECSTaskExecutionRolePolicy)을 붙이지 않고 인라인으로 (실행 역할 정책은 AttachRolePolicy 금지 — permissions-lint)
resource "aws_iam_role_policy" "exec" {
  name = "pull-log-secrets"
  role = aws_iam_role.exec.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
      { Effect = "Allow", Action = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], Resource = "arn:aws:ecr:${var.region}:${data.aws_caller_identity.me.account_id}:repository/*" },
      { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.app.arn}:*" },
      ], length(local.read_arns) == 0 ? [] : [
      { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = local.read_arns },
    ])
  })
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/platform/ecs/${var.cfg.name}"
  retention_in_days = 14 # DRAFT(ai): 플랫폼 기본 (IR 에 없음)
  tags              = var.tags
}

resource "aws_ecs_task_definition" "app" {
  family                   = var.cfg.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(local.cpu_units)
  memory                   = tostring(local.mem_mib)
  execution_role_arn       = aws_iam_role.exec.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions    = jsonencode([local.container])
  tags                     = var.tags
}

resource "aws_ecs_service" "app" {
  name            = var.cfg.name
  cluster         = var.cluster_arn
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = var.cfg.min_instances
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = var.security_group_ids
    assign_public_ip = false
  }
  dynamic "load_balancer" {
    for_each = var.target_group_arn == null || var.cfg.port == null ? [] : [1]
    content {
      target_group_arn = var.target_group_arn
      container_name   = var.cfg.id
      container_port   = var.cfg.port
    }
  }
  dynamic "service_connect_configuration" {
    for_each = var.service_connect_namespace_arn == null ? [] : [1]
    content {
      enabled   = true
      namespace = var.service_connect_namespace_arn
      # 받는 포트가 있으면 IR id 로 불림 (다른 서비스의 env 주소 = <id>:<port>). 없으면(워커) 부르기만
      dynamic "service" {
        for_each = var.cfg.port == null ? [] : [1]
        content {
          port_name      = local.port_name
          discovery_name = var.cfg.id
          client_alias {
            port     = var.cfg.port
            dns_name = var.cfg.id
          }
        }
      }
    }
  }
  # 자동 확장이 desired_count 를 바꾸므로 다음 plan 에서 되돌리지 않게
  lifecycle {
    ignore_changes = [desired_count]
  }
  tags = var.tags
}

resource "aws_appautoscaling_target" "app" {
  count              = local.autoscale ? 1 : 0
  service_namespace  = "ecs"
  resource_id        = "service/${element(split("/", var.cluster_arn), length(split("/", var.cluster_arn)) - 1)}/${aws_ecs_service.app.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.cfg.min_instances
  max_capacity       = var.cfg.max_instances
}

resource "aws_appautoscaling_policy" "cpu" {
  count              = local.autoscale ? 1 : 0
  name               = "${var.cfg.name}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = "ecs"
  resource_id        = aws_appautoscaling_target.app[0].resource_id
  scalable_dimension = aws_appautoscaling_target.app[0].scalable_dimension
  target_tracking_scaling_policy_configuration {
    target_value = var.cfg.target_cpu_pct
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

output "service_name" { value = aws_ecs_service.app.name }
output "task_definition_arn" { value = aws_ecs_task_definition.app.arn }
output "cpu_units" { value = local.cpu_units }
output "mem_mib" { value = local.mem_mib }
output "autoscale" { value = local.autoscale }
output "task_role_arn" { value = aws_iam_role.task.arn }
output "execution_role_arn" { value = aws_iam_role.exec.arn }
