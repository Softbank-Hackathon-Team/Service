# AWS 도착 "앱 한 개" 모듈 (클라우드 층만): RDS Postgres + 시크릿 그릇 + 앱 IAM 역할(Pod Identity).
# VPC·EKS·ECR·ESO는 환경 부트스트랩 모듈(../env) 몫. 변수는 어댑터 toTerraform()이 만든다 (평평한 값만).
terraform {
  required_version = ">= 1.11"
  required_providers {
    aws        = { source = "hashicorp/aws", version = "~> 6.0" }
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 2.38" }
  }
}

variable "expected_account_id" { type = string }
variable "region" { type = string }
variable "app_name" { type = string }
variable "tenant_id" { type = string }
variable "cluster_name" { type = string }
variable "vpc_id" { type = string }
variable "db_subnet_ids_json" { type = string } # JSON 배열 문자열 (어댑터 계약이 평평한 값만 허용)
variable "k8s_namespace" { type = string }
variable "name_db_instance" {
  type = string
  validation {
    condition     = length(var.name_db_instance) <= 63
    error_message = "RDS 식별자는 63자 이하."
  }
}
variable "name_app_role" { type = string }
variable "app_role_boundary_arn" { type = string } # env 모듈이 만든 platform-app-boundary (실행 역할은 경계 없이 역할을 못 만든다)
variable "secret_names_json" { type = string }
variable "db_enabled" { type = bool }
variable "db_engine_version" {
  type = string
  validation {
    condition     = contains(["15", "16", "17"], var.db_engine_version)
    error_message = "지원하지 않는 Postgres 버전."
  }
}
variable "db_instance_class" { type = string }
variable "db_allocated_storage" { type = number }

# --- Z77 DRAFT(ai): 데모 환경만 쓰는 DB 네트워크 길. 기본값 = 예전 그대로(사설, 삭제 보호, 중계기 없음)
# worker 가 .env 의 DB_PUBLIC·DB_PEER_CIDRS·DB_DISPOSABLE 을 보고 넣는다 (packages/adapters/src/terraform/db-network.ts)
variable "db_public" {
  type    = bool
  default = false
}
variable "db_peer_cidrs_json" { # 5432 로 주고받아도 되는 곳 (맥 공인 IP/32, 중계기 사설 IP/32, 다른 클라우드 DB 의 나가는 IP/32)
  type    = string
  default = "[]"
  validation {
    condition     = alltrue([for c in jsondecode(var.db_peer_cidrs_json) : can(cidrhost(c, 0)) && tonumber(split("/", c)[1]) >= 24])
    error_message = "db_peer_cidrs_json: IPv4 CIDR 이고 /24 보다 좁아야 한다 (0.0.0.0/0 금지)."
  }
}
variable "db_public_subnet_ids_json" { # env 모듈 출력 public_subnet_ids (인터넷 게이트웨이로 가는 서브넷)
  type    = string
  default = "[]"
}
variable "db_deletion_protection" {
  type    = bool
  default = true
}

provider "aws" {
  region = var.region
  # 잘못된 계정에 만드는 사고 방지: 자격 증명의 계정이 다르면 plan 단계에서 실패
  allowed_account_ids = [var.expected_account_id]
  default_tags {
    tags = { managed-by = "platform", tenant = var.tenant_id, app = var.app_name }
  }
}

locals {
  secret_names = toset(jsondecode(var.secret_names_json))
  subnet_ids   = jsondecode(var.db_subnet_ids_json)
  db           = var.db_enabled ? 1 : 0
  # Z77
  peer_cidrs        = jsondecode(var.db_peer_cidrs_json)
  public_subnet_ids = jsondecode(var.db_public_subnet_ids_json)
  # Z77: cluster_name 이 비면 (env 모듈 create_eks=false, 맥 B 회차) 클러스터 쪽(네임스페이스·Pod Identity·클러스터 SG 허용)을 건너뛰고 RDS 만
  cluster = var.cluster_name == "" ? 0 : 1
}

