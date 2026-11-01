# GCP 도착 "앱 한 개" 모듈 (클라우드 층만): Cloud SQL Postgres + 시크릿 그릇 + 앱 SA(Workload Identity).
# VPC·GKE·Artifact Registry·ESO는 환경 부트스트랩 모듈(../env) 몫. 변수는 어댑터 toTerraform()이 만든다.
terraform {
  required_version = ">= 1.11"
  required_providers {
    google     = { source = "hashicorp/google", version = "~> 6.0" }
    random     = { source = "hashicorp/random", version = "~> 3.6" }
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 2.38" }
  }
}

variable "project_id" { type = string }
variable "region" { type = string }
variable "app_name" { type = string }
variable "tenant_id" { type = string }
variable "k8s_namespace" { type = string }
variable "network_id" { type = string }       # env 모듈 출력 (VPC id)
variable "cluster_name" { type = string }     # env 모듈 출력 (GKE 이름)
variable "cluster_location" { type = string } # env 모듈 출력 (영역, 예: asia-northeast3-a)
variable "name_db_instance" { type = string }
variable "name_app_sa" {
  type = string
  validation {
    condition     = length(var.name_app_sa) >= 6 && length(var.name_app_sa) <= 30 && startswith(var.name_app_sa, "app-")
    error_message = "SA account_id는 6~30자, app- 로 시작 (setIamPolicy 조건 대상)."
  }
}
variable "secret_ids_json" { type = string } # JSON 배열 문자열
variable "db_enabled" { type = bool }
variable "db_version" {
  type = string
  validation {
    condition     = contains(["POSTGRES_15", "POSTGRES_16", "POSTGRES_17"], var.db_version)
    error_message = "지원하지 않는 Postgres 버전."
  }
}
variable "db_tier" { type = string }
variable "db_disk_gb" { type = number }

# --- Z77 DRAFT(ai): 데모 환경만 쓰는 DB 네트워크 길. 기본값 = 예전 그대로(사설 IP 만, 삭제 보호)
variable "db_public" {
  type    = bool
  default = false
}
variable "db_peer_cidrs_json" { # authorized_networks 로 들어간다 (맥 공인 IP/32, RDS 나가는 IP/32)
  type    = string
  default = "[]"
  validation {
    condition     = alltrue([for c in jsondecode(var.db_peer_cidrs_json) : can(cidrhost(c, 0)) && tonumber(split("/", c)[1]) >= 24])
    error_message = "db_peer_cidrs_json: IPv4 CIDR 이고 /24 보다 좁아야 한다 (0.0.0.0/0 금지)."
  }
}
variable "db_deletion_protection" {
  type    = bool
  default = true
}
# Z77 B': false 면 앱 신원(GSA + Workload Identity·시크릿 읽기 IAM 바인딩)을 안 만든다.
# 맥 데모 회차는 앱을 안 올리고 DB 복제만 재므로 필요 없고, IAM 부여 단계를 빼서 승인 범위를 줄인다
variable "app_identity" {
  type    = bool
  default = true
}

locals {
  secret_ids = toset(jsondecode(var.secret_ids_json))
  db         = var.db_enabled ? 1 : 0
  # Z77: cluster_name 이 빈 값이면 GKE 없이 DB·시크릿만 (Cloud SQL 실복제 데모). 네임스페이스·앱 신원은 안 만든다
  cluster    = var.cluster_name != "" ? 1 : 0
  identity   = var.app_identity && var.cluster_name != "" ? 1 : 0
  peer_cidrs = jsondecode(var.db_peer_cidrs_json) # Z77
  labels     = { managed-by = "platform", tenant = lower(replace(var.tenant_id, "/[^a-z0-9-]/", "-")), app = var.app_name }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# --- 앱 네임스페이스: Argo CD 울타리가 클러스터 범위 자원을 막으므로 Terraform이 GKE API로 만든다
data "google_client_config" "me" {}

data "google_container_cluster" "this" {
  count    = local.cluster
  name     = var.cluster_name
  location = var.cluster_location
}

provider "kubernetes" {
  host                   = try("https://${data.google_container_cluster.this[0].endpoint}", null)
  token                  = data.google_client_config.me.access_token
  cluster_ca_certificate = try(base64decode(data.google_container_cluster.this[0].master_auth[0].cluster_ca_certificate), null)
}

resource "kubernetes_namespace_v1" "app" {
  count = local.cluster
  metadata {
    name   = var.k8s_namespace
    labels = { "managed-by" = "platform", app = var.app_name, tenant = local.labels.tenant }
  }
}

# --- DB: 사설 IP만, 삭제 보호, 백업 + PITR, 논리 복제(CDC) 켬
resource "google_sql_database_instance" "db" {
  count               = local.db
  name                = var.name_db_instance
  database_version    = var.db_version
  region              = var.region
  deletion_protection = var.db_deletion_protection # Z77: 데모 DB 만 false (그날 파기)

  lifecycle {
    precondition {
      condition     = !var.db_public || length(local.peer_cidrs) >= 1
      error_message = "db_public=true 면 허용 CIDR 1개 이상(db_peer_cidrs_json)이 필요하다."
    }
  }

  settings {
    # Z77: PG16 부터 기본 에디션이 ENTERPRISE_PLUS 라 공유 코어(db-f1-micro)를 거절한다 (맥 실측 23:36Z Error 400 Invalid Tier) → 명시
    edition     = "ENTERPRISE"
    tier        = var.db_tier
    disk_size   = var.db_disk_gb
    user_labels = local.labels
    ip_configuration {
      ipv4_enabled    = var.db_public # Z77: 기본 false. 데모만 공인 IP + 허용 목록
      private_network = var.network_id
      ssl_mode        = "ENCRYPTED_ONLY" # 평문 거절
      dynamic "authorized_networks" {
        for_each = var.db_public ? local.peer_cidrs : []
        content {
          name  = "z77-peer-${replace(replace(authorized_networks.value, ".", "-"), "/", "-")}"
          value = authorized_networks.value
        }
      }
    }
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
    }
    database_flags {
      name  = "cloudsql.logical_decoding"
      value = "on"
    }
  }
}

