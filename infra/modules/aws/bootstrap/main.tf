# Terraform 장부(state) 버킷 + 장부 전용 역할(tf-state). 사람이 맨 처음 한 번, backend 없이 로컬 state 로 돌린다. 정리 때는 맨 마지막
# 증거 버킷(../platform)과 따로 둔다: 장부 권한은 워커 역할에 넣지 않고 tf-state 역할로만 빌린다
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
  default = "tfstate"
}
# tf-state 역할을 빌릴 IAM 주체. 비우면 계정 루트 (데모 계정은 전원 AdministratorAccess 라 비워도 막히는 것은 없다)
variable "state_admin_principal_arns" {
  type    = list(string)
  default = []
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.expected_account_id]
  default_tags {
    tags = { managed-by = "platform", stack = var.name }
  }
}

locals {
  bucket     = "${var.name}-${var.expected_account_id}" # 버킷 이름은 전 세계 하나라 계정 번호를 붙인다
  bucket_arn = "arn:aws:s3:::${local.bucket}"           # plan 때 값이 정해지게 이름으로 만든다 (시험이 정책을 본다)
  # TODO(human): 계정 루트면 그 계정에서 sts:AssumeRole 권한이 있는 주체 누구나 빌린다. 주체를 정하면 좁힌다
  state_admins = length(var.state_admin_principal_arns) > 0 ? var.state_admin_principal_arns : ["arn:aws:iam::${var.expected_account_id}:root"]
}

# --- 장부 버킷: service/<스택>/terraform.tfstate. 버전 관리로 덮어써도 이전 판이 남는다
resource "aws_s3_bucket" "state" {
  bucket        = local.bucket
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
  depends_on = [aws_s3_bucket_public_access_block.state]
}

# DRAFT(ai): 비현재 버전은 30일 뒤 만료. 되돌리기에는 한 달이면 충분하다고 봤다
resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
  depends_on = [aws_s3_bucket_versioning.state]
}

# --- tf-state 역할: 이 버킷만 읽고 쓴다
resource "aws_iam_role" "tf_state" {
  name        = "tf-state"
  description = "Terraform remote state read/write on ${local.bucket} only"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = local.state_admins }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "tf_state" {
  name = "tf-state-bucket"
  role = aws_iam_role.tf_state.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ListStateBucket"
        Effect   = "Allow"
        Action   = "s3:ListBucket"
        Resource = local.bucket_arn
      },
      {
        # DeleteObject: use_lockfile 이 잠금 파일(<key>.tflock)을 끝나면 지운다
        Sid      = "ReadWriteStateObjects"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = "${local.bucket_arn}/*"
      },
    ]
  })
}

output "state_bucket" { value = aws_s3_bucket.state.id }
output "state_bucket_arn" { value = aws_s3_bucket.state.arn }
output "tf_state_role_arn" { value = aws_iam_role.tf_state.arn }
