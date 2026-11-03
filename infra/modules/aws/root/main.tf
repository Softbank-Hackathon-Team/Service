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
# A5 종류(캐시·객체저장·큐): 기본 빈 배열 = 안 만듦
variable "cache_json" {
  type    = string
  default = "[]"
  validation {
    condition     = can(jsondecode(var.cache_json)) && length(distinct([for x in jsondecode(var.cache_json) : x.id])) == length(jsondecode(var.cache_json))
    error_message = "cache_json: JSON 배열이고 id(IR id) 가 겹치면 안 됨."
  }
  # TA5fix: 모듈 안 검증과 같은 규칙을 루트에도 (계획 전에 거부, mock 시험으로 고정)
  validation {
    condition     = can(jsondecode(var.cache_json)) && alltrue([for x in jsondecode(var.cache_json) : contains(["redis", "valkey"], try(x.engine, "redis"))])
    error_message = "cache_json: engine 은 redis·valkey 만 (memcached 는 아직 없음, TODO(human))."
  }
}
variable "object_store_json" {
  type    = string
  default = "[]"
  validation {
    condition     = can(jsondecode(var.object_store_json)) && length(distinct([for x in jsondecode(var.object_store_json) : x.id])) == length(jsondecode(var.object_store_json))
    error_message = "object_store_json: JSON 배열이고 id(IR id) 가 겹치면 안 됨."
  }
  validation {
    condition     = can(jsondecode(var.object_store_json)) && alltrue([for x in jsondecode(var.object_store_json) : can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", x.name))])
    error_message = "object_store_json: 버킷 이름 규칙 위반."
  }
}
variable "queue_json" {
  type    = string
  default = "[]"
  validation {
    condition     = can(jsondecode(var.queue_json)) && length(distinct([for x in jsondecode(var.queue_json) : x.id])) == length(jsondecode(var.queue_json))
    error_message = "queue_json: JSON 배열이고 id(IR id) 가 겹치면 안 됨."
  } # TA5fix: 죽은 편지 대상은 같은 queue_json 안의 다른 model=queue 이고, 대상 자신은 또 죽은 편지를 갖지 않는다 (루트가 두 단계로 만듦)
  validation {
    condition = can(jsondecode(var.queue_json)) && alltrue([for x in jsondecode(var.queue_json) :
      try(x.dead_letter_to, null) == null ? true : (
        x.dead_letter_to != x.id && length([for t in jsondecode(var.queue_json) : t if t.id == x.dead_letter_to && try(t.model, "queue") == "queue" && try(t.dead_letter_to, null) == null]) == 1
    )])
    error_message = "queue_json: dead_letter_to 는 같은 목록의 다른 model=queue id 여야 하고, 대상 큐는 dead_letter_to 를 가질 수 없음."
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

# TA13: 관리형 컨테이너 서비스 (ECS Fargate). 항목 모양 = tf-kinds.ts ServiceTfVars. 비면 아무것도 안 만듦 (기존 계획 그대로)
variable "service_json" {
  type    = string
  default = "[]"
  validation {
    condition     = can(jsondecode(var.service_json)) && length(distinct([for x in jsondecode(var.service_json) : x.id])) == length(jsondecode(var.service_json))
    error_message = "service_json: id 가 겹침."
  }
}

# RUNTIMEMAP v2: VM 서비스 (EC2). 항목 모양 = tf-kinds.ts VmTfVars. 비면 아무것도 안 만듦 (기존 계획 그대로)
variable "vm_json" {
  type    = string
  default = "[]"
  validation {
    condition     = can(jsondecode(var.vm_json)) && length(distinct([for x in jsondecode(var.vm_json) : x.id])) == length(jsondecode(var.vm_json))
    error_message = "vm_json: id 가 겹침."
  }
  # 루트에도 같은 검사 (모듈 안 검증은 expect_failures 로 못 잡음): 대수 1~20, 이미지는 digest 고정
  validation {
    condition     = can(jsondecode(var.vm_json)) && alltrue([for x in jsondecode(var.vm_json) : x.instances >= 1 && x.instances <= 20])
    error_message = "vm_json: VM 대수(instances)는 1~20."
  }
  validation {
    condition     = can(jsondecode(var.vm_json)) && alltrue([for x in jsondecode(var.vm_json) : can(regex("@sha256:[0-9a-f]{64}$", x.image))])
    error_message = "vm_json: 이미지는 digest 로 고정 (재현성)."
  }
}

# JOBMOD: 관리형 컨테이너 예약 잡 (EventBridge Scheduler → ECS RunTask). 항목 모양 = tf-kinds.ts JobTfVars. 비면 아무것도 안 만듦 (기존 계획 그대로)
variable "job_json" {
  type    = string
  default = "[]"
  validation {
    condition     = can(jsondecode(var.job_json)) && length(distinct([for x in jsondecode(var.job_json) : x.id])) == length(jsondecode(var.job_json))
    error_message = "job_json: id 가 겹침."
  }
  validation {
    condition     = can(jsondecode(var.job_json)) && alltrue([for x in jsondecode(var.job_json) : startswith(x.name, "app-") && length(x.name) <= 58])
    error_message = "job_json: name 은 app- 로 시작, 58자 이하 (역할 이름이 이름에서 파생)."
  }
  # 모듈 안 검증과 같은 규칙을 루트에도 (계획 전에 거부, mock 시험으로 고정): cron 5필드, 요일 간격 금지, 날짜·요일 동시 지정 금지
  validation {
    condition = can(jsondecode(var.job_json)) && alltrue([for x in jsondecode(var.job_json) : length(split(" ", trimspace(x.schedule))) == 5 &&
    !strcontains(element(split(" ", trimspace(x.schedule)), 4), "/")])
    error_message = "job_json: schedule 은 cron 5필드, 요일 칸의 간격(/) 은 아직 못 옮김."
  }
  validation {
    condition = can(jsondecode(var.job_json)) && alltrue([for x in jsondecode(var.job_json) : length(split(" ", trimspace(x.schedule))) != 5 ||
    contains(["*", "?"], element(split(" ", trimspace(x.schedule)), 2)) || contains(["*", "?"], element(split(" ", trimspace(x.schedule)), 4))])
    error_message = "job_json: 날짜 칸과 요일 칸을 둘 다 정한 schedule 은 못 옮김 (cron 은 '또는', EventBridge 는 한쪽이 ? )."
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

  postgres     = { for p in jsondecode(var.postgres_json) : p.id => p }
  cache        = { for x in jsondecode(var.cache_json) : x.id => x }
  object_store = { for x in jsondecode(var.object_store_json) : x.id => x }
  queue_all    = { for x in jsondecode(var.queue_json) : x.id => x }
  # TA5fix: 죽은 편지 대상 큐를 먼저(queue_dl), 나머지(queue)는 그 출력을 참조 — 같은 for_each 안 참조는 순환이라 둘로 나눔
  queue_dl_ids = toset([for x in local.queue_all : x.dead_letter_to if try(x.dead_letter_to, null) != null])
  queue_dl     = { for id, x in local.queue_all : id => x if contains(local.queue_dl_ids, id) }
  queue        = { for id, x in local.queue_all : id => x if !contains(local.queue_dl_ids, id) }
  # TA5fix: link_outputs 는 IR id 로 합치므로 종류가 달라도 id 가 겹치면 안 된다 (VTA5h: 예전엔 조용히 덮어씀)
  link_ids = concat(keys(local.postgres), keys(local.cache), keys(local.object_store), keys(local.queue_all), keys(local.service), keys(local.job), keys(local.vm))
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

  # --- TA13: 관리형 컨테이너 (ECS) ---
  service = { for x in jsondecode(var.service_json) : x.id => x }
  # JOBMOD: 예약 잡도 ECS 를 쓴다 → 서비스 또는 잡이 있으면 ECS 공용 자원(클러스터·보안 그룹)을 만든다
  job    = { for x in jsondecode(var.job_json) : x.id => x }
  svc_on = length(local.service) + length(local.job) > 0 ? 1 : 0
  # RUNTIMEMAP v2: VM(EC2). ECS 클러스터는 필요 없고 보안 그룹만 ECS 와 같은 것을 씀 (DB 가 받아 줄 앱 쪽 그룹)
  vm    = { for x in jsondecode(var.vm_json) : x.id => x }
  vm_on = length(local.vm) > 0 ? 1 : 0
  sg_on = local.svc_on + local.vm_on > 0 ? 1 : 0
  # DRAFT(ai): env 층엔 ECS 클러스터가 없다 → 앱 루트가 클러스터·보안 그룹·Service Connect 이름 공간을 만든다 (이전마다 해시)
  svc_base = "app-${var.app_name}-${substr(sha1("${var.tenant_id}/${var.app_name}"), 0, 6)}"
  # 비밀 그릇 = 서비스들이 쓰는 이름 합집합 (k8s 신원 모듈과 같은 platform/<tenant>/<app>/<이름>, Builder 가 전체 이름을 넘김)
  svc_secret_names = toset(concat(
    flatten([for x in local.service : [for s in jsondecode(x.secrets_json) : s.secret]]),
    flatten([for x in local.vm : [for s in jsondecode(x.secrets_json) : s.secret]]),
  ))
  # env 조각의 ref("<IR id>.<출력>") 값표 = 데이터 자원 link 출력 + 서비스 주소(Service Connect: host = IR id)
  link_values = merge(
    merge([for id, m in module.postgres : { for k, v in m.link : "${id}.${k}" => v }]...),
    merge([for id, m in module.cache : { for k, v in m.link : "${id}.${k}" => v }]...),
    merge([for id, m in module.object_store : { for k, v in m.link : "${id}.${k}" => v }]...),
    merge([for id, m in module.queue_dl : { for k, v in m.link : "${id}.${k}" => v }]...),
    merge([for id, m in module.queue : { for k, v in m.link : "${id}.${k}" => v }]...),
    merge([for id, x in local.service : {
      "${id}.host" = id
      "${id}.port" = x.port == null ? "" : tostring(x.port)
      "${id}.url"  = x.port == null || x.port == 80 ? "http://${id}" : "http://${id}:${x.port}"
    }]...),
  )
  # JOBMOD: 잡 env 값이 <tf-output:link.<id>.<출력>> 한 덩어리면 같은 apply 의 값으로 풀고, 나머지는 그대로. 못 푼 자리표시가 남으면 계획에서 멈춤 (job_env 검사)
  job_env_rows = { for id, x in local.job : id => [for e in jsondecode(x.env_json) : {
    name  = e.name
    value = try(local.link_values[regex("^<tf-output:link\\.([a-z][a-z0-9-]*\\.[a-z]+)>$", e.value)[0]], e.value)
  }] }
  job_cfg = { for id, x in local.job : id => merge(x, { env_json = jsonencode(local.job_env_rows[id]) }) }
  # VM env 도 같은 규칙으로 조각을 합친다. VM 주소는 apply 뒤에야 알아서 다른 VM 을 가리키는 ref 는 Builder 가 계획 전에 막는다 (순환 방지)
  vm_cfg = { for id, x in local.vm : id => merge(x, {
    env_json = jsonencode([for e in jsondecode(x.env_json) : { name = e.name, value = join("", [for p in e.parts : p.ref == null ? p.lit : local.link_values[p.ref]]) }])
  }) }
  service_cfg = { for id, x in local.service : id => merge(x, {
    env_json = jsonencode([for e in jsondecode(x.env_json) : { name = e.name, value = join("", [for p in e.parts : p.ref == null ? p.lit : local.link_values[p.ref]]) }])
  }) }
  # DB·캐시가 받아 줄 앱 쪽 보안 그룹: 서비스가 있으면 ECS 쪽, 아니면 EKS 클러스터 SG (v1 과 같음)
  app_sg_id = local.sg_on == 1 ? aws_security_group.svc[0].id : try(data.aws_eks_cluster.this[0].vpc_config[0].cluster_security_group_id, "")
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
  cluster_sg_id = local.app_sg_id
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

module "cache" {
  source        = "../kinds/cache"
  for_each      = local.cache
  cfg           = each.value
  vpc_id        = var.vpc_id
  subnet_ids    = jsondecode(var.db_subnet_ids_json)
  cluster_sg_id = local.app_sg_id
}

module "object_store" {
  source   = "../kinds/object-store"
  for_each = local.object_store
  cfg      = each.value
}

module "queue_dl" {
  source   = "../kinds/queue"
  for_each = local.queue_dl
  cfg      = each.value
}

module "queue" {
  source          = "../kinds/queue"
  for_each        = local.queue
  cfg             = each.value
  dead_letter_arn = try(each.value.dead_letter_to, null) == null ? "" : module.queue_dl[each.value.dead_letter_to].arn
}

# --- TA13: ECS 공용 자원 (서비스가 있을 때만) ---
resource "aws_ecs_cluster" "svc" {
  count = local.svc_on
  name  = local.svc_base
}

resource "aws_service_discovery_http_namespace" "svc" {
  count = local.svc_on
  name  = local.svc_base
}

# 서비스끼리(Service Connect)만 받는다. 입구(ALB·Cloudflare)는 아직 없음 → TODO(human) 아래
resource "aws_security_group" "svc" {
  count       = local.sg_on
  name        = local.svc_base
  description = "platform ECS services / VMs"
  vpc_id      = var.vpc_id
  ingress {
    from_port = 0
    to_port   = 65535
    protocol  = "tcp"
    self      = true
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_secretsmanager_secret" "svc" {
  for_each                = local.svc_secret_names
  name                    = each.key
  recovery_window_in_days = 7
}

# TODO(human): 입구(entry) → ECS 연결 (ALB 대상 그룹 또는 Cloudflare 터널). 지금 target_group_arn 은 비움 = 내부 전용
module "service" {
  source                        = "../kinds/service-ecs"
  for_each                      = local.service_cfg
  cfg                           = each.value
  cluster_arn                   = aws_ecs_cluster.svc[0].arn
  subnet_ids                    = jsondecode(var.db_subnet_ids_json) # DRAFT(ai): env 층 사설 서브넷(DB 와 같은 곳, NAT 로 나감)
  security_group_ids            = [aws_security_group.svc[0].id]
  region                        = var.region
  boundary_arn                  = var.app_role_boundary_arn
  secret_arns                   = { for n, x in aws_secretsmanager_secret.svc : n => x.arn }
  service_connect_namespace_arn = aws_service_discovery_http_namespace.svc[0].arn
  tags                          = { managed-by = "platform", tenant = var.tenant_id, app = var.app_name }
}

# RUNTIMEMAP v2: EC2 VM (VM 이 있을 때만). 서브넷은 서비스와 같은 곳(DB 와 같은 사설), 보안 그룹은 DB 가 받아 주는 그것
module "vm" {
  source             = "../kinds/vm"
  for_each           = local.vm_cfg
  cfg                = each.value
  subnet_ids         = jsondecode(var.db_subnet_ids_json)
  security_group_ids = [aws_security_group.svc[0].id]
  region             = var.region
  boundary_arn       = var.app_role_boundary_arn
  secret_arns        = { for n, x in aws_secretsmanager_secret.svc : n => x.arn }
  tags               = { managed-by = "platform", tenant = var.tenant_id, app = var.app_name }
}

# JOBMOD: ECS 예약 잡 (잡이 있을 때만). 클러스터·서브넷·보안 그룹은 서비스와 같은 것을 씀
module "job" {
  source             = "../kinds/job"
  for_each           = local.job_cfg
  cfg                = each.value
  cluster_arn        = aws_ecs_cluster.svc[0].arn
  subnet_ids         = jsondecode(var.db_subnet_ids_json)
  security_group_ids = [aws_security_group.svc[0].id]
  region             = var.region
  boundary_arn       = var.app_role_boundary_arn
  tags               = { managed-by = "platform", tenant = var.tenant_id, app = var.app_name }
}

resource "terraform_data" "job_env" {
  lifecycle {
    precondition {
      condition     = alltrue(flatten([for id, rows in local.job_env_rows : [for e in rows : !strcontains(e.value, "<tf-output:")]]))
      error_message = "job_json: env 에 못 푼 <tf-output:…> 자리표시가 남음 (한 덩어리 link 자리표시만 지원, 대상 id·출력 이름 확인). TODO(human): 조각 목록(parts) 지원"
    }
  }
}

# TA5fix: 종류 간 같은 IR id 거부 (link_outputs 가 조용히 덮어쓰지 않게). 계획 단계에서 멈춤
resource "terraform_data" "kind_ids" {
  lifecycle {
    precondition {
      condition     = length(distinct(local.link_ids)) == length(local.link_ids)
      error_message = "postgres·cache·objectStore·queue·service·job·vm 사이에 같은 IR id 가 있음 (IR id 는 전역 유일)."
    }
  }
}

# --- 출력 1: link_outputs = { "<IR id>": { host, port, url, user } } → Helm 값 자리표시 <tf-output:link.<id>.<출력>>
# 이름은 IR LINK_OUTPUTS(postgres = host·port·url·user)와 같아야 한다 (TS 시험이 대조)
output "link_outputs" {
  value = merge(
    { for id, m in module.postgres : id => m.link },
    { for id, m in module.cache : id => m.link },
    { for id, m in module.object_store : id => m.link },
    { for id, m in module.queue_dl : id => m.link },
    { for id, m in module.queue : id => m.link },
  )
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

# TA13: 관리형 서비스 (IR id → ECS 서비스 이름). 없으면 빈 값
output "service_names" {
  value = { for id, m in module.service : id => m.service_name }
}
# RUNTIMEMAP v2: VM (IR id → 인스턴스 id 목록 / 사설 IP 목록 / 머신 종류). 없으면 빈 값
output "vm_instance_ids" {
  value = { for id, m in module.vm : id => m.instance_ids }
}
output "vm_private_ips" {
  value = { for id, m in module.vm : id => m.private_ips }
}
output "vm_machine_types" {
  value = { for id, m in module.vm : id => m.machine_type }
}
output "ecs_cluster_name" { value = local.svc_on == 1 ? aws_ecs_cluster.svc[0].name : "" }

# JOBMOD: 예약 잡 (IR id → 스케줄 이름 / ECS 가 못 옮긴 칸). 없으면 빈 값
output "job_names" {
  value = { for id, m in module.job : id => m.schedule_name }
}
output "job_unmapped_fields" {
  value = { for id, m in module.job : id => m.unmapped_fields }
}
