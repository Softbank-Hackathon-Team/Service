# kind: service (GCP Cloud Run 서비스). 관리형 컨테이너 출발(ECS·Cloud Run)을 GCP 로 옮길 때 (설계 23번 7장 예: ECS → Cloud Run).
# 변수 모양 = packages/contracts/src/tf-kinds.ts ServiceTfVars. 상태: 카탈로그만 — 루트(gcp/root)에 아직 안 붙음 (Builder 가 capability 로 막음)
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
}
variable "project_id" { type = string }
variable "region" { type = string }
variable "service_account_email" { type = string } # identity 인스턴스 출력 (gsa_email)
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
}

resource "google_cloud_run_v2_service" "app" {
  name     = var.cfg.name
  location = var.region
  project  = var.project_id
  labels   = var.labels
  # 입구가 이 서비스로 오면 외부 LB(Cloudflare 원점) 로, 아니면 내부 전용
  ingress             = var.cfg.public ? "INGRESS_TRAFFIC_ALL" : "INGRESS_TRAFFIC_INTERNAL_ONLY"
  deletion_protection = false # DRAFT(ai): 앱 서비스는 상태가 없다 (DB 는 postgres 모듈이 지킴)

  template {
    service_account = var.service_account_email
    scaling {
      min_instance_count = var.cfg.min_instances
      max_instance_count = var.cfg.max_instances
    }
    dynamic "vpc_access" {
      for_each = var.network == null ? [] : [1]
      content {
        egress = "PRIVATE_RANGES_ONLY"
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
              secret  = env.value.secret
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
