# kind: postgres (GCP Cloud SQL). for_each 키 = IR id. 변수 모양 = packages/contracts/src/tf-kinds.ts PostgresTfVars
# 원칙: null 이면 상품 기본값(DRAFT 표시), IR 값은 지어내지 않고 그대로. v1 app/ 모듈의 DB 부분과 같은 보안 기본값
terraform {
  required_version = ">= 1.11"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

variable "cfg" {
  type = object({
    id                     = string
    name                   = string
    major_version          = string
    storage_gb             = number
    storage_max_gb         = optional(number)
    instance_class         = optional(string)
    ha                     = optional(bool)
    read_replicas          = optional(number)
    parameters_json        = optional(string, "{}")
    logical_replication    = optional(bool, true)
    allow_from_json        = optional(string, "[]")
    public                 = optional(bool, false)
    peer_cidrs_json        = optional(string, "[]")
    public_subnet_ids_json = optional(string) # aws 만 쓰는 칸 (gcp 는 무시)
    deletion_protection    = optional(bool, true)
  })
  validation {
    condition     = contains(["15", "16", "17"], var.cfg.major_version)
    error_message = "지원하지 않는 Postgres 버전."
  }
  validation {
    condition     = var.cfg.logical_replication
    error_message = "logical_replication 은 항상 true (CDC 이전 요구)."
  }
  validation {
    condition     = alltrue([for c in jsondecode(var.cfg.peer_cidrs_json) : can(cidrhost(c, 0)) && tonumber(split("/", c)[1]) >= 24])
    error_message = "peer_cidrs_json: IPv4 CIDR 이고 /24 보다 좁아야 한다 (0.0.0.0/0 금지)."
  }
}
variable "app_name" { type = string }
variable "region" { type = string }
variable "network_id" { type = string }
variable "labels" { type = map(string) }

locals {
  # DRAFT(ai): 못 고른 값의 상품 기본값 (가장 싼 급). 공유 코어는 ha 와 같이 못 씀 → ha=true 면 IR 에서 tier 를 골라 넘겨야 함
  tier       = coalesce(var.cfg.instance_class, "db-f1-micro")
  replicas   = coalesce(var.cfg.read_replicas, 0)
  peer_cidrs = jsondecode(var.cfg.peer_cidrs_json)
  db_name    = replace(var.app_name, "-", "_")
  # IR 파라미터 그대로 + 플랫폼 요구(논리 디코딩)가 이긴다
  flags = merge(
    { for k, v in jsondecode(var.cfg.parameters_json) : k => tostring(v) },
    { "cloudsql.logical_decoding" = "on" },
  )
}

resource "google_sql_database_instance" "db" {
  name                = var.cfg.name
  database_version    = "POSTGRES_${var.cfg.major_version}"
  region              = var.region
  deletion_protection = var.cfg.deletion_protection

  lifecycle {
    precondition {
      condition     = !var.cfg.public || length(local.peer_cidrs) >= 1
      error_message = "public=true 면 허용 CIDR 1개 이상(peer_cidrs_json)이 필요하다."
    }
  }

  settings {
    edition               = "ENTERPRISE" # v1 실측: PG16+ 기본이 ENTERPRISE_PLUS 라 공유 코어를 거절 → 명시
    tier                  = local.tier
    disk_size             = var.cfg.storage_gb
    disk_autoresize       = var.cfg.storage_max_gb != null
    disk_autoresize_limit = var.cfg.storage_max_gb != null ? var.cfg.storage_max_gb : 0
    availability_type     = var.cfg.ha == true ? "REGIONAL" : "ZONAL"
    user_labels           = var.labels
    ip_configuration {
      ipv4_enabled    = var.cfg.public
      private_network = var.network_id
      ssl_mode        = "ENCRYPTED_ONLY"
      dynamic "authorized_networks" {
        for_each = var.cfg.public ? local.peer_cidrs : []
        content {
          name  = "peer-${replace(replace(authorized_networks.value, ".", "-"), "/", "-")}"
          value = authorized_networks.value
        }
      }
    }
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
    }
    dynamic "database_flags" {
      for_each = local.flags
      content {
        name  = database_flags.key
        value = database_flags.value
      }
    }
  }
}

resource "google_sql_database_instance" "replica" {
  count                = local.replicas
  name                 = "${var.cfg.name}-r${count.index + 1}"
  master_instance_name = google_sql_database_instance.db.name
  database_version     = "POSTGRES_${var.cfg.major_version}"
  region               = var.region
  deletion_protection  = var.cfg.deletion_protection
  settings {
    edition     = "ENTERPRISE"
    tier        = local.tier
    user_labels = var.labels
    ip_configuration {
      ipv4_enabled    = var.cfg.public
      private_network = var.network_id
      ssl_mode        = "ENCRYPTED_ONLY"
    }
  }
}

resource "google_sql_database" "app" {
  name     = local.db_name
  instance = google_sql_database_instance.db.name
}

# DB 비밀번호: random → Secret Manager. DRAFT(ai): 값은 state 에 남는다(원격 state 암호화 전제, v1 과 같음)
resource "random_password" "db" {
  length  = 32
  special = false
}

resource "google_sql_user" "app" {
  name     = "app"
  instance = google_sql_database_instance.db.name
  password = random_password.db.result
}

resource "google_secret_manager_secret" "db_password" {
  secret_id = "app-${var.app_name}-${var.cfg.id}-db-password" # app- 접두어: setIamPolicy 조건 대상
  labels    = var.labels
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "db_password" {
  secret      = google_secret_manager_secret.db_password.id
  secret_data = random_password.db.result
}

locals {
  private_ip = google_sql_database_instance.db.private_ip_address
  # 공개 DB 일 때만 공인 IP 가 있다. 비공개면 사설 IP 가 주소
  host = var.cfg.public ? google_sql_database_instance.db.public_ip_address : local.private_ip
}

output "address" { value = local.host }
output "private_ip" { value = local.private_ip }
output "public_ip" { value = var.cfg.public ? google_sql_database_instance.db.public_ip_address : "" }
output "outgoing_ip" {
  value = var.cfg.public ? try([for a in google_sql_database_instance.db.ip_address : a.ip_address if a.type == "OUTGOING"][0], "") : ""
}
output "server_ca_cert" { value = nonsensitive(google_sql_database_instance.db.server_ca_cert[0].cert) } # 공개 정보 (verify-ca 에 씀)
output "connection_name" { value = google_sql_database_instance.db.connection_name }
output "port" { value = 5432 }
output "db_name" { value = local.db_name }
output "user" { value = "app" }
# 비밀 "이름"만. KIND_INTERNAL_OUTPUTS.postgres = ["password_secret"]
output "password_secret" { value = google_secret_manager_secret.db_password.secret_id }
output "password_secret_resource" { value = google_secret_manager_secret.db_password.id }
output "replica_names" { value = [for r in google_sql_database_instance.replica : r.name] }
# LINK_OUTPUTS.postgres = host·port·url·user (비밀번호 없음)
output "link" {
  value = {
    host = local.host
    port = "5432"
    url  = "postgresql://app@${local.host}:5432/${local.db_name}"
    user = "app"
  }
}
