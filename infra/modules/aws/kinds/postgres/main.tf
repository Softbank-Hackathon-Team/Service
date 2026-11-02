# kind: postgres (AWS RDS). for_each 키 = IR id. 변수 모양 = packages/contracts/src/tf-kinds.ts PostgresTfVars
# 원칙: null 이면 상품 기본값(DRAFT 표시), IR 값은 지어내지 않고 그대로. v1 app/ 모듈의 DB 부분과 같은 보안 기본값
terraform {
  required_version = ">= 1.11"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "cfg" {
  type = object({
    id                     = string
    name                   = string
    major_version          = string
    storage_gb             = number
    storage_max_gb         = optional(number)
    instance_class         = optional(string)
    ha                     = optional(bool)
    read_replicas          = optional(number)
    parameters_json        = optional(string, "{}")
    logical_replication    = optional(bool, true)
    allow_from_json        = optional(string, "[]")
    public                 = optional(bool, false)
    peer_cidrs_json        = optional(string, "[]")
    public_subnet_ids_json = optional(string)
    deletion_protection    = optional(bool, true)
  })
  validation {
    condition     = contains(["15", "16", "17"], var.cfg.major_version)
    error_message = "지원하지 않는 Postgres 버전."
  }
  validation {
    condition     = length(var.cfg.name) <= 63
    error_message = "RDS 식별자는 63자 이하."
  }
  validation {
    condition     = var.cfg.logical_replication
    error_message = "logical_replication 은 항상 true (CDC 이전 요구)."
  }
  validation {
    condition     = alltrue([for c in jsondecode(var.cfg.peer_cidrs_json) : can(cidrhost(c, 0)) && tonumber(split("/", c)[1]) >= 24])
    error_message = "peer_cidrs_json: IPv4 CIDR 이고 /24 보다 좁아야 한다 (0.0.0.0/0 금지)."
  }
}
variable "app_name" { type = string }
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }
variable "cluster_sg_id" { # 클러스터 없이(cluster_name "") 만들면 빈 값 → 클러스터 쪽 허용 규칙 없음
  type    = string
  default = ""
}

locals {
  # DRAFT(ai): 못 고른 값의 상품 기본값 (가장 싼 급)
  instance_class    = coalesce(var.cfg.instance_class, "db.t4g.micro")
  replicas          = coalesce(var.cfg.read_replicas, 0)
  peer_cidrs        = jsondecode(var.cfg.peer_cidrs_json)
  public_subnet_ids = var.cfg.public_subnet_ids_json == null ? [] : jsondecode(var.cfg.public_subnet_ids_json)
  # IR 파라미터 그대로 + 플랫폼 요구(논리 복제·TLS 강제)가 이긴다
  parameters = merge(
    { for k, v in jsondecode(var.cfg.parameters_json) : k => tostring(v) },
    { "rds.logical_replication" = "1", "rds.force_ssl" = "1" },
  )
  db_name = replace(var.app_name, "-", "_")
}

resource "aws_db_subnet_group" "db" {
  name       = var.cfg.name
  subnet_ids = var.cfg.public ? local.public_subnet_ids : var.subnet_ids
  lifecycle {
    precondition {
      condition     = !var.cfg.public || (length(local.public_subnet_ids) >= 2 && length(local.peer_cidrs) >= 1)
      error_message = "public=true 면 공개 서브넷 2개 이상(public_subnet_ids_json)과 허용 CIDR 1개 이상(peer_cidrs_json)이 필요하다."
    }
  }
}

