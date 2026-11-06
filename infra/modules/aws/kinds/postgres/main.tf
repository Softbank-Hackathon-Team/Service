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
    db_name                = optional(string)        # DBN-1: 앱 DB 이름 그대로 (null = <앱 이름 - → _>)
    app_user               = optional(string, "app") # DBN-1·E10-2: 앱 계정 이름 그대로. 링크 user·root db_username 이 이 값
    backup_retention_days  = optional(number)        # BK-1: 출발 백업 보관 그대로 (0 = 끔, null = 상품 기본)
    pitr                   = optional(bool)          # BK-1
    maintenance_window     = optional(string)        # BK-1: "ddd:hh:mm-ddd:hh:mm" UTC. null = 상품이 고름
    port                   = optional(number)        # DM-7: 출발 포트 그대로. null = 5432
    require_tls            = optional(bool, true)    # SSL-1: 출발이 평문 허용이면 false (DRAFT(ai))
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
    condition     = var.cfg.backup_retention_days == null || (var.cfg.backup_retention_days >= 0 && var.cfg.backup_retention_days <= 35)
    error_message = "RDS 자동 백업 보관은 0~35일 (줄이지 않음 — Builder 가 계획 전에 막음)."
  }
  validation {
    condition     = var.cfg.logical_replication
    error_message = "logical_replication 은 항상 true (CDC 이전 요구)."
  }
  validation {
    # DECISION(team): 출발 DB 허용 주소는 넓어도 그대로 옮긴다 — /24 거부 같은 우리 쪽 임의 제한 없음 (TF4-2, 2026-11-03 결정). 모양(CIDR)만 본다
    condition     = alltrue([for c in jsondecode(var.cfg.peer_cidrs_json) : can(cidrhost(c, 0))])
    error_message = "peer_cidrs_json: 항목은 CIDR 이어야 한다."
  }
}
variable "app_name" { type = string }
variable "tenant_id" { type = string } # 앱 DB 비밀번호 그릇 이름 platform/<회사>/<앱>/… (kinds/identity·Builder remoteKey 와 같은 접두어)
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }
variable "cluster_sg_id" { # 클러스터 없이(cluster_name "") 만들면 빈 값 → 클러스터 쪽 허용 규칙 없음
  type    = string
  default = ""
}

