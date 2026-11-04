# DRAFT(ai) REALECS: 실클라우드 회차용 "ECS 출발" 샘플. 작은 Fargate 서비스 1개 (데모 앱 이미지, 태그로 앱 묶음).
# 왜: ECS reader(aws-ecs.ts)·mapper(ecs-service.ts)를 진짜 계정에서 한 번 돌려 보려고. 결선 이전 대상이 아니라 "출발 자원"이다.
# demo-relay 와 같은 급의 데모 바닥: worker 가 아니라 사람이 맥에서 apply/destroy (sh tools/jeong-ecs-up.sh / jeong-ecs-down.sh).
# 새 VPC 를 만들지 않는다: 기본 VPC 의 서브넷에 공인 IP 로 뜬다 (NAT 0, 비용 최소). 들어오는 연결 없음(SG 인바운드 0).
# 비밀 값 0: 환경 변수는 비밀이 아닌 값만. 이미지는 digest 로 고정(재현성).
terraform {
  required_version = ">= 1.11"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "region" {
  type    = string
  default = "ap-northeast-2"
}
variable "name" {
  type    = string
  default = "realecs-src"
}
variable "app" { # 앱 묶음 태그 (IMPORT_APP 과 별개. 가져온 명세에서 이 앱으로 묶임)
  type    = string
  default = "shop"
}
variable "image" {
  type = string
  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.image))
    error_message = "이미지는 digest 로 고정 (재현성)."
  }
}
variable "container_port" {
  type    = number
  default = 5678
}
variable "desired_count" {
  type    = number
  default = 1
}

provider "aws" {
  region = var.region
  # FM-CLD-13: IAM 역할·보안 그룹·로그 그룹까지 전부 태그 → 상태를 잃어도 cloud-zero 태그 조회가 센다
  default_tags {
    tags = local.tags
  }
}

locals {
  tags = { app = var.app, purpose = "realecs-fixture", "managed-by" = "realecs-source" }
}

data "aws_vpc" "default" { default = true }
data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

resource "aws_security_group" "svc" {
  name        = "${var.name}-svc"
  description = "realecs fixture: inbound 0, outbound all"
  vpc_id      = data.aws_vpc.default.id
  tags        = merge(local.tags, { Name = "${var.name}-svc" })
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_cloudwatch_log_group" "svc" {
  name              = "/ecs/${var.name}"
  retention_in_days = 1
  tags              = local.tags
}

data "aws_iam_policy_document" "ecs_tasks" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}
resource "aws_iam_role" "exec" {
  name               = "${var.name}-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks.json
  tags               = local.tags
}
resource "aws_iam_role_policy_attachment" "exec" {
  role       = aws_iam_role.exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}
resource "aws_iam_role" "task" { # 앱 신원 (권한 0: 읽을 거리만 만들려는 빈 역할)
  name               = "${var.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks.json
  tags               = local.tags
}

resource "aws_ecs_cluster" "this" {
  name = var.name
  tags = local.tags
}

resource "aws_ecs_task_definition" "svc" {
  family                   = "${var.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.exec.arn
  task_role_arn            = aws_iam_role.task.arn
  tags                     = local.tags
  container_definitions = jsonencode([{
    name         = "api"
    image        = var.image
    essential    = true
    command      = ["-listen=:${var.container_port}", "-text=ok"]
    portMappings = [{ containerPort = var.container_port, protocol = "tcp" }]
    environment  = [{ name = "LOG_LEVEL", value = "info" }, { name = "APP_NAME", value = var.app }]
    logConfiguration = {
      logDriver = "awslogs"
      options   = { "awslogs-group" = aws_cloudwatch_log_group.svc.name, "awslogs-region" = var.region, "awslogs-stream-prefix" = "api" }
    }
  }])
}

resource "aws_ecs_service" "svc" {
  name            = "${var.name}-api"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.svc.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"
  tags            = local.tags
  network_configuration {
    subnets          = data.aws_subnets.default.ids
    security_groups  = [aws_security_group.svc.id]
    assign_public_ip = true
  }
  lifecycle { ignore_changes = [desired_count] } # Auto Scaling 이 바꾼다
}

resource "aws_appautoscaling_target" "svc" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.svc.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = 1
  max_capacity       = 2
}
resource "aws_appautoscaling_policy" "cpu" {
  name               = "${var.name}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.svc.service_namespace
  resource_id        = aws_appautoscaling_target.svc.resource_id
  scalable_dimension = aws_appautoscaling_target.svc.scalable_dimension
  target_tracking_scaling_policy_configuration {
    target_value = 60
    predefined_metric_specification { predefined_metric_type = "ECSServiceAverageCPUUtilization" }
  }
}

output "cluster_name" { value = aws_ecs_cluster.this.name }
output "service_name" { value = aws_ecs_service.svc.name }
