# kind: identity (GCP) — 서비스·잡 하나의 앱 신원: 시크릿 그릇 + GSA + Workload Identity + 시크릿 읽기 바인딩.
# for_each 키 = IR id. 변수 모양 = tf-kinds.ts IdentityTfVars
terraform {
  required_version = ">= 1.11"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
  }
}

variable "cfg" {
  type = object({
    id                = string
    name              = string # boundedName({prefix:"app-", max:30}) — SA account_id 규칙
    service_account   = string # k8s SA 이름
    secret_names_json = optional(string, "[]")
  })
  validation {
    condition     = length(var.cfg.name) >= 6 && length(var.cfg.name) <= 30 && startswith(var.cfg.name, "app-")
    error_message = "SA account_id는 6~30자, app- 로 시작 (setIamPolicy 조건 대상)."
  }
}
variable "app_name" { type = string }
variable "project_id" { type = string }
variable "namespace" { type = string }
variable "labels" { type = map(string) }
# 같은 이름 시크릿을 여러 신원이 적으면 root 가 id 가 가장 앞선 신원만 만들게 한다 (그릇 중복 방지)
variable "owned_secret_names" {
  type    = list(string)
  default = []
}
# 읽을 수 있게 할 다른 비밀 (예: 연결할 DB 의 비밀번호 secret 전체 이름 projects/…/secrets/…)
variable "extra_readable_secrets" {
  type    = list(string)
  default = []
}

locals {
  secret_names = jsondecode(coalesce(var.cfg.secret_names_json, "[]"))
  sid          = { for n in local.secret_names : n => "app-${var.app_name}-${lower(replace(n, "_", "-"))}" }
  owned        = { for n in var.owned_secret_names : n => "app-${var.app_name}-${lower(replace(n, "_", "-"))}" }
  # 키는 이름·값은 전체 이름 (apply 전에 알 수 있는 값만 키로)
  readable = merge(
    { for n, id in local.sid : "own-${n}" => "projects/${var.project_id}/secrets/${id}" },
    { for i, s in var.extra_readable_secrets : "extra-${i}" => s },
  )
}

resource "google_secret_manager_secret" "s" {
  for_each  = local.owned
  secret_id = each.value
  labels    = var.labels
  replication {
    auto {}
  }
}

resource "google_service_account" "app" {
  account_id   = var.cfg.name
  display_name = "platform app ${var.app_name} ${var.cfg.id}"
}

resource "google_service_account_iam_member" "wi" {
  service_account_id = google_service_account.app.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[${var.namespace}/${var.cfg.service_account}]"
}

# 다른 신원이 만든 그릇을 읽는 바인딩은 그 그릇이 만들어진 뒤여야 한다 (같은 apply 안에서 순서 경쟁 가능 → 실패하면 재시도)
# TODO(human): 공유 시크릿 소유 신원과 읽는 신원의 순서를 root 에서 강제할지 (지금은 재시도에 맡김)
resource "google_secret_manager_secret_iam_member" "read" {
  for_each   = local.readable
  secret_id  = each.value
  role       = "roles/secretmanager.secretAccessor"
  member     = "serviceAccount:${google_service_account.app.email}"
  depends_on = [google_secret_manager_secret.s]
}

output "gsa_email" { value = google_service_account.app.email }
output "secret_ids" { value = { for k, s in google_secret_manager_secret.s : k => s.secret_id } }
