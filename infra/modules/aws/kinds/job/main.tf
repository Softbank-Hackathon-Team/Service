# kind: job (AWS ECS 예약 작업: EventBridge Scheduler → ECS RunTask, Fargate). 관리형 컨테이너 출발의 예약 잡을 ECS 로 옮길 때.
# 변수 모양 = packages/contracts/src/tf-kinds.ts JobTfVars. 루트(aws/root)의 job_json 으로 붙음. env_json 은 루트가 자리표시를 푼 [{name, value}]
# 원칙: null 이면 상품 기본값(DRAFT 표시), IR 값은 지어내지 않음. ECS 가 못 옮기는 칸은 조용히 버리지 않고 output unmapped_fields 에 적는다
# TODO(human): 비밀(secrets)은 JobTfVars 에 칸이 없어 이 모듈은 비밀 없는 잡만 그린다 — 비밀이 필요한 잡은 칸을 더하거나 service 와 같은 secrets_json 이 필요
terraform {
  required_version = ">= 1.11"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "cfg" {
  type = object({
    id                  = string
    name                = string
    schedule            = string
    time_zone           = optional(string)
    concurrency_policy  = optional(string)
    suspend             = optional(bool)
    backoff_limit       = optional(number)
    active_deadline_sec = optional(number)
    restart_policy      = optional(string)
    image               = string
    command_json        = optional(string)
    args_json           = optional(string)
    cpu_milli           = optional(number)
    mem_mib             = optional(number)
    env_json            = optional(string, "[]")
    identity            = string
  })
  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.cfg.image))
    error_message = "이미지는 digest 로 고정 (재현성)."
  }
  validation {
    condition     = startswith(var.cfg.name, "app-") && length(var.cfg.name) <= 58
    error_message = "잡 이름은 app- 로 시작, 58자 이하 (역할 이름 = 이름 + -task·-ex·-sch, IAM 64자·app-* 범위)."
  }
  validation {
    condition     = length(split(" ", trimspace(var.cfg.schedule))) == 5
    error_message = "schedule 은 cron 5필드 (IR 그대로)."
  }
  validation {
    # 요일 칸의 간격(/)은 숫자 체계가 달라(cron 0-6, EventBridge 1-7) 옮기지 않는다
    condition     = !strcontains(element(split(" ", trimspace(var.cfg.schedule)), 4), "/")
    error_message = "schedule 요일 칸의 간격(/) 은 아직 못 옮김 (TODO(human))."
  }
  validation {
    # 날짜 칸과 요일 칸을 둘 다 정하면 cron 은 '또는', EventBridge 는 둘 중 하나가 ? 여야 해서 뜻이 달라진다
    condition = (element(split(" ", trimspace(var.cfg.schedule)), 2) == "*" || element(split(" ", trimspace(var.cfg.schedule)), 4) == "*" ||
    element(split(" ", trimspace(var.cfg.schedule)), 2) == "?" || element(split(" ", trimspace(var.cfg.schedule)), 4) == "?")
    error_message = "날짜 칸과 요일 칸을 둘 다 정한 schedule 은 못 옮김 (cron 은 '또는', EventBridge 는 한쪽이 ? )."
  }
  validation {
    condition     = var.cfg.concurrency_policy == null || contains(["Allow", "Forbid", "Replace"], coalesce(var.cfg.concurrency_policy, "Allow"))
    error_message = "concurrency_policy 는 Allow·Forbid·Replace."
  }
  validation {
    condition     = var.cfg.restart_policy == null || contains(["OnFailure", "Never"], coalesce(var.cfg.restart_policy, "Never"))
    error_message = "restart_policy 는 OnFailure·Never."
  }
  validation {
    condition     = var.cfg.backoff_limit == null || (coalesce(var.cfg.backoff_limit, 0) >= 0 && coalesce(var.cfg.backoff_limit, 0) == floor(coalesce(var.cfg.backoff_limit, 0)))
    error_message = "backoff_limit 은 0 이상 정수."
  }
}
# env 층 사실 — ECS 클러스터·서브넷·보안 그룹은 앱 루트가 만들어 넘긴다 (service-ecs 와 같음)
variable "cluster_arn" { type = string }
variable "subnet_ids" { type = list(string) }
variable "security_group_ids" { type = list(string) }
variable "region" { type = string }
variable "boundary_arn" { type = string }
variable "tags" {
  type    = map(string)
  default = {}
}

