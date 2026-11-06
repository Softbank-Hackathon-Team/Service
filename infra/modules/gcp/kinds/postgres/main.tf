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
    db_name                = optional(string)        # DBN-1: 앱 DB 이름 그대로 (null = <앱 이름 - → _>)
    app_user               = optional(string, "app") # DBN-1·E10-2: 앱 계정 이름 그대로. 링크 user·root db_username 이 이 값
    backup_retention_days  = optional(number)        # BK-1: 출발 백업 보관 그대로 (0 = 끔, null = 상품 기본)
    pitr                   = optional(bool)          # BK-1
    maintenance_window     = optional(string)        # BK-1: "ddd:hh:mm-ddd:hh:mm" UTC. null = 상품이 고름
    port                   = optional(number)        # DM-7: Cloud SQL 은 5432 고정이라 안 씀 (다르면 Builder 사전 점검 경고)
    require_tls            = optional(bool, true)    # SSL-1: 출발이 평문 허용이면 false (DRAFT(ai))
    logical_replication    = optional(bool, true)
    allow_from_json        = optional(string, "[]")
    public                 = optional(bool, false)
    peer_cidrs_json        = optional(string, "[]")
    public_subnet_ids_json = optional(string) # aws 만 쓰는 칸 (gcp 는 무시)
    deletion_protection    = optional(bool, true)
    # 앱 계정을 Cloud SQL API 사용자로 만들지 않는다 (API 사용자는 늘 cloudsqlsuperuser 라 컷오버 울타리 DB-08 이 막는다).
    # true 면 워커가 관리자 계정으로 같은 비밀번호의 일반 LOGIN 역할을 만든다 (apps/worker relay-step ensureTargetAppLogin)
    app_login_sql = optional(bool, false)
    # 복제 길 전용 공개 주소 (중계기 이전 apply 가 덧씌운다). 앱이 붙는 주소(link.host)는 바꾸지 않는다: 앱은 사설 IP 그대로
    repl_public          = optional(bool, false)
    repl_peer_cidrs_json = optional(string, "[]")
  })
  validation {
    condition     = contains(["15", "16", "17"], var.cfg.major_version)
    error_message = "지원하지 않는 Postgres 버전."
  }
  validation {
    condition     = var.cfg.backup_retention_days == null || (var.cfg.backup_retention_days >= 0 && var.cfg.backup_retention_days <= 365)
    error_message = "Cloud SQL 백업 보관은 0~365개 (줄이지 않음 — Builder 가 계획 전에 막음)."
  }
  validation {
    condition     = var.cfg.logical_replication
    error_message = "logical_replication 은 항상 true (CDC 이전 요구)."
  }
  validation {
    # DECISION(team): 출발 DB 허용 주소는 넓어도 그대로 옮긴다 — /24 거부 같은 우리 쪽 임의 제한 없음 (TF4-2, 2026-11-03 결정). 모양(CIDR)만 본다
    condition     = alltrue([for c in jsondecode(var.cfg.peer_cidrs_json) : can(cidrhost(c, 0))])
    error_message = "peer_cidrs_json: 항목은 CIDR 이어야 한다."
  }
}
variable "app_name" { type = string }
variable "region" { type = string }
variable "network_id" { type = string }
variable "labels" { type = map(string) }

