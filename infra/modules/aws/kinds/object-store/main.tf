# kind: objectStore (AWS S3). for_each 키 = IR id. 항목 모양 = contracts tf-kinds.ts ObjectStoreTfVars (TA5fix: 계약이 기준)
# 암호화는 항상 켬. 공개 차단은 출발이 공개(public=true)가 아니면 켬 (B-2: 공개면 그대로 공개, 승인 줄 public_bucket)
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
  # DM-1·TF4-1: CORS 규칙은 IR 모양(origins·methods 필수). 빠지면 "*"·GET 으로 채우지 않고 거부 (출처를 넓히거나 메서드를 줄이지 않음)
  validation {
    condition     = alltrue([for r in try(jsondecode(var.cfg.cors_json), []) : length(try(r.origins, [])) > 0 && length(try(r.methods, [])) > 0])
    error_message = "objectStore cors_json 의 규칙마다 origins·methods 가 있어야 함 (IR CorsRuleV2 모양)."
  }
}

locals {
  # IR lifecycle = [{ prefix, expireDays?, toColdAfterDays? }]
  lifecycle = jsondecode(var.cfg.lifecycle_json)
  # IR cors = contracts CorsRuleV2 [{ origins, methods, allowedHeaders?, exposeHeaders?, maxAgeSec? }] (DM-1: 매퍼가 출발 칸 이름을 이 모양으로 바꿈)
  cors = jsondecode(var.cfg.cors_json)
  # DRAFT(ai): S3 는 메서드 "*" 를 안 받는다. GCS 의 "*"(모든 메서드)는 S3 가 받는 메서드 5개 전부와 같은 뜻이라 그대로 펼친다
  s3_methods = ["GET", "PUT", "POST", "DELETE", "HEAD"]
}

resource "aws_s3_bucket" "this" {
  bucket        = var.cfg.name
  force_destroy = var.cfg.force_destroy
}

# B-2 DECISION(team): 출발이 공개 버킷이면 도착도 공개 ("그대로 이식, 예외 없음" decisions/2026-11-03 20:02Z). 사람 확인은 계획 승인 줄 public_bucket
#   public=null(모름)·false 는 지금처럼 막음
locals {
  open_public = var.cfg.public == true
}
resource "aws_s3_bucket_public_access_block" "this" {
  bucket                  = aws_s3_bucket.this.id
  block_public_acls       = true # ACL 로는 안 엶 (정책 하나로만 엶)
  block_public_policy     = !local.open_public
  ignore_public_acls      = true
  restrict_public_buckets = !local.open_public
}

# DRAFT(ai): 출발 정책 본문은 안 읽는다(관찰 역할 범위) → 공개 = 객체 익명 읽기(s3:GetObject, 버킷 전체). 쓰기·목록 공개는 옮기지 않음 (승인 줄에 적음)
resource "aws_s3_bucket_policy" "public_read" {
  count  = local.open_public ? 1 : 0
  bucket = aws_s3_bucket.this.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "PublicReadFromSource"
      Effect    = "Allow"
      Principal = "*"
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.this.arn}/*"
    }]
  })
  depends_on = [aws_s3_bucket_public_access_block.this]
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
      allowed_origins = cors_rule.value.origins
      allowed_methods = contains(cors_rule.value.methods, "*") ? local.s3_methods : cors_rule.value.methods
      allowed_headers = try(cors_rule.value.allowedHeaders, null)
      expose_headers  = try(cors_rule.value.exposeHeaders, null)
      max_age_seconds = try(cors_rule.value.maxAgeSec, null)
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