data "aws_eks_cluster" "this" {
  count = local.cluster
  name  = var.cluster_name
}

# --- 앱 네임스페이스: Argo CD는 울타리(AppProject)가 클러스터 범위 자원을 막아 못 만든다 (CreateNamespace=false).
# 그래서 Terraform이 EKS API로 직접 만든다. 실행 역할에 EKS access entry(네임스페이스 생성 권한)가 필요
data "aws_eks_cluster_auth" "this" {
  count = local.cluster
  name  = var.cluster_name
}

# 클러스터가 없으면 쓰는 자원이 0개라 프로바이더는 호출되지 않는다 (값은 try 로 비워 둔다)
provider "kubernetes" {
  host                   = try(data.aws_eks_cluster.this[0].endpoint, null)
  cluster_ca_certificate = try(base64decode(data.aws_eks_cluster.this[0].certificate_authority[0].data), null)
  token                  = try(data.aws_eks_cluster_auth.this[0].token, null)
}

resource "kubernetes_namespace_v1" "app" {
  count = local.cluster
  metadata {
    name   = var.k8s_namespace
    labels = { "managed-by" = "platform", app = var.app_name, tenant = lower(replace(var.tenant_id, "/[^a-zA-Z0-9-]/", "-")) }
  }
}

# --- DB: 사설 서브넷, 암호화, 삭제 보호, 비밀번호는 RDS가 Secrets Manager에 직접 관리 (state에 비밀 0)
resource "aws_db_subnet_group" "db" {
  count = local.db
  name  = var.name_db_instance
  # Z77: 공개 DB 는 공개 서브넷 묶음이어야 publicly_accessible 이 실제 공인 주소를 받는다
  subnet_ids = var.db_public ? local.public_subnet_ids : local.subnet_ids

  lifecycle {
    precondition {
      condition     = !var.db_public || (length(local.public_subnet_ids) >= 2 && length(local.peer_cidrs) >= 1)
      error_message = "db_public=true 면 공개 서브넷 2개 이상(db_public_subnet_ids_json)과 허용 CIDR 1개 이상(db_peer_cidrs_json)이 필요하다."
    }
  }
}

resource "aws_security_group" "db" {
  count       = local.db
  name        = "${var.name_db_instance}-sg"
  description = "Postgres from EKS cluster only"
  vpc_id      = var.vpc_id

  dynamic "ingress" {
    for_each = data.aws_eks_cluster.this
    content {
      description     = "Postgres from EKS nodes/pods"
      from_port       = 5432
      to_port         = 5432
      protocol        = "tcp"
      security_groups = [ingress.value.vpc_config[0].cluster_security_group_id]
    }
  }

  # Z77: 데모 공개 DB 만. 허용 목록(맥 공인 IP 등)에서만 들어온다
  dynamic "ingress" {
    for_each = var.db_public ? local.peer_cidrs : []
    content {
      description = "Postgres from demo peer ${ingress.value}"
      from_port   = 5432
      to_port     = 5432
      protocol    = "tcp"
      cidr_blocks = [ingress.value]
    }
  }

  # Z77: 논리 복제 구독은 "도착 DB 가 상대에게 붙는" 방향이라 나가는 길이 필요하다.
  # (egress 블록이 없으면 Terraform 은 AWS 기본 '전부 허용' 나가기 규칙을 지운다 → 예전엔 RDS 가 아무 데도 못 나갔다)
  dynamic "egress" {
    for_each = var.db_public ? local.peer_cidrs : []
    content {
      description = "Postgres to demo peer ${egress.value} (subscription)"
      from_port   = 5432
      to_port     = 5432
      protocol    = "tcp"
      cidr_blocks = [egress.value]
    }
  }
}


# 논리 복제(CDC) 대비: 되돌리기(도착→출발) 복제를 위해 logical replication을 켠다
resource "aws_db_parameter_group" "db" {
  count  = local.db
  name   = "${var.name_db_instance}-params"
  family = "postgres${var.db_engine_version}"
  parameter {
    name         = "rds.logical_replication"
    value        = "1"
    apply_method = "pending-reboot"
  }
  # Z77: 평문 접속 거절 (공개 DB 라도 TLS 없이는 못 붙는다)
  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }
}

