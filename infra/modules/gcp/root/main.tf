# GCP 고정 루트 (v2): provider·클러스터 data + 종류별 모듈 module.<종류>["<IR id>"] (for_each 키 = IR id, apply 전에 앎).
# v1 app/ 은 그대로 둔다. 작업 폴더 안에서 root/ 와 kinds/ 가 형제로 놓이고 terraform 은 -chdir=root 로 돈다.
# 출력은 두 벌: link_outputs(의존성용) + v1 평평한 이름(복제·비밀번호·프록시 코드가 그대로 읽음)
# DRAFT(ai): 폴더·변수 이름은 계획 27 3.1·3.2 기준 초안
terraform {
  required_version = ">= 1.11"
  # state 는 작업 폴더 바로 아래. 상대 경로는 -chdir=root 기준
  backend "local" {
    path = "../terraform.tfstate"
  }
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
variable "network_id" { type = string }
variable "cluster_name" { # 빈 값이면 GKE 없이 DB·시크릿 신원만 (네임스페이스·신원 안 만듦, v1 과 같음)
  type    = string
  default = ""
}
variable "cluster_location" {
  type    = string
  default = ""
}

variable "postgres_json" {
  type    = string
  default = "[]"
  validation {
    condition     = can(jsondecode(var.postgres_json)) && alltrue([for p in jsondecode(var.postgres_json) : can(regex("^[a-z0-9][a-z0-9-]{0,62}$", p.id))])
    error_message = "postgres_json: JSON 배열이고 id 는 소문자·숫자·- (IR id)."
  }
  validation {
    condition     = can(jsondecode(var.postgres_json)) && alltrue([for p in jsondecode(var.postgres_json) : contains(["15", "16", "17"], p.major_version)])
    error_message = "postgres_json: 지원하지 않는 Postgres 버전 (15·16·17)."
  }
  validation {
    condition     = can(jsondecode(var.postgres_json)) && length(distinct([for p in jsondecode(var.postgres_json) : p.id])) == length(jsondecode(var.postgres_json))
    error_message = "postgres_json: id 가 겹침."
  }
}
variable "namespace_json" {
  type    = string
  default = "[]"
  validation {
    condition     = can(jsondecode(var.namespace_json))
    error_message = "namespace_json: JSON 배열이어야 함."
  }
}
variable "identity_json" {
  type    = string
  default = "[]"
  validation {
    condition     = can(jsondecode(var.identity_json)) && alltrue([for i in jsondecode(var.identity_json) : length(i.name) >= 6 && length(i.name) <= 30 && startswith(i.name, "app-")])
    error_message = "identity_json: name 은 app- 로 시작, 6~30자 (boundedName, SA account_id)."
  }
  validation {
    condition     = can(jsondecode(var.identity_json)) && length(distinct([for i in jsondecode(var.identity_json) : i.id])) == length(jsondecode(var.identity_json))
    error_message = "identity_json: id 가 겹침."
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  cluster      = var.cluster_name != "" ? 1 : 0
  tenant_label = lower(replace(var.tenant_id, "/[^a-z0-9-]/", "-"))
  labels       = { managed-by = "platform", tenant = local.tenant_label, app = var.app_name }

  postgres  = { for p in jsondecode(var.postgres_json) : p.id => p }
  namespace = local.cluster == 1 ? { for n in jsondecode(var.namespace_json) : n.name => n } : {}
  identity  = local.cluster == 1 ? { for i in jsondecode(var.identity_json) : i.id => i } : {}

  identity_ids = sort(keys(local.identity))
  secret_owner = {
    for id in local.identity_ids : id => [
      for n in jsondecode(coalesce(try(local.identity[id].secret_names_json, null), "[]")) : n
      if !anytrue([for other in local.identity_ids : index(local.identity_ids, other) < index(local.identity_ids, id) && contains(jsondecode(coalesce(try(local.identity[other].secret_names_json, null), "[]")), n)])
    ]
  }
  # 이 신원이 연결(connect)할 수 있는 postgres 의 비밀번호 secret 을 읽게 한다 (allow_from 에 신원 id)
  db_secrets = {
    for id in local.identity_ids : id => [
      for pid, p in local.postgres : "projects/${var.project_id}/secrets/app-${var.app_name}-${pid}-db-password"
      if contains(jsondecode(coalesce(try(p.allow_from_json, null), "[]")), id)
    ]
  }
  repl_key       = length(local.postgres) == 1 ? keys(local.postgres)[0] : ""
  first_identity = length(local.identity_ids) > 0 ? local.identity_ids[0] : ""
}

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

module "namespace" {
  source       = "../kinds/namespace"
  for_each     = local.namespace
  cfg          = each.value
  app_name     = var.app_name
  tenant_label = local.tenant_label
}

module "postgres" {
  source     = "../kinds/postgres"
  for_each   = local.postgres
  cfg        = each.value
  app_name   = var.app_name
  region     = var.region
  network_id = var.network_id
  labels     = local.labels
}

module "identity" {
  source                 = "../kinds/identity"
  for_each               = local.identity
  cfg                    = each.value
  app_name               = var.app_name
  project_id             = var.project_id
  labels                 = local.labels
  owned_secret_names     = local.secret_owner[each.key]
  extra_readable_secrets = local.db_secrets[each.key]
  # DB 비밀번호 secret 이 만들어진 뒤에 바인딩하도록 postgres 모듈 전체에 의존
  namespace  = try(module.namespace[var.k8s_namespace].name, var.k8s_namespace)
  depends_on = [module.postgres]
}

# --- 출력 1: link_outputs = { "<IR id>": { host, port, url, user } } (IR LINK_OUTPUTS.postgres 와 같은 이름)
output "link_outputs" {
  value = { for id, m in module.postgres : id => m.link }
}

# --- 출력 2: v1 평평한 이름 (복제 대상 postgres 1개). 없으면 빈 값
output "db_private_ip" { value = local.repl_key != "" ? module.postgres[local.repl_key].private_ip : "" }
output "db_public_ip" { value = local.repl_key != "" ? module.postgres[local.repl_key].public_ip : "" }
output "db_outgoing_ip" { value = local.repl_key != "" ? module.postgres[local.repl_key].outgoing_ip : "" }
output "db_server_ca_cert" { value = local.repl_key != "" ? module.postgres[local.repl_key].server_ca_cert : "" }
output "db_connection_name" { value = local.repl_key != "" ? module.postgres[local.repl_key].connection_name : "" }
output "db_password_secret_id" { value = local.repl_key != "" ? module.postgres[local.repl_key].password_secret : "" }
output "app_gsa_email" { value = local.first_identity != "" ? module.identity[local.first_identity].gsa_email : "" }
output "namespace" { value = length(module.namespace) > 0 ? try(module.namespace[var.k8s_namespace].name, values(module.namespace)[0].name) : "" }

output "identity_gsa_emails" {
  value = { for id, m in module.identity : id => m.gsa_email }
}
