# kind: service (AWS ECS Fargate 서비스). 관리형 컨테이너 출발(ECS)을 ECS 로 옮길 때 (재현성 기본, 설계 23번 ②).
# 변수 모양 = packages/contracts/src/tf-kinds.ts ServiceTfVars. 상태: 카탈로그만 — 루트(aws/root)에 아직 안 붙음 (Builder 가 capability 로 막음)
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
}
# env 층 사실 (TF_FACT_*) — 클러스터·서브넷·보안 그룹은 env 층이 만든다 (11/2 회의 D2: 모듈화는 app 층만)
variable "cluster_arn" { type = string }
variable "subnet_ids" { type = list(string) }
variable "security_group_ids" { type = list(string) }
variable "execution_role_arn" { type = string }
variable "task_role_arn" { type = string } # identity 인스턴스 출력
variable "region" { type = string }
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
        valueFrom = "arn:aws:secretsmanager:${var.region}:${data.aws_caller_identity.me.account_id}:secret:${s.secret}:${s.key}::"
      }]
      portMappings = var.cfg.port == null ? [] : [{ containerPort = var.cfg.port, protocol = "tcp" }]
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
}

data "aws_caller_identity" "me" {}

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
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = var.task_role_arn
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
