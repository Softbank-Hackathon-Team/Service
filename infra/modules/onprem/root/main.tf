# 온프레(k3s) 고정 루트 (v2): provider + 종류별 모듈 module.<종류>["<키>"]. DB = 차트 CNPG 라 postgres kind 없음, 클라우드 IAM 없음.
# 작업 폴더 안에서 root/ 와 kinds/ 가 형제, terraform 은 -chdir=root. state 는 작업 폴더 바로 아래.
# 출력: link_outputs(온프레는 Terraform 이 만드는 링크 대상 없음 → 빈 맵) + v1 평평한 이름 namespace
# DRAFT(ai): 폴더·변수 이름은 계획 27 3.2 기준 초안
terraform {
  required_version = ">= 1.11"
  required_providers {
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 2.38" }
    time       = { source = "hashicorp/time", version = "~> 0.13" }
  }
}

variable "kube_context" { type = string }
variable "kubeconfig_path" {
  type    = string
  default = "~/.kube/config"
}
variable "app_name" { type = string }
variable "tenant_id" { type = string }
variable "k8s_namespace" { type = string }

variable "namespace_json" {
  type    = string
  default = "[]"
  validation {
    condition     = can(jsondecode(var.namespace_json))
    error_message = "namespace_json: JSON 배열이어야 함."
  }
}
variable "netpol_json" {
  type    = string
  default = "[]"
  validation {
    condition     = can(jsondecode(var.netpol_json)) && length(distinct([for n in jsondecode(var.netpol_json) : n.id])) == length(jsondecode(var.netpol_json))
    error_message = "netpol_json: JSON 배열이고 id 가 겹치면 안 됨."
  }
  validation {
    condition     = can(jsondecode(var.netpol_json)) && alltrue([for n in jsondecode(var.netpol_json) : can(regex("^[a-z0-9][a-z0-9-]{0,62}$", n.id))])
    error_message = "netpol_json: id 는 소문자·숫자·-."
  }
}

provider "kubernetes" {
  config_path    = var.kubeconfig_path
  config_context = var.kube_context
}

locals {
  tenant_label = lower(replace(var.tenant_id, "/[^a-zA-Z0-9-]/", "-"))
  namespace    = { for n in jsondecode(var.namespace_json) : n.name => n }
  netpol       = { for n in jsondecode(var.netpol_json) : n.id => n }
}

module "namespace" {
  source       = "../kinds/namespace"
  for_each     = local.namespace
  cfg          = each.value
  app_name     = var.app_name
  tenant_label = local.tenant_label
}

module "netpol" {
  source   = "../kinds/netpol"
  for_each = local.netpol
  cfg      = each.value
  # 정책은 var.k8s_namespace 안에 만든다. 그 네임스페이스 모듈이 있으면 그 출력(= 권한 대기 뒤)을 쓴다
  namespace = try(module.namespace[var.k8s_namespace].name, var.k8s_namespace)
}

output "link_outputs" { value = {} }
output "namespace" { value = length(module.namespace) > 0 ? try(module.namespace[var.k8s_namespace].name, values(module.namespace)[0].name) : "" }
