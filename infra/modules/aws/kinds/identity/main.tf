# kind: identity (AWS) — 서비스·잡 하나의 앱 신원: 시크릿 그릇 + IAM 역할(EKS Pod Identity) + 읽기 정책.
# for_each 키 = IR id. 변수 모양 = tf-kinds.ts IdentityTfVars
# 읽기 범위 = 이 신원의 시크릿 이름 + root 가 넘긴 DB 마스터 비밀 ARN (allow_from 에 이 신원이 있는 postgres)
terraform {
  required_version = ">= 1.11"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "cfg" {
  type = object({
    id                = string
    name              = string # boundedName({prefix:"app-", max:64}) — 실행 역할 권한 조건 때문에 그대로 씀
    service_account   = string
    secret_names_json = optional(string, "[]")
  })
  validation {
    condition     = length(var.cfg.name) <= 64 && startswith(var.cfg.name, "app-")
    error_message = "역할 이름은 app- 로 시작, 64자 이하."
  }
}
variable "app_name" { type = string }
variable "tenant_id" { type = string }
variable "region" { type = string }
variable "account_id" { type = string }
variable "namespace" { type = string }
variable "boundary_arn" { type = string } # env 모듈의 platform-app-boundary
# 같은 이름 시크릿을 여러 신원이 적으면 root 가 id 가 가장 앞선 신원만 만들게 한다 (그릇 중복 방지)
variable "owned_secret_names" {
  type    = list(string)
  default = []
}
variable "extra_readable_secret_arns" {
  type    = list(string)
  default = []
}

locals {
  secret_names  = jsondecode(coalesce(var.cfg.secret_names_json, "[]"))
  secret_prefix = "platform/${var.tenant_id}/${var.app_name}"
  # Secrets Manager ARN 은 이름 뒤에 -XXXXXX 가 붙는다 → 패턴으로 지정 (다른 신원이 만든 그릇도 읽을 수 있게)
  read_arns = concat(
    [for n in local.secret_names : "arn:aws:secretsmanager:${var.region}:${var.account_id}:secret:${local.secret_prefix}/${n}-??????"],
    var.extra_readable_secret_arns,
  )
}

resource "aws_secretsmanager_secret" "s" {
  for_each                = toset(var.owned_secret_names)
  name                    = "${local.secret_prefix}/${each.key}"
  recovery_window_in_days = 7
}

resource "aws_iam_role" "app" {
  name                 = var.cfg.name
  permissions_boundary = var.boundary_arn
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "pods.eks.amazonaws.com" }
      Action    = ["sts:AssumeRole", "sts:TagSession"]
    }]
  })
}

resource "aws_iam_role_policy" "app" {
  name = "read-own-secrets"
  role = aws_iam_role.app.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
      Resource = length(local.read_arns) > 0 ? local.read_arns : ["arn:aws:secretsmanager:${var.region}:${var.account_id}:secret:none"]
    }]
  })
}

resource "aws_eks_pod_identity_association" "app" {
  cluster_name    = var.cluster_name
  namespace       = var.namespace
  service_account = var.cfg.service_account
  role_arn        = aws_iam_role.app.arn
}

variable "cluster_name" { type = string }

output "role_arn" { value = aws_iam_role.app.arn }
output "role_name" { value = aws_iam_role.app.name }
output "secret_arns" { value = { for k, s in aws_secretsmanager_secret.s : k => s.arn } }
