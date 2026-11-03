# kind: cache (AWS ElastiCache Redis·Valkey). for_each 키 = IR id. 항목 모양 = contracts tf-kinds.ts CacheTfVars (TA5fix: 계약이 기준)
# 원칙: null 이면 상품 기본값(DRAFT 표시), IR 값은 지어내지 않음. 저장 암호화는 항상 켬, 전송 암호화는 tls=false 일 때만 끔
terraform {
  required_version = ">= 1.11"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
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
    condition     = length(var.cfg.name) <= 40
    error_message = "ElastiCache 복제 그룹 id 는 40자 이하."
  }
  validation {
    # TODO(human): memcached 는 복제 그룹이 아니라 aws_elasticache_cluster 라 따로 만들어야 한다. 지금은 거부
    condition     = contains(["redis", "valkey"], var.cfg.engine)
    error_message = "AWS cache: engine 은 redis·valkey 만 (memcached 는 아직 없음)."
  }
  validation {
    # allow_from_json = IR 의존성 from 신원(id 목록). DRAFT(ai): 앱 신원은 모두 클러스터 SG 에서 나오므로 네트워크 허용은 클러스터 SG 하나. 목록은 모양만 본다
    condition     = can(tolist(jsondecode(var.cfg.allow_from_json)))
    error_message = "cache allow_from_json 은 JSON 배열."
  }
}
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }
variable "cluster_sg_id" {
  type    = string
  default = ""
}

locals {
  # DRAFT(ai): 못 고른 값의 상품 기본값. 버전 = 엔진별 최신 안정판
  version = coalesce(var.cfg.version, var.cfg.engine == "valkey" ? "8.0" : "7.1")
  family  = "${var.cfg.engine}${split(".", local.version)[0]}"
  # DRAFT(ai): memory_mib → 노드 급. 각 급 메모리(GiB 0.5·1.37·3.09·6.38·12.93·26.04) 안에 드는 가장 작은 급. 모르면 가장 싼 급
  mib = coalesce(var.cfg.memory_mib, 0)
  node_type = (local.mib <= 512 ? "cache.t4g.micro"
    : local.mib <= 1402 ? "cache.t4g.small"
    : local.mib <= 3164 ? "cache.t4g.medium"
    : local.mib <= 6533 ? "cache.m7g.large"
    : local.mib <= 13240 ? "cache.m7g.xlarge"
  : "cache.m7g.2xlarge")
  ha      = var.cfg.ha == true
  cluster = var.cfg.cluster_mode == true
  shards  = local.cluster ? coalesce(var.cfg.shards, 1) : null
  tls     = var.cfg.tls != false # null = 상품 기본(켬)
}

resource "aws_elasticache_subnet_group" "this" {
  name       = var.cfg.name
  subnet_ids = var.subnet_ids
}

resource "aws_security_group" "this" {
  name        = "${var.cfg.name}-sg"
  description = "Cache ${var.cfg.id}"
  vpc_id      = var.vpc_id
  dynamic "ingress" {
    for_each = var.cluster_sg_id == "" ? [] : [var.cluster_sg_id]
    content {
      description     = "Cache from EKS nodes/pods"
      from_port       = 6379
      to_port         = 6379
      protocol        = "tcp"
      security_groups = [ingress.value]
    }
  }
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id = var.cfg.name
  description          = "platform cache ${var.cfg.id}"
  engine               = var.cfg.engine
  engine_version       = local.version
  node_type            = local.node_type
  # 클러스터 모드: 샤드 수 = shards, 샤드마다 복제본 ha?1:0. 아니면 노드 ha?2:1
  cluster_mode               = local.cluster ? "enabled" : null
  num_node_groups            = local.shards
  replicas_per_node_group    = local.cluster ? (local.ha ? 1 : 0) : null
  num_cache_clusters         = local.cluster ? null : (local.ha ? 2 : 1)
  parameter_group_name       = local.cluster ? "default.${local.family}.cluster.on" : null
  automatic_failover_enabled = local.ha || local.cluster
  multi_az_enabled           = local.ha
  port                       = 6379
  subnet_group_name          = aws_elasticache_subnet_group.this.name
  security_group_ids         = [aws_security_group.this.id]
  at_rest_encryption_enabled = true
  transit_encryption_enabled = local.tls
  apply_immediately          = true
}

locals {
  endpoint = local.cluster ? aws_elasticache_replication_group.this.configuration_endpoint_address : aws_elasticache_replication_group.this.primary_endpoint_address
}

output "host" { value = local.endpoint }
output "arn" { value = aws_elasticache_replication_group.this.arn } # A8: 옮긴 IAM 권한의 Resource (root grants.tf)
output "port" { value = 6379 }
# TODO(human): auth=true 를 AWS 에서 어떻게 옮길지(auth token 은 state 에 남음). 지금은 SG(클러스터에서만)로만 막고 비밀은 없다 → 이름 출력은 빈 값
output "auth_secret" { value = "" } # KIND_INTERNAL_OUTPUTS.cache = ["auth_secret"]
# LINK_OUTPUTS.cache = host·port·url
output "link" {
  value = {
    host = local.endpoint
    port = "6379"
    url  = "${local.tls ? "rediss" : "redis"}://${local.endpoint}:6379"
  }
}