locals {
  # DRAFT(ai): Fargate 는 CPU·메모리 조합이 정해져 있다 → IR 값 이상인 가장 작은 조합. 모르면 256/512 (service-ecs 와 같은 규칙)
  cpu_units = var.cfg.cpu_milli == null ? 256 : [for c in [256, 512, 1024, 2048, 4096] : c if c >= ceil(var.cfg.cpu_milli * 1024 / 1000)][0]
  mem_floor = { 256 = 512, 512 = 1024, 1024 = 2048, 2048 = 4096, 4096 = 8192 }
  mem_mib   = max(local.mem_floor[local.cpu_units], var.cfg.mem_mib == null ? 0 : ceil(var.cfg.mem_mib / 1024) * 1024)
  env       = jsondecode(coalesce(var.cfg.env_json, "[]"))

  # cron 5필드 → EventBridge Scheduler cron(분 시 일 월 요일 년). 일·요일 중 하나는 ?. 요일 숫자는 cron 0-6(일=0) → EventBridge 1-7(일=1)
  f       = split(" ", trimspace(var.cfg.schedule))
  dow_set = local.f[4] != "*" && local.f[4] != "?"
  dom     = local.dow_set ? "?" : (local.f[2] == "?" ? "*" : local.f[2])
  dow     = local.dow_set ? join("", [for t in regexall("[0-9]|[^0-9]+", local.f[4]) : can(tonumber(t)) ? tostring((tonumber(t) % 7) + 1) : t]) : "?"

  schedule_expression = "cron(${local.f[0]} ${local.f[1]} ${local.dom} ${local.f[3]} ${local.dow} *)"

  container = merge(
    {
      name        = var.cfg.id
      image       = var.cfg.image
      essential   = true
      environment = [for e in local.env : { name = e.name, value = e.value }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.job.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = var.cfg.id
        }
      }
    },
    var.cfg.command_json == null ? {} : { entryPoint = jsondecode(var.cfg.command_json) },
    var.cfg.args_json == null ? {} : { command = jsondecode(var.cfg.args_json) },
  )
  # ECS 예약 작업이 못 옮기는 칸 (조용히 버리지 않고 알림). Builder·precheck 가 읽을 수 있게 output 으로
  unmapped = merge(
    contains(["Forbid", "Replace"], coalesce(var.cfg.concurrency_policy, "Allow")) ? { concurrency_policy = var.cfg.concurrency_policy } : {},
    var.cfg.active_deadline_sec == null ? {} : { active_deadline_sec = tostring(var.cfg.active_deadline_sec) },
    var.cfg.restart_policy == "OnFailure" ? { restart_policy = "OnFailure" } : {},
    var.cfg.backoff_limit == null ? {} : { backoff_limit = "스케줄러 호출 재시도로만 옮김(작업 실패 재시도 아님)" },
  )
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
  name                 = "${var.cfg.name}-task"
  permissions_boundary = var.boundary_arn
  assume_role_policy   = local.trust
  tags                 = var.tags
}

resource "aws_iam_role" "exec" {
  name                 = "${var.cfg.name}-ex"
  permissions_boundary = var.boundary_arn
  assume_role_policy   = local.trust
  tags                 = var.tags
}

# 관리형 정책을 붙이지 않고 인라인으로 (실행 역할 정책은 AttachRolePolicy 금지 — permissions-lint)
resource "aws_iam_role_policy" "exec" {
  name = "pull-log"
  role = aws_iam_role.exec.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
      { Effect = "Allow", Action = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], Resource = "arn:aws:ecr:${var.region}:${data.aws_caller_identity.me.account_id}:repository/*" },
      { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.job.arn}:*" },
    ]
  })
}

resource "aws_cloudwatch_log_group" "job" {
  name              = "/platform/ecs/${var.cfg.name}"
  retention_in_days = 14 # DRAFT(ai): 플랫폼 기본 (IR 에 없음)
  tags              = var.tags
}

resource "aws_ecs_task_definition" "job" {
  family                   = var.cfg.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(local.cpu_units)
  memory                   = tostring(local.mem_mib)
  execution_role_arn       = aws_iam_role.exec.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions    = jsonencode([local.container])
  tags                     = merge(var.tags, { job = var.cfg.id, identity = var.cfg.identity })
}

# 스케줄러가 RunTask 를 부를 때 쓰는 역할: 이 작업 정의만 실행, 이 잡의 두 역할만 PassRole
resource "aws_iam_role" "scheduler" {
  name                 = "${var.cfg.name}-sch"
  permissions_boundary = var.boundary_arn
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = var.tags
}

resource "aws_iam_role_policy" "scheduler" {
  name = "run-task"
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ecs:RunTask"], Resource = replace(aws_ecs_task_definition.job.arn, "/:\\d+$/", ":*"), Condition = { ArnEquals = { "ecs:cluster" = var.cluster_arn } } },
      { Effect = "Allow", Action = ["iam:PassRole"], Resource = [aws_iam_role.task.arn, aws_iam_role.exec.arn] },
    ]
  })
}

resource "aws_scheduler_schedule" "job" {
  name                         = var.cfg.name
  state                        = coalesce(var.cfg.suspend, false) ? "DISABLED" : "ENABLED"
  schedule_expression          = local.schedule_expression
  schedule_expression_timezone = coalesce(var.cfg.time_zone, "UTC") # DRAFT(ai): k8s CronJob 기본(컨트롤러 시간대=UTC)과 같게
  flexible_time_window {
    mode = "OFF"
  }
  target {
    arn      = var.cluster_arn
    role_arn = aws_iam_role.scheduler.arn
    ecs_parameters {
      # 개정 번호를 뺀 이름이 아니라 개정이 붙은 ARN: 작업 정의가 바뀌면 일정도 같이 새 개정을 쓴다
      task_definition_arn = aws_ecs_task_definition.job.arn
      launch_type         = "FARGATE"
      task_count          = 1
      network_configuration {
        subnets          = var.subnet_ids
        security_groups  = var.security_group_ids
        assign_public_ip = false
      }
    }
    retry_policy {
      maximum_retry_attempts = var.cfg.backoff_limit == null ? 0 : min(var.cfg.backoff_limit, 185)
    }
  }
}

output "schedule_name" { value = aws_scheduler_schedule.job.name }
output "schedule_expression" { value = local.schedule_expression }
output "task_definition_arn" { value = aws_ecs_task_definition.job.arn }
output "cpu_units" { value = local.cpu_units }
output "mem_mib" { value = local.mem_mib }
output "task_role_arn" { value = aws_iam_role.task.arn }
output "execution_role_arn" { value = aws_iam_role.exec.arn }
output "unmapped_fields" { value = local.unmapped }
