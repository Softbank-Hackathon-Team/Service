# kind: service (GCP Cloud Run 서비스). 관리형 컨테이너 출발(ECS·Cloud Run)을 GCP 로 옮길 때 (설계 23번 7장 예: ECS → Cloud Run).
# 변수 모양 = packages/contracts/src/tf-kinds.ts ServiceTfVars. TA13: 루트(gcp/root) service_json 으로 붙음. env_json 은 루트가 조각을 합친 [{name, value}]
# 원칙: null 이면 상품 기본값(DRAFT 표시). 비밀 값은 모듈이 모른다 (Secret Manager 이름으로만 넘김)
terraform {
  required_version = ">= 1.11"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
  }
}

variable "cfg" {
  type = object({
    id             = string
    name           = string
    role_name      = string
    image          = string
    command_json   = optional(string)
    args_json      = optional(string)
    cpu_milli      = optional(number)
    mem_mib        = optional(number)
    port           = optional(number)
    min_instances  = number
    max_instances  = number
    target_cpu_pct = optional(number)
    health_path    = optional(string)
    env_json       = optional(string, "[]")
    secrets_json   = optional(string, "[]")
    identity       = string
    public         = optional(bool, false)
  })
  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.cfg.image))
    error_message = "이미지는 digest 로 고정 (재현성)."
  }
  validation {
    condition     = var.cfg.min_instances >= 0 && var.cfg.max_instances >= var.cfg.min_instances && var.cfg.max_instances <= 100
    error_message = "0 <= min_instances <= max_instances <= 100."
  }
  validation {
    condition     = can(regex("^[a-z]([-a-z0-9]{0,47}[a-z0-9])?$", var.cfg.name))
    error_message = "Cloud Run 서비스 이름은 소문자로 시작, 49자 이하."
  }
  validation {
    condition     = length(var.cfg.role_name) >= 6 && length(var.cfg.role_name) <= 30 && startswith(var.cfg.role_name, "app-")
    error_message = "SA account_id 는 6~30자, app- 로 시작 (setIamPolicy 조건 대상)."
  }
}
variable "project_id" { type = string }
variable "region" { type = string }
# TA13: 실행 SA 를 이 모듈이 만든다 (GKE 신원 모듈은 Workload Identity 묶음이라 안 씀)
# TODO(human): Cloud Run 에 SA 를 붙이려면 배포 주체에 iam.serviceAccounts.actAs 가 필요 — 지금 실행 역할 천장(permissions-lint)이 금지. 보안 승인 몫
# 비밀 이름 → Secret Manager secret id (루트가 만든 그릇). 접근 권한도 이 SA 에 붙인다
variable "secret_ids" {
  type    = map(string)
  default = {}
}
# DB 사설 IP 로 나가는 길 (Direct VPC egress). null 이면 공용 길만
variable "network" {
  type    = string
  default = null
}
variable "subnetwork" {
  type    = string
  default = null
}
variable "labels" {
  type    = map(string)
  default = {}
}

locals {
  env     = jsondecode(coalesce(var.cfg.env_json, "[]"))
  secrets = jsondecode(coalesce(var.cfg.secrets_json, "[]"))
  # DRAFT(ai): Cloud Run CPU 는 1·2·4·8 (1 미만은 동시성 1 제약) → IR 값 이상인 가장 작은 정수 vCPU. 모르면 1. 메모리 최소 512Mi
  cpu = var.cfg.cpu_milli == null ? 1 : [for c in [1, 2, 4, 8] : c if c * 1000 >= var.cfg.cpu_milli][0]
  mem = max(512, var.cfg.mem_mib == null ? 512 : var.cfg.mem_mib)
  # 이 서비스가 읽는 비밀 그릇 (중복 없음)
  read_ids = toset([for s in local.secrets : var.secret_ids[s.secret]])
}

resource "google_service_account" "app" {
  project      = var.project_id
  account_id   = var.cfg.role_name
  display_name = "platform ${var.cfg.id}"
}

resource "google_secret_manager_secret_iam_member" "read" {
  for_each  = local.read_ids
  project   = var.project_id
  secret_id = each.key
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.app.email}"
}

# DRAFT(ai): 출발(ECS 등) 앱은 ID 토큰 없이 서로 부른다 → 인증 없는 호출 허용. 막는 건 ingress(내부 전용)·VPC 몫
# TODO(human): 조직 정책(도메인 제한 공유)이 allUsers 를 막으면 실패. 서비스 간 인증(ID 토큰)으로 바꿀지 사람이 정함
resource "google_cloud_run_v2_service_iam_member" "invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.app.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service" "app" {
  name     = var.cfg.name
  location = var.region
  project  = var.project_id
  labels   = var.labels
  # 입구가 이 서비스로 오면 외부 LB(Cloudflare 원점) 로, 아니면 내부 전용
  ingress             = var.cfg.public ? "INGRESS_TRAFFIC_ALL" : "INGRESS_TRAFFIC_INTERNAL_ONLY"
  deletion_protection = false # DRAFT(ai): 앱 서비스는 상태가 없다 (DB 는 postgres 모듈이 지킴)
  # 비밀 읽기 권한이 붙은 뒤 리비전을 만든다 (없으면 첫 리비전이 비밀을 못 읽고 실패)
  depends_on = [google_secret_manager_secret_iam_member.read]

  template {
    service_account = google_service_account.app.email
    scaling {
      min_instance_count = var.cfg.min_instances
      max_instance_count = var.cfg.max_instances
    }
    dynamic "vpc_access" {
      for_each = var.network == null ? [] : [1]
      content {
        # DRAFT(ai): 다른 서비스(내부 전용 ingress)를 부르려면 VPC 를 거쳐야 함 → 전부 VPC 로. 인터넷은 env 층 Cloud NAT 로 나감 【추정】
        egress = "ALL_TRAFFIC"
        network_interfaces {
          network    = var.network
          subnetwork = var.subnetwork
        }
      }
    }
    containers {
      image   = var.cfg.image
      command = var.cfg.command_json == null ? null : jsondecode(var.cfg.command_json)
      args    = var.cfg.args_json == null ? null : jsondecode(var.cfg.args_json)
      resources {
        limits = { cpu = tostring(local.cpu), memory = "${local.mem}Mi" }
      }
      dynamic "ports" {
        for_each = var.cfg.port == null ? [] : [var.cfg.port]
        content {
          container_port = ports.value
        }
      }
      dynamic "env" {
        for_each = local.env
        content {
          name  = env.value.name
          value = env.value.value
        }
      }
      dynamic "env" {
        for_each = local.secrets
        content {
          name = env.value.name
          value_source {
            secret_key_ref {
              secret  = var.secret_ids[env.value.secret]
              version = "latest"
            }
          }
        }
      }
      dynamic "startup_probe" {
        for_each = var.cfg.health_path == null || var.cfg.port == null ? [] : [1]
        content {
          http_get {
            path = var.cfg.health_path
            port = var.cfg.port
          }
        }
      }
    }
  }
}
# TODO(human): target_cpu_pct — Cloud Run 은 CPU 목표 확장 대신 동시 요청 수로 확장한다. IR 값을 어떻게 옮길지 (지금은 무시하고 min/max 만)

output "service_name" { value = google_cloud_run_v2_service.app.name }
output "uri" { value = google_cloud_run_v2_service.app.uri }
output "cpu" { value = local.cpu }
output "mem_mib" { value = local.mem }
output "service_account_email" { value = google_service_account.app.email }