resource "aws_security_group" "db" {
  name        = "${var.cfg.name}-sg"
  description = "Postgres ${var.cfg.id}"
  vpc_id      = var.vpc_id

  dynamic "ingress" {
    for_each = var.cluster_sg_id == "" ? [] : [var.cluster_sg_id]
    content {
      description     = "Postgres from EKS nodes/pods"
      from_port       = 5432
      to_port         = 5432
      protocol        = "tcp"
      security_groups = [ingress.value]
    }
  }
  dynamic "ingress" {
    for_each = var.cfg.public ? local.peer_cidrs : []
    content {
      description = "Postgres from demo peer ${ingress.value}"
      from_port   = 5432
      to_port     = 5432
      protocol    = "tcp"
      cidr_blocks = [ingress.value]
    }
  }
  # 논리 복제 구독은 도착 DB 가 상대에게 붙는 방향 → 나가는 길 (v1 Z77 와 같은 이유)
  dynamic "egress" {
    for_each = var.cfg.public ? local.peer_cidrs : []
    content {
      description = "Postgres to demo peer ${egress.value} (subscription)"
      from_port   = 5432
      to_port     = 5432
      protocol    = "tcp"
      cidr_blocks = [egress.value]
    }
  }
}

resource "aws_db_parameter_group" "db" {
  name   = "${var.cfg.name}-params"
  family = "postgres${var.cfg.major_version}"
  dynamic "parameter" {
    for_each = local.parameters
    content {
      name         = parameter.key
      value        = parameter.value
      apply_method = "pending-reboot"
    }
  }
}

resource "aws_db_instance" "db" {
  identifier                  = var.cfg.name
  engine                      = "postgres"
  engine_version              = var.cfg.major_version
  instance_class              = local.instance_class
  allocated_storage           = var.cfg.storage_gb
  max_allocated_storage       = var.cfg.storage_max_gb
  multi_az                    = var.cfg.ha == true
  storage_encrypted           = true
  db_name                     = local.db_name
  username                    = "app"
  manage_master_user_password = true # 비밀번호는 RDS 가 Secrets Manager 에 직접 관리 (state 에 비밀 0)
  db_subnet_group_name        = aws_db_subnet_group.db.name
  vpc_security_group_ids      = [aws_security_group.db.id]
  parameter_group_name        = aws_db_parameter_group.db.name
  publicly_accessible         = var.cfg.public
  ca_cert_identifier          = "rds-ca-rsa2048-g1"
  backup_retention_period     = 1
  deletion_protection         = var.cfg.deletion_protection
  skip_final_snapshot         = !var.cfg.deletion_protection
  final_snapshot_identifier   = var.cfg.deletion_protection ? "${var.cfg.name}-final" : null
}

resource "aws_db_instance" "replica" {
  count                  = local.replicas
  identifier             = "${var.cfg.name}-r${count.index + 1}"
  replicate_source_db    = aws_db_instance.db.identifier
  instance_class         = local.instance_class
  storage_encrypted      = true
  publicly_accessible    = var.cfg.public
  vpc_security_group_ids = [aws_security_group.db.id]
  parameter_group_name   = aws_db_parameter_group.db.name
  ca_cert_identifier     = "rds-ca-rsa2048-g1"
  skip_final_snapshot    = true
}

output "address" { value = aws_db_instance.db.address }
output "arn" { value = aws_db_instance.db.arn } # A8: 옮긴 IAM 권한의 Resource (root grants.tf)
output "port" { value = 5432 }
output "db_name" { value = local.db_name }
output "user" { value = "app" }
output "public" { value = var.cfg.public }
output "ca_cert_identifier" { value = aws_db_instance.db.ca_cert_identifier }
# 비밀 "이름"만 (값 아님). KIND_INTERNAL_OUTPUTS.postgres = ["password_secret"]
output "password_secret" { value = aws_db_instance.db.master_user_secret[0].secret_arn }
output "replica_addresses" { value = [for r in aws_db_instance.replica : r.address] }
# LINK_OUTPUTS.postgres = host·port·url·user (비밀번호 없음)
output "link" {
  value = {
    host = aws_db_instance.db.address
    port = "5432"
    url  = "postgresql://app@${aws_db_instance.db.address}:5432/${local.db_name}"
    user = "app"
  }
}
