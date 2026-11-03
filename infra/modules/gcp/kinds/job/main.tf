# kind: job (GCP Cloud Run job + Cloud Scheduler). 관리형 컨테이너 출발의 예약 잡을 Cloud Run 으로 옮길 때.
# 변수 모양 = packages/contracts/src/tf-kinds.ts JobTfVars. 루트(gcp/root)의 job_json 으로 붙음. env_json 은 루트가 자리표시를 푼 [{name, value}]
# 원칙: null 이면 상품 기본값(DRAFT 표시), IR 값은 지어내지 않음. Cloud Run 이 못 옮기는 칸은 조용히 버리지 않고 output unmapped_fields 에 적는다
# TODO(human): 비밀(secrets)은 JobTfVars 에 칸이 없어 이 모듈은 비밀 없는 잡만 그린다
# TODO(human): Cloud Run job 에 SA 를 붙이려면 배포 주체에 iam.serviceAccounts.actAs 가 필요 — 실행 역할 천장(permissions-lint)이 금지. 보안 승인 몫 (service-cloudrun 과 같음)
terraform {
  required_version = ">= 1.11"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
  }
}

variable "cfg" {
  type = object({
    id                  = string
    name                = string
    schedule            = string
    time_zone           = optional(string)
    concurrency_policy  = optional(string)
    suspend             = optional(bool)
    backoff_limit       = optional(number)
    active_deadline_sec = optional(number)
    restart_policy      = optional(string)
    image               = string
    command_json        = optional(string)
    args_json           = optional(string)
    cpu_milli           = optional(number)
    mem_mib             = optional(number)
    env_json            = optional(string, "[]")
    identity            = string
  })
  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.cfg.image))
    error_message = "이미지는 digest 로 고정 (재현성)."
  }
  validation {
    condition     = startswith(var.cfg.name, "app-") && can(regex("^[a-z]([-a-z0-9]{0,47}[a-z0-9])?$", var.cfg.name))
    error_message = "Cloud Run job 이름은 app- 로 시작하는 소문자·숫자·-, 49자 이하 (SA·스케줄러 이름이 이름에서 파생)."
  }
  validation {
    condition     = length(split(" ", trimspace(var.cfg.schedule))) == 5
    error_message = "schedule 은 cron 5필드 (IR 그대로, Cloud Scheduler 는 그대로 받음)."
  }
  validation {
    condition     = var.cfg.concurrency_policy == null || contains(["Allow", "Forbid", "Replace"], coalesce(var.cfg.concurrency_policy, "Allow"))
    error_message = "concurrency_policy 는 Allow·Forbid·Replace."
  }
  validation {
    condition     = var.cfg.restart_policy == null || contains(["OnFailure", "Never"], coalesce(var.cfg.restart_policy, "Never"))
    error_message = "restart_policy 는 OnFailure·Never."
  }
  validation {
    condition     = var.cfg.backoff_limit == null || (coalesce(var.cfg.backoff_limit, 0) >= 0 && coalesce(var.cfg.backoff_limit, 0) == floor(coalesce(var.cfg.backoff_limit, 0)))
    error_message = "backoff_limit 은 0 이상 정수."
  }
  validation {
    condition     = var.cfg.active_deadline_sec == null || (coalesce(var.cfg.active_deadline_sec, 1) >= 1 && coalesce(var.cfg.active_deadline_sec, 1) <= 604800)
    error_message = "active_deadline_sec 는 1~604800 (Cloud Run job 제한 7일)."
  }
}
variable "project_id" { type = string }
variable "region" { type = string }
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
  env = jsondecode(coalesce(var.cfg.env_json, "[]"))
  # DRAFT(ai): Cloud Run CPU 는 1·2·4·8 → IR 값 이상인 가장 작은 정수 vCPU. 모르면 1. 메모리 최소 512Mi (service-cloudrun 과 같은 규칙)
  cpu = var.cfg.cpu_milli == null ? 1 : [for c in [1, 2, 4, 8] : c if c * 1000 >= var.cfg.cpu_milli][0]
  mem = max(512, var.cfg.mem_mib == null ? 512 : var.cfg.mem_mib)
  # SA account_id 는 6~30자: 이름 앞 20자 + 해시 4 + 역할 접미어. 이름이 길어도 겹치지 않게 해시는 전체 이름 기준
  sa_base = "${substr(var.cfg.name, 0, 20)}-${substr(sha1("${var.cfg.id}/${var.cfg.name}"), 0, 4)}"
  # restart_policy Never → 재시도 0. OnFailure·null → backoff_limit (없으면 Cloud Run 기본 3)
  max_retries = var.cfg.restart_policy == "Never" ? 0 : coalesce(var.cfg.backoff_limit, 3)
  unmapped = merge(
    contains(["Forbid", "Replace"], coalesce(var.cfg.concurrency_policy, "Allow")) ? { concurrency_policy = var.cfg.concurrency_policy } : {},
  )
}

# 잡이 도는 SA (앱 권한). 권한 연결은 root 의 identity·grants 몫 — 이 모듈은 빈 SA 만 (DRAFT(ai): 최소 권한)
resource "google_service_account" "run" {
  project      = var.project_id
  account_id   = "${local.sa_base}-r"
  display_name = "platform job ${var.cfg.id}"
}

# Cloud Scheduler 가 job 을 실행할 때 쓰는 SA: 이 job 의 run.invoker 만
resource "google_service_account" "scheduler" {
  project      = var.project_id
  account_id   = "${local.sa_base}-s"
  display_name = "platform job scheduler ${var.cfg.id}"
}

resource "google_cloud_run_v2_job" "job" {
  name                = var.cfg.name
  location            = var.region
  project             = var.project_id
  labels              = var.labels
  deletion_protection = false # DRAFT(ai): 잡은 상태가 없다
  template {
    template {
      service_account = google_service_account.run.email
      max_retries     = local.max_retries
      timeout         = var.cfg.active_deadline_sec == null ? null : "${var.cfg.active_deadline_sec}s"
      dynamic "vpc_access" {
        for_each = var.network == null ? [] : [1]
        content {
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
        dynamic "env" {
          for_each = local.env
          content {
            name  = env.value.name
            value = env.value.value
          }
        }
      }
    }
  }
}

resource "google_cloud_run_v2_job_iam_member" "invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.job.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

resource "google_cloud_scheduler_job" "job" {
  project   = var.project_id
  region    = var.region
  name      = var.cfg.name
  schedule  = trimspace(var.cfg.schedule)
  time_zone = coalesce(var.cfg.time_zone, "Etc/UTC") # DRAFT(ai): k8s CronJob 기본(UTC)과 같게
  paused    = coalesce(var.cfg.suspend, false)
  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${google_cloud_run_v2_job.job.name}:run"
    oauth_token {
      service_account_email = google_service_account.scheduler.email
    }
  }
  depends_on = [google_cloud_run_v2_job_iam_member.invoker]
}

output "job_name" { value = google_cloud_run_v2_job.job.name }
output "schedule_name" { value = google_cloud_scheduler_job.job.name }
output "cpu" { value = local.cpu }
output "mem_mib" { value = local.mem }
output "max_retries" { value = local.max_retries }
output "service_account_email" { value = google_service_account.run.email }
output "unmapped_fields" { value = local.unmapped }
