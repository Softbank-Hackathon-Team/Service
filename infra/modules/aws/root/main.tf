# AWS 고정 루트 (v2): provider·클러스터 data + 종류별 모듈 module.<종류>["<IR id>"] (for_each 키 = IR id, apply 전에 앎).
# v1 app/ 은 그대로 둔다. 작업 폴더 안에서 root/ 와 kinds/ 가 형제로 놓이고 terraform 은 -chdir=root 로 돈다.
# 변수는 어댑터 toTerraformV2()가 만든다 (평평한 값 + 종류별 목록은 *_json 문자열).
# 출력은 두 벌: link_outputs(의존성용) + v1 평평한 이름(복제·비밀번호·프록시 코드가 그대로 읽음)
# DRAFT(ai): 폴더·변수 이름은 계획 27 3.1·3.2 기준 초안
terraform {
  required_version = ">= 1.11"
  # state 는 작업 폴더 바로 아래 (findWorkDir·destroy·list 가 지금 위치 그대로 찾게). 상대 경로는 -chdir=root 기준
  backend "local" {
    path = "../terraform.tfstate"
  }
  required_providers {
    aws        = { source = "hashicorp/aws", version = "~> 6.0" }
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 2.38" }
  }
}

variable "expected_account_id" { type = string }
variable "region" { type = string }
variable "app_name" { type = string }
variable "tenant_id" { type = string }
variable "cluster_name" { # 빈 값이면 클러스터 쪽(네임스페이스·Pod Identity·클러스터 SG 허용)을 건너뛰고 RDS 만 (v1 과 같음)
  type    = string
  default = ""
}
variable "vpc_id" { type = string }
variable "db_subnet_ids_json" { type = string }
variable "k8s_namespace" { type = string }
variable "app_role_boundary_arn" { type = string }

# 종류별 목록: JSON 배열 문자열. 항목 모양 = packages/contracts/src/tf-kinds.ts
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
    condition     = can(jsondecode(var.identity_json)) && alltrue([for i in jsondecode(var.identity_json) : length(i.name) <= 64 && startswith(i.name, "app-")])
    error_message = "identity_json: name 은 app- 로 시작, 64자 이하 (boundedName)."
  }
  validation {
    condition     = can(jsondecode(var.identity_json)) && length(distinct([for i in jsondecode(var.identity_json) : i.id])) == length(jsondecode(var.identity_json))
    error_message = "identity_json: id 가 겹침."
  }
}

provider "aws" {
  region = var.region
  # 잘못된 계정에 만드는 사고 방지
  allowed_account_ids = [var.expected_account_id]
  default_tags {
    tags = { managed-by = "platform", tenant = var.tenant_id, app = var.app_name }
  }
}

locals {
  cluster      = var.cluster_name == "" ? 0 : 1
  tenant_label = lower(replace(var.tenant_id, "/[^a-zA-Z0-9-]/", "-"))

  postgres = { for p in jsondecode(var.postgres_json) : p.id => p }
  # 클러스터 없이는 k8s 쪽 종류(namespace·identity)를 안 만든다
  namespace = local.cluster == 1 ? { for n in jsondecode(var.namespace_json) : n.name => n } : {}
  identity  = local.cluster == 1 ? { for i in jsondecode(var.identity_json) : i.id => i } : {}

  identity_ids = sort(keys(local.identity))
  # 같은 시크릿 이름은 id 가 가장 앞선 신원만 만든다
  secret_owner = {
    for id in local.identity_ids : id => [
      for n in jsondecode(coalesce(try(local.identity[id].secret_names_json, null), "[]")) : n
      if !anytrue([for other in local.identity_ids : index(local.identity_ids, other) < index(local.identity_ids, id) && contains(jsondecode(coalesce(try(local.identity[other].secret_names_json, null), "[]")), n)])
    ]
  }
  # 이 신원이 연결(connect)할 수 있는 postgres 의 마스터 비밀을 읽게 한다 (allow_from 에 신원 id)
  db_secret_arns = {
    for id in local.identity_ids : id => [
      for pid, p in local.postgres : module.postgres[pid].password_secret
      if contains(jsondecode(coalesce(try(p.allow_from_json, null), "[]")), id)
    ]
  }
  # v1 평평한 출력의 대상: postgres 가 정확히 1개일 때 그것 (2개 이상 복제는 precheck 가 막음)
  repl_key = length(local.postgres) == 1 ? keys(local.postgres)[0] : ""
  # v1 app_role_arn 자리: 신원이 있으면 id 가 가장 앞선 것 (DRAFT(ai): 여러 개면 대표 하나)
  first_identity = length(local.identity_ids) > 0 ? local.identity_ids[0] : ""
}

