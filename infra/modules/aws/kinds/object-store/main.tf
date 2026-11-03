# kind: objectStore (AWS S3). for_each 키 = IR id. 항목 모양 = contracts tf-kinds.ts ObjectStoreTfVars (TA5fix: 계약이 기준)
# 공개 차단·암호화는 항상 켬 (public=true 여도 여기선 안 엶 — 사람 승인 뒤 따로)
terraform {
  required_version = ">= 1.11"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

# 계약은 모든 칸을 보낸다. optional 은 옛 호출·시험 입력(id·name 만)을 받으려고
variable "cfg" {
  type = object({
    id              = string
    name            = string # 버킷 이름 (전역 유일, TS 가 이전마다 해시)
    versioning      = optional(bool)
    public          = optional(bool)
    size_gb         = optional(number) # 정보용. S3 는 크기를 미리 안 잡는다 (비용 고지에만 씀)
    lifecycle_json  = optional(string, "[]")
    cors_json       = optional(string, "[]")
    allow_from_json = optional(string, "[]")
    force_destroy   = optional(bool, false) # DRAFT(ai): 데모 정리(disposable)에서만 true
  })
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.cfg.name))
    error_message = "S3 버킷 이름 규칙(3~63자 소문자·숫자·.·-)."
  }
  validation {
    condition     = can(tolist(jsondecode(var.cfg.lifecycle_json))) && can(tolist(jsondecode(var.cfg.cors_json))) && can(tolist(jsondecode(var.cfg.allow_from_json)))
    error_message = "objectStore lifecycle_json·cors_json·allow_from_json 은 JSON 배열."
  }
}

locals {
  # IR lifecycle = [{ prefix, expireDays?, toColdAfterDays? }]
  lifecycle = jsondecode(var.cfg.lifecycle_json)
  # IR cors = 출발 클라우드 모양 그대로의 레코드. DRAFT(ai): S3·GCS 공통 이름(allowedOrigins·allowedMethods·allowedHeaders·exposeHeaders·maxAgeSeconds)과
  #   GCS 이름(origin·method·responseHeader·maxAgeSeconds)을 둘 다 읽는다. 없는 칸은 비움
  cors = jsondecode(var.cfg.cors_json)
}

resource "aws_s3_bucket" "this" {
  bucket        = var.cfg.name
  force_destroy = var.cfg.force_destroy
}

# TODO(human): public=true 인 출발 버킷을 도착에서 공개로 열지 (보안 영역 승인). 지금은 항상 막음
resource "aws_s3_bucket_public_access_block" "this" {
  bucket                  = aws_s3_bucket.this.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_versioning" "this" {
  count  = var.cfg.versioning == null ? 0 : 1 # 출발 값이 없으면 건드리지 않음(상품 기본 = 끔)
  bucket = aws_s3_bucket.this.id
  versioning_configuration {
    status = var.cfg.versioning ? "Enabled" : "Suspended"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  count  = length(local.lifecycle) > 0 ? 1 : 0
  bucket = aws_s3_bucket.this.id
  dynamic "rule" {
    for_each = local.lifecycle
    content {
      id     = "ir-${rule.key}"
      status = "Enabled"
      filter {
        prefix = rule.value.prefix
      }
      dynamic "expiration" {
        for_each = try(rule.value.expireDays, null) == null ? [] : [rule.value.expireDays]
        content { days = expiration.value }
      }
      # DRAFT(ai): "차가운 저장" = GLACIER_IR (바로 읽힘, 일수 제한 없음). GCS 는 COLDLINE
      dynamic "transition" {
        for_each = try(rule.value.toColdAfterDays, null) == null ? [] : [rule.value.toColdAfterDays]
        content {
          days          = transition.value
          storage_class = "GLACIER_IR"
        }
      }
    }
  }
}

resource "aws_s3_bucket_cors_configuration" "this" {
  count  = length(local.cors) > 0 ? 1 : 0
  bucket = aws_s3_bucket.this.id
  dynamic "cors_rule" {
    for_each = local.cors
    content {
      allowed_origins = try(cors_rule.value.allowedOrigins, cors_rule.value.origin, ["*"])
      allowed_methods = try(cors_rule.value.allowedMethods, cors_rule.value.method, ["GET"])
      allowed_headers = try(cors_rule.value.allowedHeaders, [])
      expose_headers  = try(cors_rule.value.exposeHeaders, cors_rule.value.responseHeader, [])
      max_age_seconds = try(cors_rule.value.maxAgeSeconds, null)
    }
  }
}

output "name" { value = aws_s3_bucket.this.bucket }
output "arn" { value = aws_s3_bucket.this.arn }
# LINK_OUTPUTS.objectStore = name·url
output "link" {
  value = {
    name = aws_s3_bucket.this.bucket
    url  = "s3://${aws_s3_bucket.this.bucket}"
  }
}
