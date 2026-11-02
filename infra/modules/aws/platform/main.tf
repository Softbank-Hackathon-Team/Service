# 플랫폼(제어판) 자체의 저장소: 이미지 저장소(ECR) + 플랫폼 DB(RDS Postgres) + 증거 버킷(S3). 사람이 한 번 돌린다.
# 네트워크·클러스터는 만들지 않고 받는다 (VPC·EKS 는 따로). cluster_name 이 비면 DB 로 들어오는 길을 열지 않는다.
# 파드 권한(Pod Identity)도 여기 없다: 서비스 계정 하나에 역할 하나라, 증거 쓰기 권한은 워커 역할을 만드는 쪽에서 evidence_bucket_arn 으로 붙인다
terraform {
  required_version = ">= 1.11"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "expected_account_id" { type = string }
variable "region" {
  type    = string
  default = "ap-northeast-2"
}
variable "name" {
  type    = string
  default = "platform"
}
variable "vpc_id" { type = string }
variable "db_subnet_ids" { type = list(string) } # 사설 서브넷 2개 이상 (AZ 가 달라야 RDS 서브넷 그룹이 만들어진다)
variable "cluster_name" {
  type    = string
  default = ""
}
variable "db_engine_version" {
  type    = string
  default = "16" # 로컬 docker-compose 의 postgres:16 과 맞춤
}
variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro" # DRAFT(ai): 데모 비용 최소. 부하 보고 올린다
}
variable "db_allocated_storage" {
  type    = number
  default = 20
}
# 끄면 DB 마지막 스냅샷 없이, 버킷은 안의 버전째, ECR 은 이미지째 지운다 (그날 파기하는 데모용)
variable "deletion_protection" {
  type    = bool
  default = true
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.expected_account_id]
  default_tags {
    tags = { managed-by = "platform", stack = var.name }
  }
}

locals {
  cluster = var.cluster_name == "" ? 0 : 1
  # .github/workflows/build.yml 의 이미지 이름(svc-<app>)과 같게
  images = toset(["svc-api", "svc-worker", "svc-agent-worker", "svc-web"])
}

data "aws_eks_cluster" "this" {
  count = local.cluster
  name  = var.cluster_name
}

# --- 이미지 저장소: 플랫폼 앱 4개. 태그는 못 바꾸고(커밋 SHA), 올릴 때 스캔
# (고객 이미지 복사용 ECR "platform" 은 ../env 에 따로 있다)
resource "aws_ecr_repository" "app" {
  for_each             = local.images
  name                 = each.key
  image_tag_mutability = "IMMUTABLE"
  force_delete         = !var.deletion_protection
  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  for_each   = aws_ecr_repository.app
  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep last 10 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 10 }
      action       = { type = "expire" }
    }]
  })
}

# --- 플랫폼 DB: 표 + 작업 큐(pg-boss). 마스터 사용자 = 마이그레이션을 돌리는 표 주인(platform_owner)
resource "aws_db_subnet_group" "db" {
  name       = "${var.name}-db"
  subnet_ids = var.db_subnet_ids
}

resource "aws_security_group" "db" {
  name        = "${var.name}-db-sg"
  description = "Platform Postgres from EKS cluster only"
  vpc_id      = var.vpc_id
}

# 규칙을 SG 안 블록 대신 따로 둔다: 클러스터를 뺐다 다시 넣어도 규칙이 남거나 꼬이지 않는다
# TODO(human): 지금은 클러스터 SG 전체(sandbox 노드 포함). 노드 그룹이 정해지면 api·worker 쪽만 열기
resource "aws_vpc_security_group_ingress_rule" "db_from_cluster" {
  count                        = local.cluster
  security_group_id            = aws_security_group.db.id
  description                  = "Postgres from EKS nodes/pods"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = data.aws_eks_cluster.this[0].vpc_config[0].cluster_security_group_id
}

# 파라미터 그룹 없음: RDS Postgres 15+ 는 기본값이 rds.force_ssl=1 (평문 접속 거절)
resource "aws_db_instance" "db" {
  identifier                  = "${var.name}-db"
  engine                      = "postgres"
  engine_version              = var.db_engine_version
  instance_class              = var.db_instance_class
  allocated_storage           = var.db_allocated_storage
  storage_encrypted           = true
  db_name                     = "platform"
  username                    = "platform_owner"
  manage_master_user_password = true # 비밀번호는 RDS 가 Secrets Manager 에 둔다 (state 에 비밀 0). 클러스터로는 ESO 가 가져온다
  db_subnet_group_name        = aws_db_subnet_group.db.name
  vpc_security_group_ids      = [aws_security_group.db.id]
  publicly_accessible         = false
  ca_cert_identifier          = "rds-ca-rsa2048-g1"
  backup_retention_period     = 1
  deletion_protection         = var.deletion_protection
  skip_final_snapshot         = !var.deletion_protection
  final_snapshot_identifier   = var.deletion_protection ? "${var.name}-db-final" : null
}

# --- 증거 버킷: 이전 회차마다 남기는 파일 (<회사>/<이전 id>/...). 버전 관리로 덮어써도 이전 판이 남는다
# Terraform 장부(state) 버킷과 따로 둔다: 증거 쓰기 권한으로 장부를 못 건드리게
# DRAFT(ai): Object Lock 은 안 켠다 (버킷 만들 때만 켤 수 있고, 켜면 데모 뒤 정리가 막힌다)
resource "aws_s3_bucket" "evidence" {
  bucket        = "${var.name}-evidence-${var.expected_account_id}" # 버킷 이름은 전 세계 하나라 계정 번호를 붙인다
  force_destroy = !var.deletion_protection
}

resource "aws_s3_bucket_public_access_block" "evidence" {
  bucket                  = aws_s3_bucket.evidence.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "evidence" {
  bucket = aws_s3_bucket.evidence.id
  versioning_configuration {
    status = "Enabled"
  }
}

# 암호화는 S3 기본(SSE-S3)을 그대로 쓴다. 여기서는 TLS 없는 요청만 막는다
resource "aws_s3_bucket_policy" "evidence" {
  bucket = aws_s3_bucket.evidence.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.evidence.arn, "${aws_s3_bucket.evidence.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
  depends_on = [aws_s3_bucket_public_access_block.evidence]
}

output "ecr_repository_urls" { value = { for k, r in aws_ecr_repository.app : k => r.repository_url } }
output "db_address" { value = aws_db_instance.db.address }
output "db_master_secret_arn" { value = aws_db_instance.db.master_user_secret[0].secret_arn }
output "evidence_bucket" { value = aws_s3_bucket.evidence.id }
# 워커 역할에 붙일 권한의 대상: s3:PutObject·GetObject 는 "<arn>/*", ListBucket 은 "<arn>"
output "evidence_bucket_arn" { value = aws_s3_bucket.evidence.arn }
