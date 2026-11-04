# 플랫폼 계정의 Terraform 장부(state) 버킷. 사람이 맨 처음 한 번, backend 없이 로컬 state 로 돌린다. 정리 때는 맨 마지막
# 증거 버킷(../platform)과 따로 둔다: 장부는 사람이 자기 자격 증명으로 읽고 쓴다. 워커 역할에는 장부 권한을 넣지 않는다
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
# S3 버킷 이름은 전 세계 하나라 겹치면 apply 가 BucketAlreadyExists 로 실패한다 → 이름을 바꾸면 platform/backend.tf 의 bucket 도 같이 바꿔야 한다
variable "bucket_name" {
  type    = string
  default = "sb-iron-platform-tfstate"
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.expected_account_id]
  default_tags {
    tags = { managed-by = "platform", stack = "tfstate" }
  }
}

locals {
  bucket = var.bucket_name
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
    # use_lockfile 이 매번 .tflock 을 지워 쌓이는 삭제 마커(가리킬 버전이 없는 것)를 치운다
    expiration {
      expired_object_delete_marker = true
    }
    # 끊긴 멀티파트 업로드 조각은 보이지 않게 요금만 쌓이니 7일 뒤 버린다
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
  depends_on = [aws_s3_bucket_versioning.state]
}

output "state_bucket" { value = aws_s3_bucket.state.id }
output "state_bucket_arn" { value = aws_s3_bucket.state.arn }
