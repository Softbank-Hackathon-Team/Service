# Azure 도착 "앱 한 개" 모듈 — Mock (아키텍처 전제: Azure는 모양 + Mock).
# 실계정 없음 → terraform validate까지만. apply 하지 않는다.
terraform {
  required_version = ">= 1.11"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.0" }
  }
}

variable "location" { type = string }
variable "app_name" { type = string }
variable "tenant_id" { type = string }
variable "k8s_namespace" { type = string }
variable "aks_oidc_issuer_url" { type = string }
variable "resource_group" { type = string } # 부트스트랩 출력
variable "delegated_subnet_id" { type = string }
variable "private_dns_zone_id" { type = string }
variable "azure_tenant_id" { type = string }
variable "name_key_vault" {
  type = string
  validation {
    condition     = can(regex("^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$", var.name_key_vault))
    error_message = "Key Vault 이름은 3~24자, 영문 시작."
  }
}
variable "name_db_server" { type = string }
variable "db_enabled" { type = bool }
variable "db_version" {
  type = string
  validation {
    condition     = contains(["15", "16", "17"], var.db_version)
    error_message = "지원하지 않는 Postgres 버전."
  }
}
variable "db_storage_mb" { type = number }

provider "azurerm" {
  features {}
}

locals {
  tags = { managed-by = "platform", tenant = var.tenant_id, app = var.app_name }
  db   = var.db_enabled ? 1 : 0
}

resource "azurerm_postgresql_flexible_server" "db" {
  count                         = local.db
  name                          = var.name_db_server
  resource_group_name           = var.resource_group
  location                      = var.location
  version                       = var.db_version
  sku_name                      = "B_Standard_B1ms"
  storage_mb                    = var.db_storage_mb
  delegated_subnet_id           = var.delegated_subnet_id
  private_dns_zone_id           = var.private_dns_zone_id
  public_network_access_enabled = false
  backup_retention_days         = 7
  tags                          = local.tags

  authentication {
    active_directory_auth_enabled = true
    password_auth_enabled         = false # 비밀번호 없음 → state에 비밀 0
    tenant_id                     = var.azure_tenant_id
  }
}

resource "azurerm_postgresql_flexible_server_database" "app" {
  count     = local.db
  name      = replace(var.app_name, "-", "_")
  server_id = azurerm_postgresql_flexible_server.db[0].id
}

resource "azurerm_key_vault" "kv" {
  name                       = var.name_key_vault
  resource_group_name        = var.resource_group
  location                   = var.location
  tenant_id                  = var.azure_tenant_id
  sku_name                   = "standard"
  purge_protection_enabled   = true
  rbac_authorization_enabled = true
  tags                       = local.tags
}

# 앱 신원: AKS Workload Identity (KSA ↔ 관리 ID 연합)
resource "azurerm_user_assigned_identity" "app" {
  name                = "id-${var.app_name}"
  resource_group_name = var.resource_group
  location            = var.location
  tags                = local.tags
}

resource "azurerm_federated_identity_credential" "app" {
  name                = "ksa-${var.app_name}"
  resource_group_name = var.resource_group
  parent_id           = azurerm_user_assigned_identity.app.id
  audience            = ["api://AzureADTokenExchange"]
  issuer              = var.aks_oidc_issuer_url
  subject             = "system:serviceaccount:${var.k8s_namespace}:${var.app_name}"
}

output "app_identity_client_id" { value = azurerm_user_assigned_identity.app.client_id }
output "db_fqdn" { value = var.db_enabled ? azurerm_postgresql_flexible_server.db[0].fqdn : "" }
output "key_vault_uri" { value = azurerm_key_vault.kv.vault_uri }