locals {
  # 플랫폼 관리자 계정: 인스턴스 이름(이전마다 해시)에서 정해져 재시도·다시 apply 해도 같다.
  #   postgres·cloudsql*·앱 계정·복제 임시 계정(repl_*_u)·svc_link_* 과 겹치지 않는 접두어
  admin_user = "svc_admin_${substr(sha256(var.cfg.name), 0, 10)}"
  # DRAFT(ai): 못 고른 값의 상품 기본값 (가장 싼 급). 공유 코어는 ha 와 같이 못 씀 → ha=true 면 IR 에서 tier 를 골라 넘겨야 함
  tier       = coalesce(var.cfg.instance_class, "db-f1-micro")
  replicas   = coalesce(var.cfg.read_replicas, 0)
  peer_cidrs = jsondecode(var.cfg.peer_cidrs_json)
  # 공개 주소 = 앱 공개(posture·DB_PUBLIC) 또는 복제 길. 허용 주소는 둘을 합친다
  ipv4_enabled = var.cfg.public || var.cfg.repl_public
  authorized   = distinct(concat(var.cfg.public ? local.peer_cidrs : [], var.cfg.repl_public ? jsondecode(var.cfg.repl_peer_cidrs_json) : []))
  db_name      = coalesce(var.cfg.db_name, replace(var.app_name, "-", "_"))
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
      condition     = (!var.cfg.public || length(local.peer_cidrs) >= 1) && (!var.cfg.repl_public || length(jsondecode(var.cfg.repl_peer_cidrs_json)) >= 1)
      error_message = "public=true 면 허용 CIDR 1개 이상(peer_cidrs_json), repl_public=true 면 repl_peer_cidrs_json 1개 이상이 필요하다."
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
      ipv4_enabled    = local.ipv4_enabled
      private_network = var.network_id
      ssl_mode        = var.cfg.require_tls ? "ENCRYPTED_ONLY" : "ALLOW_UNENCRYPTED_AND_ENCRYPTED" # SSL-1
      dynamic "authorized_networks" {
        for_each = local.authorized
        content {
          name  = "peer-${replace(replace(authorized_networks.value, ".", "-"), "/", "-")}"
          value = authorized_networks.value
        }
      }
    }
    # BK-1: 출발 백업 그대로. 0 = 끔, null = 켬(상품 기본 보관). PITR 은 출발 값, 모르면 켬 (DRAFT(ai): 예전 값)
    backup_configuration {
      enabled                        = var.cfg.backup_retention_days != 0
      point_in_time_recovery_enabled = var.cfg.backup_retention_days != 0 && coalesce(var.cfg.pitr, true)
      dynamic "backup_retention_settings" {
        for_each = coalesce(var.cfg.backup_retention_days, 0) > 0 ? [var.cfg.backup_retention_days] : []
        content {
          retained_backups = backup_retention_settings.value
          retention_unit   = "COUNT"
        }
      }
    }
    # BK-1: 유지보수 창 = 출발 시작 요일·시 (Cloud SQL 은 1시간 단위). null = 상품이 고름
    dynamic "maintenance_window" {
      for_each = var.cfg.maintenance_window == null ? [] : [var.cfg.maintenance_window]
      content {
        day  = index(["mon", "tue", "wed", "thu", "fri", "sat", "sun"], substr(maintenance_window.value, 0, 3)) + 1
        hour = tonumber(substr(maintenance_window.value, 4, 2))
      }
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
      ssl_mode        = var.cfg.require_tls ? "ENCRYPTED_ONLY" : "ALLOW_UNENCRYPTED_AND_ENCRYPTED" # SSL-1
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
  count    = var.cfg.app_login_sql ? 0 : 1
  name     = var.cfg.app_user
  instance = google_sql_database_instance.db.name
  password = random_password.db.result
}

moved {
  from = google_sql_user.app
  to   = google_sql_user.app[0]
}

# 워커가 복제·스키마 복사·울타리에 쓰는 관리자 (cloudsqlsuperuser). 앱 계정과 비밀번호·비밀 그릇을 나눈다
resource "random_password" "admin" {
  length  = 32
  special = false
}

resource "google_sql_user" "admin" {
  name     = local.admin_user
  instance = google_sql_database_instance.db.name
  password = random_password.admin.result
  lifecycle {
    precondition {
      condition     = local.admin_user != var.cfg.app_user
      error_message = "관리자 계정 이름이 앱 계정과 같다."
    }
  }
}

# 이름 끝 -db-password: 플랫폼 실행 역할의 비밀 읽기 조건(gcp-operate-db-secret-condition)과 같은 모양. 앱 신원에는 읽기를 주지 않는다
resource "google_secret_manager_secret" "admin_password" {
  secret_id = "app-${var.app_name}-${var.cfg.id}-admin-db-password"
  labels    = var.labels
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "admin_password" {
  secret      = google_secret_manager_secret.admin_password.id
  secret_data = random_password.admin.result
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
output "public_ip" { value = local.ipv4_enabled ? google_sql_database_instance.db.public_ip_address : "" }
output "outgoing_ip" {
  value = local.ipv4_enabled ? try([for a in google_sql_database_instance.db.ip_address : a.ip_address if a.type == "OUTGOING"][0], "") : ""
}
output "server_ca_cert" { value = nonsensitive(google_sql_database_instance.db.server_ca_cert[0].cert) } # 공개 정보 (verify-ca 에 씀)
output "connection_name" { value = google_sql_database_instance.db.connection_name }
output "port" { value = 5432 }
output "db_name" { value = local.db_name }
output "user" { value = var.cfg.app_user }
output "admin_user" { value = google_sql_user.admin.name }
output "admin_password_secret" { value = google_secret_manager_secret.admin_password.secret_id }
# 비밀 "이름"만. KIND_INTERNAL_OUTPUTS.postgres = ["password_secret"]
output "password_secret" { value = google_secret_manager_secret.db_password.secret_id }
output "password_secret_resource" { value = google_secret_manager_secret.db_password.id }
# Secret Manager 가 돌려준 이름 projects/<번호>/secrets/… (gcp/root 의 ESO 읽기 바인딩이 프로젝트 번호를 여기서 읽는다)
output "password_secret_name" { value = google_secret_manager_secret.db_password.name }
output "replica_names" { value = [for r in google_sql_database_instance.replica : r.name] }
# LINK_OUTPUTS.postgres = host·port·url·user (비밀번호 없음)
output "link" {
  value = {
    host = local.host
    port = "5432"
    url  = "postgresql://${var.cfg.app_user}@${local.host}:5432/${local.db_name}"
    user = var.cfg.app_user
    # CNPG-RO: 읽기 전용 주소 = 첫 읽기 복제본 사설 IP (없으면 주 서버)
    reader = length(google_sql_database_instance.replica) > 0 ? google_sql_database_instance.replica[0].private_ip_address : local.host
  }
}