data "aws_eks_cluster" "this" {
  count = local.cluster
  name  = var.cluster_name
}
data "aws_eks_cluster_auth" "this" {
  count = local.cluster
  name  = var.cluster_name
}

provider "kubernetes" {
  host                   = try(data.aws_eks_cluster.this[0].endpoint, null)
  cluster_ca_certificate = try(base64decode(data.aws_eks_cluster.this[0].certificate_authority[0].data), null)
  token                  = try(data.aws_eks_cluster_auth.this[0].token, null)
}

module "namespace" {
  source       = "../kinds/namespace"
  for_each     = local.namespace
  cfg          = each.value
  app_name     = var.app_name
  tenant_label = local.tenant_label
}

module "postgres" {
  source        = "../kinds/postgres"
  for_each      = local.postgres
  cfg           = each.value
  app_name      = var.app_name
  vpc_id        = var.vpc_id
  subnet_ids    = jsondecode(var.db_subnet_ids_json)
  cluster_sg_id = try(data.aws_eks_cluster.this[0].vpc_config[0].cluster_security_group_id, "")
}

module "identity" {
  source                     = "../kinds/identity"
  for_each                   = local.identity
  cfg                        = each.value
  app_name                   = var.app_name
  tenant_id                  = var.tenant_id
  region                     = var.region
  account_id                 = var.expected_account_id
  cluster_name               = var.cluster_name
  boundary_arn               = var.app_role_boundary_arn
  owned_secret_names         = local.secret_owner[each.key]
  extra_readable_secret_arns = local.db_secret_arns[each.key]
  # 네임스페이스 모듈이 있으면 그 출력(= 만든 뒤)을 쓴다. 없으면 변수 그대로
  namespace = try(module.namespace[var.k8s_namespace].name, var.k8s_namespace)
}

# --- 출력 1: link_outputs = { "<IR id>": { host, port, url, user } } → Helm 값 자리표시 <tf-output:link.<id>.<출력>>
# 이름은 IR LINK_OUTPUTS(postgres = host·port·url·user)와 같아야 한다 (TS 시험이 대조)
output "link_outputs" {
  value = { for id, m in module.postgres : id => m.link }
}

# --- 출력 2: v1 평평한 이름 (복제 대상 postgres 1개). 없으면 빈 값 — fetchSecret·DB_ADDR_OUTPUT·복제 {tf:키} 수정 0
output "db_address" { value = local.repl_key != "" ? module.postgres[local.repl_key].address : "" }
output "db_public" { value = local.repl_key != "" ? module.postgres[local.repl_key].public : false }
output "db_ca_cert_identifier" { value = local.repl_key != "" ? module.postgres[local.repl_key].ca_cert_identifier : "" }
output "db_master_secret_arn" { value = local.repl_key != "" ? module.postgres[local.repl_key].password_secret : "" }
output "app_role_arn" { value = local.first_identity != "" ? module.identity[local.first_identity].role_arn : "" }
output "namespace" { value = length(module.namespace) > 0 ? try(module.namespace[var.k8s_namespace].name, values(module.namespace)[0].name) : "" }

# 신원별 역할 (서비스가 여러 개일 때 배포 값에 쓰라고 — 평평한 app_role_arn 은 대표 하나)
output "identity_role_arns" {
  value = { for id, m in module.identity : id => m.role_arn }
}