locals {
  # 플랫폼 관리자 계정 = RDS 마스터 (rds_superuser). gcp/kinds/postgres 와 같은 규칙: 인스턴스 이름(이전마다 해시)에서 정해져 재시도·다시 apply 해도 같다.
  #   앱 계정(cfg.app_user)은 마스터가 아니다 → 컷오버 울타리(REVOKE)가 앱 계정에 먹는다 (복제 점검 DB-08).
  #   예전엔 앱 계정 = 마스터라 rds_superuser(→ pg_write_all_data)를 물려받아 sync 가 REPL_APP_ROLE_UNFENCEABLE 로 멈췄다.
  #   RDS 에는 SQL 프로바이더가 없어 Terraform 이 앱 LOGIN 역할을 못 만든다 → 워커가 관리자로 붙어 만든다 (apps/worker relay-step ensureTargetAppLogin)
  admin_user = "svc_admin_${substr(sha256(var.cfg.name), 0, 10)}"
  # 앱 DB 비밀번호 그릇 "이름"만 정한다. 그릇과 값은 실행기(packages/adapters real-runner)가 apply 뒤 CreateSecret 한 번(값 포함)으로 만들고 destroy 뒤 지운다.
  #   DRAFT(ai): Terraform(aws_secretsmanager_secret_version)으로 못 넣는 이유 = 값 넣기(PutSecretValue)·refresh 의 값 읽기(GetSecretValue)가
  #   실행 역할 천장 밖이다 (permissions-lint: PutSecretValue 금지, GetSecretValue 는 rds!db-* 만). 이름에 인스턴스 이름(이전마다 해시)을 넣어 이전끼리 안 겹친다
  app_password_secret_name = "platform/${var.tenant_id}/${var.app_name}/${var.cfg.name}-db-password"
  # DRAFT(ai): 못 고른 값의 상품 기본값 (가장 싼 급)
  instance_class    = coalesce(var.cfg.instance_class, "db.t4g.micro")
  replicas          = coalesce(var.cfg.read_replicas, 0)
  peer_cidrs        = jsondecode(var.cfg.peer_cidrs_json)
  public_subnet_ids = var.cfg.public_subnet_ids_json == null ? [] : jsondecode(var.cfg.public_subnet_ids_json)
  # IR 파라미터 그대로 + 플랫폼 요구(논리 복제)가 이긴다. TLS 강제는 require_tls (SSL-1: 출발이 평문 허용이면 도착도 같게)
  parameters = merge(
    { for k, v in jsondecode(var.cfg.parameters_json) : k => tostring(v) },
    { "rds.logical_replication" = "1", "rds.force_ssl" = var.cfg.require_tls ? "1" : "0" },
  )
  db_name = coalesce(var.cfg.db_name, replace(var.app_name, "-", "_"))
  port    = coalesce(var.cfg.port, 5432)
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
      from_port       = local.port
      to_port         = local.port
      protocol        = "tcp"
      security_groups = [ingress.value]
    }
  }
  dynamic "ingress" {
    for_each = var.cfg.public ? local.peer_cidrs : []
    content {
      description = "Postgres from demo peer ${ingress.value}"
      from_port   = local.port
      to_port     = local.port
      protocol    = "tcp"
      cidr_blocks = [ingress.value]
    }
  }
  # 논리 복제 구독은 도착 DB 가 상대에게 붙는 방향 → 나가는 길 (v1 Z77 와 같은 이유)
  dynamic "egress" {
    for_each = var.cfg.public ? local.peer_cidrs : []
    content {
      description = "Postgres to demo peer ${egress.value} (subscription)"
      from_port   = local.port
      to_port     = local.port
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
  port                        = local.port
  multi_az                    = var.cfg.ha == true
  storage_encrypted           = true
  db_name                     = local.db_name
  username                    = local.admin_user # 마스터 = 플랫폼 관리자 (앱 계정 아님, 위 locals)
  manage_master_user_password = true             # 관리자 비밀번호는 RDS 가 Secrets Manager(rds!db-…)에 직접 관리 (state 에 비밀 0)
  db_subnet_group_name        = aws_db_subnet_group.db.name
  vpc_security_group_ids      = [aws_security_group.db.id]
  parameter_group_name        = aws_db_parameter_group.db.name
  publicly_accessible         = var.cfg.public
  ca_cert_identifier          = "rds-ca-rsa2048-g1"
  backup_retention_period     = coalesce(var.cfg.backup_retention_days, 1) # BK-1: 출발 그대로. DRAFT(ai): 모르면 1일 (예전 값). RDS 는 자동 백업 = PITR
  maintenance_window          = var.cfg.maintenance_window                 # BK-1: null = AWS 가 고름. TODO(human): 이전 창 동안 자동 마이너 업그레이드를 끌지
  deletion_protection         = var.cfg.deletion_protection
  skip_final_snapshot         = !var.cfg.deletion_protection
  final_snapshot_identifier   = var.cfg.deletion_protection ? "${var.cfg.name}-final" : null
  lifecycle {
    precondition {
      condition     = local.admin_user != var.cfg.app_user
      error_message = "관리자 계정 이름이 앱 계정과 같다."
    }
  }
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
output "port" { value = local.port }
output "db_name" { value = local.db_name }
output "user" { value = var.cfg.app_user }
output "admin_user" { value = local.admin_user }
output "public" { value = var.cfg.public }
output "ca_cert_identifier" { value = aws_db_instance.db.ca_cert_identifier }
# 관리자(마스터) 비밀번호 = RDS 관리 비밀 ARN. 워커만 읽는다 (실행기 fetchSecret → db-secret.json db_admin_password). 앱 신원에는 읽기를 주지 않는다
output "admin_password_secret" { value = aws_db_instance.db.master_user_secret[0].secret_arn }
# 앱 비밀번호 그릇 이름만 (값 아님, 그릇은 실행기가 만든다). KIND_INTERNAL_OUTPUTS.postgres = ["password_secret"]
output "password_secret" { value = local.app_password_secret_name }
output "replica_addresses" { value = [for r in aws_db_instance.replica : r.address] }
# LINK_OUTPUTS.postgres = host·port·url·user (비밀번호 없음)
output "link" {
  value = {
    host = aws_db_instance.db.address
    port = tostring(local.port)
    url  = "postgresql://${var.cfg.app_user}@${aws_db_instance.db.address}:${local.port}/${local.db_name}"
    user = var.cfg.app_user
    # CNPG-RO: 읽기 전용 주소 = 첫 읽기 복제본 (없으면 주 서버)
    reader = length(aws_db_instance.replica) > 0 ? aws_db_instance.replica[0].address : aws_db_instance.db.address
  }
}
