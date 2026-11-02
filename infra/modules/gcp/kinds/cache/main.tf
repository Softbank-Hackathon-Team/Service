# kind: cache (GCP Memorystore Redis). for_each 키 = IR id. 항목 모양 = contracts tf-kinds.ts CacheTfVars (TA5fix: 계약이 기준)
# 전송 암호화·AUTH 는 IR 이 false 라고 할 때만 끔(null = 켬). AUTH 문자열은 Secret Manager 에 (이름만 출력)
terraform {
  required_version = ">= 1.11"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
  }
}

# 계약 CacheTfVars 는 모든 칸을 보낸다(nullable). optional 은 옛 호출·시험 입력(id·name 만)을 받으려고
variable "cfg" {
  type = object({
    id              = string
    name            = string
    engine          = optional(string, "redis")
    version         = optional(string)
    memory_mib      = optional(number)
    cluster_mode    = optional(bool)
    shards          = optional(number)
    tls             = optional(bool)
    auth            = optional(bool)
    ha              = optional(bool)
    allow_from_json = optional(string, "[]")
  })
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,39}$", var.cfg.name))
    error_message = "Memorystore 이름은 소문자로 시작, 40자 이하."
  }
  validation {
    # TODO(human): memcached(Memorystore for Memcached)·클러스터 모드(Memorystore Redis Cluster)는 다른 자원이라 아직 없음. 지금은 거부
    condition     = contains(["redis", "valkey"], var.cfg.engine) && var.cfg.cluster_mode != true
    error_message = "GCP cache: engine 은 redis·valkey, cluster_mode 는 아직 안 됨."
  }
  validation {
    # DRAFT(ai): allow_from_json(신원 목록)은 authorized_network(VPC) 하나로 막으므로 모양만 본다
    condition     = can(tolist(jsondecode(var.cfg.allow_from_json)))
    error_message = "cache allow_from_json 은 JSON 배열."
  }
}
variable "app_name" { type = string }
variable "region" { type = string }
variable "network_id" { type = string }
variable "labels" { type = map(string) }

locals {
  # DRAFT(ai): memory_mib → GB 올림(최소 1). 모르면 1GB
  memory_gb = max(1, ceil(coalesce(var.cfg.memory_mib, 1024) / 1024))
  # DRAFT(ai): valkey 는 Memorystore Redis 7.2(프로토콜 호환)로 옮김. redis 는 버전 그대로, 모르면 7.0
  redis_version = var.cfg.engine == "valkey" ? "REDIS_7_2" : "REDIS_${replace(coalesce(var.cfg.version, "7.0"), ".", "_")}"
  tls           = var.cfg.tls != false
  auth          = var.cfg.auth != false
}

resource "google_redis_instance" "this" {
  name                    = var.cfg.name
  region                  = var.region
  tier                    = var.cfg.ha == true ? "STANDARD_HA" : "BASIC"
  memory_size_gb          = local.memory_gb
  redis_version           = local.redis_version
  authorized_network      = var.network_id
  auth_enabled            = local.auth
  transit_encryption_mode = local.tls ? "SERVER_AUTHENTICATION" : "DISABLED"
  labels                  = var.labels
}

resource "google_secret_manager_secret" "auth" {
  count     = local.auth ? 1 : 0
  secret_id = "app-${var.app_name}-${var.cfg.id}-cache-auth"
  labels    = var.labels
  replication {
    auto {}
  }
}

# DRAFT(ai): AUTH 문자열은 프로바이더가 state 에 남긴다(원격 state 암호화 전제, DB 비밀번호와 같은 취급)
resource "google_secret_manager_secret_version" "auth" {
  count       = local.auth ? 1 : 0
  secret      = google_secret_manager_secret.auth[0].id
  secret_data = google_redis_instance.this.auth_string
}

output "host" { value = google_redis_instance.this.host }
output "port" { value = google_redis_instance.this.port }
output "auth_secret" { value = local.auth ? google_secret_manager_secret.auth[0].secret_id : "" } # KIND_INTERNAL_OUTPUTS.cache = ["auth_secret"]
output "auth_secret_resource" { value = local.auth ? google_secret_manager_secret.auth[0].id : "" }
output "server_ca_certs" { value = [for c in google_redis_instance.this.server_ca_certs : c.cert] }
# LINK_OUTPUTS.cache = host·port·url
output "link" {
  value = {
    host = google_redis_instance.this.host
    port = tostring(google_redis_instance.this.port)
    url  = "${local.tls ? "rediss" : "redis"}://${google_redis_instance.this.host}:${google_redis_instance.this.port}"
  }
}
