# kind: objectStore (GCP GCS). for_each 키 = IR id. 항목 모양 = contracts tf-kinds.ts ObjectStoreTfVars (TA5fix: 계약이 기준)
# 공개 차단·균일 접근은 항상 켬 (public=true 여도 여기선 안 엶 — 사람 승인 뒤 따로)
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
  # DRAFT(ai): AWS 이름(allowedOrigins…)과 GCS 이름(origin…)을 둘 다 읽는다
  cors = jsondecode(var.cfg.cors_json)
}

# TODO(human): public=true 인 출발 버킷을 도착에서 공개로 열지 (보안 영역 승인). 지금은 항상 막음
resource "google_storage_bucket" "this" {
  name                        = var.cfg.name
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
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
      origin          = try(cors.value.origin, cors.value.allowedOrigins, ["*"])
      method          = try(cors.value.method, cors.value.allowedMethods, ["GET"])
      response_header = try(cors.value.responseHeader, cors.value.exposeHeaders, [])
      max_age_seconds = try(cors.value.maxAgeSeconds, null)
    }
  }
}

output "name" { value = google_storage_bucket.this.name }
# LINK_OUTPUTS.objectStore = name·url
output "link" {
  value = {
    name = google_storage_bucket.this.name
    url  = "gs://${google_storage_bucket.this.name}"
  }
}