resource "aws_db_instance" "db" {
  count                       = local.db
  identifier                  = var.name_db_instance
  engine                      = "postgres"
  engine_version              = var.db_engine_version
  instance_class              = var.db_instance_class
  allocated_storage           = var.db_allocated_storage
  storage_encrypted           = true
  db_name                     = replace(var.app_name, "-", "_")
  username                    = "app"
  manage_master_user_password = true
  db_subnet_group_name        = aws_db_subnet_group.db[0].name
  vpc_security_group_ids      = [aws_security_group.db[0].id]
  parameter_group_name        = aws_db_parameter_group.db[0].name
  publicly_accessible         = var.db_public       # Z77: 기본 false. 데모만 true + 허용 목록
  ca_cert_identifier          = "rds-ca-rsa2048-g1" # Z77: verify-full 에 쓰는 CA 를 고정 (지역 묶음 ap-northeast-2-bundle.pem 에 들어 있다)
  backup_retention_period     = 1
  deletion_protection         = var.db_deletion_protection
  skip_final_snapshot         = !var.db_deletion_protection # Z77: 그날 파기하는 데모 DB 는 마지막 스냅샷도 안 남긴다 (남으면 돈이 든다)
  final_snapshot_identifier   = var.db_deletion_protection ? "${var.name_db_instance}-final" : null
}

# --- 시크릿: "빈 그릇"만. 값은 worker가 복사 (Terraform state에 비밀 0)
resource "aws_secretsmanager_secret" "s" {
  for_each                = local.secret_names
  name                    = "platform/${var.tenant_id}/${var.app_name}/${each.key}"
  recovery_window_in_days = 7
}

# --- 앱 신원: EKS Pod Identity. 이 앱 시크릿 + DB 마스터 비밀번호만 읽기
# Z77 B': 클러스터 없이(cluster_name "") 만들면 Pod Identity 가 없으니 앱 역할·정책도 안 만든다 (IAM 부여 단계 빼기)
resource "aws_iam_role" "app" {
  count                = local.cluster
  name                 = var.name_app_role
  permissions_boundary = var.app_role_boundary_arn
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "pods.eks.amazonaws.com" }
      Action    = ["sts:AssumeRole", "sts:TagSession"]
    }]
  })
}

locals {
  readable_arns = concat(
    [for s in aws_secretsmanager_secret.s : s.arn],
    var.db_enabled ? [aws_db_instance.db[0].master_user_secret[0].secret_arn] : [],
  )
}

resource "aws_iam_role_policy" "app" {
  count = local.cluster
  name  = "read-own-secrets"
  role  = aws_iam_role.app[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
      Resource = length(local.readable_arns) > 0 ? local.readable_arns : ["arn:aws:secretsmanager:${var.region}:${var.expected_account_id}:secret:none"]
    }]
  })
}

resource "aws_eks_pod_identity_association" "app" {
  count           = local.cluster
  cluster_name    = var.cluster_name
  namespace       = kubernetes_namespace_v1.app[0].metadata[0].name
  service_account = var.app_name
  role_arn        = aws_iam_role.app[0].arn
}

output "db_address" { value = var.db_enabled ? aws_db_instance.db[0].address : "" }
# Z77: 데모 네트워크 길. {tf:키} 로 REPL_*_URL 에 넣는다
output "db_public" { value = var.db_enabled && var.db_public }
output "db_ca_cert_identifier" { value = var.db_enabled ? aws_db_instance.db[0].ca_cert_identifier : "" }
output "db_master_secret_arn" { value = var.db_enabled ? aws_db_instance.db[0].master_user_secret[0].secret_arn : "" }
output "app_role_arn" { value = local.cluster == 1 ? aws_iam_role.app[0].arn : "" }
output "namespace" { value = local.cluster == 1 ? kubernetes_namespace_v1.app[0].metadata[0].name : "" }
