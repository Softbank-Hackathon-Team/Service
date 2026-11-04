# kind: objectStore (GCP GCS). for_each 키 = IR id. 항목 모양 = contracts tf-kinds.ts ObjectStoreTfVars (TA5fix: 계약이 기준)
# 균일 접근은 항상 켬. 공개 차단은 출발이 공개(public=true)가 아니면 켬 (B-2: 공개면 그대로 공개, 승인 줄 public_bucket)
terraform {
  required_version = ">= 1.11"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
  }
}

# 계약은 모든 칸을 보낸다. optional 은 옛 호출·시험 입력(id·name 만)을 받으려고
variable "cfg" {
  type = object({
    id              = string
    name            = string
    versioning      = optional(bool)
    public          = optional(bool)
    size_gb         = optional(number) # 정보용. GCS 는 크기를 미리 안 잡는다 (비용 고지에만 씀)
    lifecycle_json  = optional(string, "[]")
    cors_json       = optional(string, "[]")
    allow_from_json = optional(string, "[]")
    force_destroy   = optional(bool, false) # DRAFT(ai): 데모 정리(disposable)에서만 true
  })
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$", var.cfg.name))
    error_message = "GCS 버킷 이름 규칙(3~63자 소문자·숫자·.·_·-)."
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
variable "region" { type = string }
variable "labels" { type = map(string) }

locals {
  lifecycle = jsondecode(var.cfg.lifecycle_json) # [{ prefix, expireDays?, toColdAfterDays? }]
  # 규칙 하나가 GCS 규칙 0~2개 (삭제·차가운 저장)
  rules = concat(
    [for r in local.lifecycle : { prefix = r.prefix, age = r.expireDays, action = "Delete", class = null } if try(r.expireDays, null) != null],
    # DRAFT(ai): "차가운 저장" = COLDLINE (AWS 는 GLACIER_IR)
    [for r in local.lifecycle : { prefix = r.prefix, age = r.toColdAfterDays, action = "SetStorageClass", class = "COLDLINE" } if try(r.toColdAfterDays, null) != null],
  )
  # IR cors = contracts CorsRuleV2 [{ origins, methods, allowedHeaders?, exposeHeaders?, maxAgeSec? }] (DM-1: 매퍼가 출발 칸 이름을 이 모양으로 바꿈)
  # DRAFT(ai): GCS responseHeader 하나가 요청 허용 헤더·응답 노출 헤더를 같이 정한다 → 둘을 합친다
  cors = [for r in jsondecode(var.cfg.cors_json) : {
    origin          = r.origins
    method          = r.methods
    response_header = distinct(concat(try(r.allowedHeaders, []), try(r.exposeHeaders, [])))
    max_age_seconds = try(r.maxAgeSec, null)
  }]
}

# B-2 DECISION(team): 출발이 공개 버킷이면 도착도 공개 ("그대로 이식, 예외 없음" decisions/2026-11-03 20:02Z). public=null·false 는 막음
resource "google_storage_bucket" "this" {
  name                        = var.cfg.name
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = var.cfg.public == true ? "inherited" : "enforced"
  force_destroy               = var.cfg.force_destroy
  labels                      = var.labels
  versioning {
    enabled = var.cfg.versioning == true
  }
  dynamic "lifecycle_rule" {
    for_each = local.rules
    content {
      condition {
        age            = lifecycle_rule.value.age
        matches_prefix = lifecycle_rule.value.prefix == "" ? null : [lifecycle_rule.value.prefix]
      }
      action {
        type          = lifecycle_rule.value.action
        storage_class = lifecycle_rule.value.class
      }
    }
  }
  dynamic "cors" {
    for_each = local.cors
    content {
      origin          = cors.value.origin
      method          = cors.value.method
      response_header = length(cors.value.response_header) > 0 ? cors.value.response_header : null
      max_age_seconds = cors.value.max_age_seconds
    }
  }
}

# DRAFT(ai): 출발 IAM 의 공개 역할 이름은 안 담는다 → 공개 = allUsers 객체 읽기(objectViewer). 쓰기 공개는 옮기지 않음 (승인 줄에 적음)
resource "google_storage_bucket_iam_member" "public_read" {
  count  = var.cfg.public == true ? 1 : 0
  bucket = google_storage_bucket.this.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}

output "name" { value = google_storage_bucket.this.name }
# LINK_OUTPUTS.objectStore = name·url
output "link" {
  value = {
    name = google_storage_bucket.this.name
    url  = "gs://${google_storage_bucket.this.name}"
  }
}