resource "google_sql_database" "app" {
  count    = local.db
  name     = replace(var.app_name, "-", "_")
  instance = google_sql_database_instance.db[0].name
}

# DB 비밀번호: random으로 만들고 Secret Manager에 넣는다.
# DRAFT(ai): 이 값은 state에 남는다(원격 state 암호화 전제). Cloud SQL IAM 인증으로 바꾸는 건 TODO(human)
resource "random_password" "db" {
  count   = local.db
  length  = 32
  special = false
}

resource "google_sql_user" "app" {
  count    = local.db
  name     = "app"
  instance = google_sql_database_instance.db[0].name
  password = random_password.db[0].result
}

resource "google_secret_manager_secret" "db_password" {
  count     = local.db
  secret_id = "app-${var.app_name}-db-password" # app- 접두어: setIamPolicy 조건 대상
  labels    = local.labels
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "db_password" {
  count       = local.db
  secret      = google_secret_manager_secret.db_password[0].id
  secret_data = random_password.db[0].result
}

# --- 앱 시크릿: "빈 그릇"만. 값은 worker가 복사
resource "google_secret_manager_secret" "s" {
  for_each  = local.secret_ids
  secret_id = "app-${var.app_name}-${lower(replace(each.key, "_", "-"))}"
  labels    = local.labels
  replication {
    auto {}
  }
}

# --- 앱 신원: KSA → GSA (Workload Identity). 이 앱 시크릿만 읽기
resource "google_service_account" "app" {
  count        = local.identity
  account_id   = var.name_app_sa
  display_name = "platform app ${var.app_name}"
}

resource "google_service_account_iam_member" "wi" {
  count              = local.identity
  service_account_id = google_service_account.app[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[${kubernetes_namespace_v1.app[0].metadata[0].name}/${var.app_name}]"
}

locals {
  readable = merge(
    { for k, s in google_secret_manager_secret.s : k => s.id },
    var.db_enabled ? { "__db" = google_secret_manager_secret.db_password[0].id } : {},
  )
}

resource "google_secret_manager_secret_iam_member" "read" {
  for_each  = local.identity == 1 ? local.readable : {}
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.app[0].email}"
}

# Z77: 데모 네트워크 길. {tf:키} 로 REPL_*_URL 에 넣는다
output "db_public_ip" { value = var.db_enabled && var.db_public ? google_sql_database_instance.db[0].public_ip_address : "" }
# Cloud SQL 이 구독자로 상대에게 붙을 때 쓰는 나가는 IP → 상대(RDS·중계기) 허용 목록에 넣는다
output "db_outgoing_ip" {
  value = var.db_enabled && var.db_public ? try([for a in google_sql_database_instance.db[0].ip_address : a.ip_address if a.type == "OUTGOING"][0], "") : ""
}
# 서버 CA 인증서는 공개 정보다 (프로바이더가 sensitive 로 표시해서 풀어 준다) → db-ca.pem 으로 저장해 verify-ca 에 쓴다
output "db_server_ca_cert" { value = var.db_enabled ? nonsensitive(google_sql_database_instance.db[0].server_ca_cert[0].cert) : "" }
output "db_private_ip" { value = var.db_enabled ? google_sql_database_instance.db[0].private_ip_address : "" }
output "db_connection_name" { value = var.db_enabled ? google_sql_database_instance.db[0].connection_name : "" }
output "db_password_secret_id" { value = var.db_enabled ? google_secret_manager_secret.db_password[0].secret_id : "" }
output "app_gsa_email" { value = local.identity == 1 ? google_service_account.app[0].email : "" }
output "namespace" { value = local.cluster == 1 ? kubernetes_namespace_v1.app[0].metadata[0].name : "" }
