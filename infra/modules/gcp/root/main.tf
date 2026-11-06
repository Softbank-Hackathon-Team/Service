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
    condition     = can(jsondecode(var.cache_json)) && alltrue([for x in jsondecode(var.cache_json) : contains(["redis", "valkey"], try(x.engine, "redis")) && try(x.cluster_mode, null) != true])
    error_message = "cache_json: engine 은 redis·valkey, cluster_mode 는 아직 안 됨 (TODO(human))."
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
    condition     = can(jsondecode(var.object_store_json)) && alltrue([for x in jsondecode(var.object_store_json) : can(regex("^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$", x.name))])
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
# Argo CD 허브가 들어오는 회사 전용 플랫폼 SA (워커가 apply 때 넣는다). 빈 값이면 앱 구역에 허브 권한을 안 만든다
variable "hub_principal" {
  type    = string
  default = ""
  validation {
    condition     = var.hub_principal == "" || can(regex("^t-[0-9a-f]{28}@[a-z][a-z0-9-]{4,28}[a-z0-9]\\.iam\\.gserviceaccount\\.com$", var.hub_principal))
    error_message = "hub_principal: 회사 전용 플랫폼 SA(t-<16진 28자>@<프로젝트>.iam.gserviceaccount.com)만 된다."
  }
}
# 입구 파드(cloudflared·지표 수집기)가 ESO 로 읽는 k8s 비밀 이름 (Builder target/cloud.ts INGRESS_SECRETS). 앱 신원 몫이 아니라 kinds/identity 가 안 만든다.
#   루트가 값 없는 그릇만 만들고 ESO 에 읽기를 준다. 값(버전)은 사람이 넣는다. 비면(기본) 아무것도 안 만듦
variable "ingress_secret_names_json" {
  type    = string
  default = "[]"
  validation {
    condition     = can(jsondecode(var.ingress_secret_names_json))
    error_message = "ingress_secret_names_json: JSON 배열이어야 함."
  }
}
# 신원 = KSA 직접 주체 (kinds/identity, GSA 없음). name 칸은 GCP 에선 안 써서 검사하지 않는다
variable "identity_json" {
  type    = string
  default = "[]"
  validation {
    condition     = can(jsondecode(var.identity_json)) && length(distinct([for i in jsondecode(var.identity_json) : i.id])) == length(jsondecode(var.identity_json))
    error_message = "identity_json: id 가 겹침."
  }
}

# TA13: 관리형 컨테이너 서비스 (Cloud Run). 항목 모양 = tf-kinds.ts ServiceTfVars. 비면 아무것도 안 만듦 (기존 계획 그대로)
variable "service_json" {
  type    = string
  default = "[]"
  validation {
    condition     = can(jsondecode(var.service_json)) && length(distinct([for x in jsondecode(var.service_json) : x.id])) == length(jsondecode(var.service_json))
    error_message = "service_json: id 가 겹침."
  }
}

# APP-22 (가) DECISION(team, 11/4 01:57Z): 컷오버 전까지 도착 앱은 출발 DB 에 붙고, 컷오버 때 도착 DB 로 바꾼다 (롤백하면 다시 출발).
#   Terraform 이 앱까지 띄우는 도착(서비스·VM·잡)은 워커가 이 값을 바꿔 다시 apply 한다 (k8s 는 GitOps database.activeWriter).
#   모양 = {"active":"source"|"target", "link":{"<postgres id>":{"host","port","user","url","reader"}}, "secrets":{"<그릇>#<키>":{"secret","key"}}, "external":["<그릇 이름>"]}
#   active=source 일 때만: env 의 <postgres id>.<출력> 자리를 출발 경로 값으로, 그 postgres 와 짝인 비밀번호 줄을 출발 전용 계정 그릇(external)으로 바꾼다.
#   external 그릇은 워커가 apply 전에 만들고 값을 넣는다 (이 루트가 만들지 않음, 비밀번호는 state 에 안 들어감). 비면(기본) 지금과 같다
variable "db_writer_json" {
  type    = string
  default = "{}"
  validation {
    condition     = can(jsondecode(var.db_writer_json)) && contains(["source", "target"], try(jsondecode(var.db_writer_json).active, "target"))
    error_message = "db_writer_json: JSON 이고 active 는 source | target."
  }
}

# RUNTIMEMAP v2: VM 서비스 (GCE). 항목 모양 = tf-kinds.ts VmTfVars. 비면 아무것도 안 만듦 (기존 계획 그대로)
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

# JOBMOD: 관리형 컨테이너 예약 잡 (Cloud Scheduler → Cloud Run job). 항목 모양 = tf-kinds.ts JobTfVars. 비면 아무것도 안 만듦
variable "job_json" {
  type    = string
  default = "[]"
  validation {
    condition     = can(jsondecode(var.job_json)) && length(distinct([for x in jsondecode(var.job_json) : x.id])) == length(jsondecode(var.job_json))
    error_message = "job_json: id 가 겹침."
  }
  validation {
    condition     = can(jsondecode(var.job_json)) && alltrue([for x in jsondecode(var.job_json) : startswith(x.name, "app-") && can(regex("^[a-z]([-a-z0-9]{0,47}[a-z0-9])?$", x.name))])
    error_message = "job_json: name 은 app- 로 시작하는 소문자·숫자·-, 49자 이하 (SA·스케줄러 이름이 이름에서 파생)."
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

  postgres     = { for p in jsondecode(var.postgres_json) : p.id => p }
  cache        = { for x in jsondecode(var.cache_json) : x.id => x }
  object_store = { for x in jsondecode(var.object_store_json) : x.id => x }
  queue_all    = { for x in jsondecode(var.queue_json) : x.id => x }
  # TA5fix: 죽은 편지 대상 큐를 먼저(queue_dl), 나머지(queue)는 그 출력을 참조 — 같은 for_each 안 참조는 순환이라 둘로 나눔
  queue_dl_ids = toset([for x in local.queue_all : x.dead_letter_to if try(x.dead_letter_to, null) != null])
  queue_dl     = { for id, x in local.queue_all : id => x if contains(local.queue_dl_ids, id) }
  queue        = { for id, x in local.queue_all : id => x if !contains(local.queue_dl_ids, id) }
  # TA5fix: link_outputs 는 IR id 로 합치므로 종류가 달라도 id 가 겹치면 안 된다 (VTA5h: 예전엔 조용히 덮어씀)
  link_ids  = concat(keys(local.postgres), keys(local.cache), keys(local.object_store), keys(local.queue_all), keys(local.service), keys(local.job), keys(local.vm))
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
  # 앱 신원이 같은 이름을 이미 만들면(secret_owner) 그쪽 그릇을 쓴다. 이름 규칙은 kinds/identity 와 같다
  ingress_secrets = length(local.namespace) == 0 ? {} : {
    for n in jsondecode(var.ingress_secret_names_json) : n => "app-${var.app_name}-${lower(replace(n, "/[^A-Za-z0-9-]/", "-"))}"
    if !contains(flatten(values(local.secret_owner)), n)
  }
  repl_key       = length(local.postgres) == 1 ? keys(local.postgres)[0] : ""
  first_identity = length(local.identity_ids) > 0 ? local.identity_ids[0] : ""

  # --- TA13: 관리형 컨테이너 (Cloud Run) ---
  service = { for x in jsondecode(var.service_json) : x.id => x }
  job     = { for x in jsondecode(var.job_json) : x.id => x }
  svc_on  = length(local.service) > 0 ? 1 : 0
  # RUNTIMEMAP v2: VM(GCE)
  vm = { for x in jsondecode(var.vm_json) : x.id => x }
  # JOBMOD: 잡만 있어도 Direct VPC egress·프로젝트 번호가 필요하지는 않지만 서비스와 같은 규칙으로 DB 사설 길을 쓴다
  job_on = length(local.job) > 0 ? 1 : 0
  # 비밀 그릇 = 서비스들이 쓰는 secret id 합집합 (Builder 가 키마다 하나: app-<앱>-<비밀>-<키>. Cloud Run 은 JSON 키를 못 고름)
  svc_secret_ids = toset(concat(
    flatten([for x in local.service : [for s in jsondecode(x.secrets_json) : s.secret]]),
    flatten([for x in local.vm : [for s in jsondecode(x.secrets_json) : s.secret]]),
  ))
  # Cloud Run 주소는 결정적: https://<서비스>-<프로젝트 번호>.<리전>.run.app (모듈 출력 uri 를 쓰면 같은 for_each 안에서 순환)
  project_number = local.svc_on == 1 ? data.google_project.this[0].number : ""
  # 앱 신원(KSA 주체)도 프로젝트 번호가 필요하다. 비밀이 없는 신원(옮긴 권한만)도 있어서 ESO 처럼 그릇 이름에서 못 읽는다
  project_on = local.svc_on == 1 || length(local.identity) > 0 ? 1 : 0
  link_values_target = merge(
    merge([for id, m in module.postgres : { for k, v in m.link : "${id}.${k}" => v }]...),
    merge([for id, m in module.cache : { for k, v in m.link : "${id}.${k}" => v }]...),
    merge([for id, m in module.object_store : { for k, v in m.link : "${id}.${k}" => v }]...),
    merge([for id, m in module.queue_dl : { for k, v in m.link : "${id}.${k}" => v }]...),
    merge([for id, m in module.queue : { for k, v in m.link : "${id}.${k}" => v }]...),
    merge([for id, x in local.service : {
      "${id}.host" = "${x.name}-${local.project_number}.${var.region}.run.app"
      "${id}.port" = "443"
      "${id}.url"  = "https://${x.name}-${local.project_number}.${var.region}.run.app"
    }]...),
  )
  # APP-22 (가): 출발 쪽일 때만 덮는다 (db_writer_json 설명 참고)
  db_writer          = jsondecode(var.db_writer_json)
  db_writer_source   = try(local.db_writer.active, "target") == "source"
  db_writer_link     = { for k, v in merge({}, [for id, l in try(local.db_writer.link, {}) : { for o, x in l : "${id}.${o}" => tostring(x) }]...) : k => v if local.db_writer_source }
  db_writer_secrets  = { for k, v in try(local.db_writer.secrets, {}) : k => { secret = tostring(v.secret), key = tostring(v.key) } if local.db_writer_source }
  db_writer_external = toset([for n in try(local.db_writer.external, []) : tostring(n) if local.db_writer_source])
  link_values        = merge(local.link_values_target, local.db_writer_link)
  # JOBMOD: 잡 env 값이 <tf-output:link.<id>.<출력>> 한 덩어리면 같은 apply 의 값으로 풀고, 나머지는 그대로. 못 푼 자리표시가 남으면 계획에서 멈춤
  job_env_rows = { for id, x in local.job : id => [for e in jsondecode(x.env_json) : {
    name  = e.name
    value = try(local.link_values[regex("^<tf-output:link\\.([a-z][a-z0-9-]*\\.[a-z]+)>$", e.value)[0]], e.value)
  }] }
  job_cfg = { for id, x in local.job : id => merge(x, { env_json = jsonencode(local.job_env_rows[id]) }) }
  # VM env 도 같은 규칙으로 조각을 합친다. VM 주소는 apply 뒤에야 알아서 다른 VM 을 가리키는 ref 는 Builder 가 계획 전에 막는다 (순환 방지)
  vm_cfg = { for id, x in local.vm : id => merge(x, {
    env_json     = jsonencode([for e in jsondecode(x.env_json) : { name = e.name, value = join("", [for p in e.parts : p.ref == null ? p.lit : local.link_values[p.ref]]) }])
    secrets_json = jsonencode([for sx in jsondecode(x.secrets_json) : merge(sx, try(local.db_writer_secrets["${sx.secret}#${sx.key}"], {}))])
  }) }
  service_cfg = { for id, x in local.service : id => merge(x, {
    env_json     = jsonencode([for e in jsondecode(x.env_json) : { name = e.name, value = join("", [for p in e.parts : p.ref == null ? p.lit : local.link_values[p.ref]]) }])
    secrets_json = jsonencode([for sx in jsondecode(x.secrets_json) : merge(sx, try(local.db_writer_secrets["${sx.secret}#${sx.key}"], {}))])
  }) }
  # FM-CLD-14: 이 IR 이 쓰는 종류로 켜야 할 GCP API 를 정한다 (손으로 gcloud services enable 하지 않게). 짝: packages/adapters gcpRequiredApis
  #   env 층(gcp/env)이 이미 켜는 것(container·sqladmin·servicenetworking·artifactregistry·secretmanager·iam·iamcredentials)도 겹쳐 적어도 된다(멱등)
  required_apis = sort(distinct(concat(
    length(local.postgres) > 0 ? ["sqladmin.googleapis.com", "secretmanager.googleapis.com"] : [],
    length(local.identity) > 0 ? ["iam.googleapis.com", "secretmanager.googleapis.com"] : [],
    length(local.ingress_secrets) > 0 ? ["secretmanager.googleapis.com"] : [],
    length(local.cache) > 0 ? ["redis.googleapis.com", "secretmanager.googleapis.com"] : [],
    length(local.object_store) > 0 ? ["storage.googleapis.com"] : [],
    length(local.queue_all) > 0 ? ["pubsub.googleapis.com"] : [],
    length(local.service) > 0 ? ["run.googleapis.com", "iam.googleapis.com", "secretmanager.googleapis.com", "compute.googleapis.com"] : [],
    length(local.job) > 0 ? ["run.googleapis.com", "cloudscheduler.googleapis.com", "iam.googleapis.com"] : [],
    length(local.vm) > 0 ? ["compute.googleapis.com", "iam.googleapis.com", "secretmanager.googleapis.com"] : [],
  )))
  # DRAFT(ai): Direct VPC egress 서브넷 = env 층 이름 규칙(<네트워크>-nodes, gcp/env). env 층이 바뀌면 같이 고침
  svc_subnetwork = "projects/${var.project_id}/regions/${var.region}/subnetworks/${element(split("/", var.network_id), length(split("/", var.network_id)) - 1)}-nodes"
}

# FM-CLD-14: 필요한 API 켜기. 지울 때 끄지 않는다(같은 프로젝트의 다른 앱·env 층이 쓰는 중일 수 있음)
resource "google_project_service" "required" {
  for_each                   = toset(local.required_apis)
  project                    = var.project_id
  service                    = each.value
  disable_on_destroy         = false
  disable_dependent_services = false
}

# DRAFT(ai, #317 가): 신원 주체에도 쓴다. resourcemanager.projects.get 은 이미 실행 역할에 있다
#   (google_project_service 읽기가 부름, 신원이 있으면 iam·secretmanager API 켜기로 늘 있음) → 새 권한 아님
data "google_project" "this" {
  count      = local.project_on
  project_id = var.project_id
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
  source        = "../kinds/namespace"
  for_each      = local.namespace
  cfg           = each.value
  app_name      = var.app_name
  tenant_label  = local.tenant_label
  hub_principal = var.hub_principal
  depends_on    = [google_project_service.required]
}

module "postgres" {
  source     = "../kinds/postgres"
  for_each   = local.postgres
  cfg        = each.value
  app_name   = var.app_name
  region     = var.region
  network_id = var.network_id
  labels     = local.labels
  depends_on = [google_project_service.required]
}

module "identity" {
  source                 = "../kinds/identity"
  for_each               = local.identity
  cfg                    = each.value
  app_name               = var.app_name
  project_id             = var.project_id
  labels                 = local.labels
  project_number         = data.google_project.this[0].number
  owned_secret_names     = local.secret_owner[each.key]
  extra_readable_secrets = local.db_secrets[each.key]
  # DB 비밀번호 secret 이 만들어진 뒤에 바인딩하도록 postgres 모듈 전체에 의존
  namespace  = try(module.namespace[var.k8s_namespace].name, var.k8s_namespace)
  depends_on = [google_project_service.required, module.postgres]
}

# B-2 (나) DRAFT(ai, 보안 검토 전): env 층 ESO 는 GSA 없이 자기 KSA(external-secrets/external-secrets, gcp/env eso_ns·eso_ksa)로 Secret Manager 에 간다.
#   그래서 ESO 가 읽는 그릇마다 그 주체에 읽기를 준다 = 차트 ExternalSecret 의 remoteRef: 앱 비밀(identity 가 만든 그릇)·DB 비밀번호(postgres)·입구 비밀(아래 ingress).
#   실행 SA 의 app- 비밀 setIamPolicy(조건 only-app-prefixed) 안이라 새 권한이 없다. 프로젝트 단위 읽기는 없다.
#   k8s 도착(앱 구역 있음)만: 관리형·VM·클러스터 없는 길엔 ESO 가 없다

# 입구 비밀 그릇: 값 없이 만든다. 프로젝트 단위 읽기가 없어서 사람이 손으로 만든 그릇은 ESO 가 못 읽는다 → 그릇은 여기서, 값만 사람이
resource "google_secret_manager_secret" "ingress" {
  for_each  = local.ingress_secrets
  secret_id = each.value
  labels    = local.labels
  replication {
    auto {}
  }
  depends_on = [google_project_service.required]
}

locals {
  eso_secrets = length(local.namespace) == 0 ? {} : merge(concat(
    [{ for id, m in module.postgres : "postgres/${id}" => m.password_secret_name }],
    [for id, m in module.identity : { for n, s in m.secret_resource_names : "identity/${id}/${n}" => s }],
    [{ for n, s in google_secret_manager_secret.ingress : "ingress/${n}" => s.name }],
  )...)
}

resource "google_secret_manager_secret_iam_member" "eso" {
  for_each  = local.eso_secrets
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  # 프로젝트 번호는 Secret Manager 가 돌려준 그릇 이름(projects/<번호>/secrets/…)에서 읽는다 (data.google_project 의 resourcemanager.projects.get 없이)
  member = "principal://iam.googleapis.com/projects/${regex("^projects/([0-9]+)/secrets/", each.value)[0]}/locations/global/workloadIdentityPools/${var.project_id}.svc.id.goog/subject/ns/external-secrets/sa/external-secrets"
}

module "cache" {
  source     = "../kinds/cache"
  for_each   = local.cache
  cfg        = each.value
  app_name   = var.app_name
  region     = var.region
  network_id = var.network_id
  labels     = local.labels
  depends_on = [google_project_service.required]
}

module "object_store" {
  source     = "../kinds/object-store"
  for_each   = local.object_store
  cfg        = each.value
  region     = var.region
  labels     = local.labels
  depends_on = [google_project_service.required]
}

module "queue_dl" {
  source     = "../kinds/queue"
  for_each   = local.queue_dl
  cfg        = each.value
  labels     = local.labels
  depends_on = [google_project_service.required]
}

module "queue" {
  source            = "../kinds/queue"
  for_each          = local.queue
  cfg               = each.value
  labels            = local.labels
  dead_letter_topic = try(each.value.dead_letter_to, null) == null ? "" : module.queue_dl[each.value.dead_letter_to].topic_id
  depends_on        = [google_project_service.required]
}

# --- TA13: Cloud Run 서비스 (서비스가 있을 때만) ---
resource "google_secret_manager_secret" "svc" {
  for_each  = local.svc_secret_ids
  secret_id = each.key
  labels    = local.labels
  replication {
    auto {}
  }
  depends_on = [google_project_service.required]
}

# TODO(human): 입구(entry) → Cloud Run 연결 (Cloudflare 원점 = 서비스 uri 또는 서버리스 NEG + LB). 지금은 public=true 면 ingress ALL 만
module "service" {
  source     = "../kinds/service-cloudrun"
  for_each   = local.service_cfg
  cfg        = each.value
  project_id = var.project_id
  region     = var.region
  network    = var.network_id
  subnetwork = local.svc_subnetwork
  labels     = local.labels
  secret_ids = merge({ for n, x in google_secret_manager_secret.svc : n => x.secret_id }, { for n in local.db_writer_external : n => n })
  depends_on = [google_project_service.required]
}

# RUNTIMEMAP v2: GCE VM (VM 이 있을 때만). 서브넷은 서비스와 같은 곳(DB 사설 길 = 같은 VPC)
module "vm" {
  source     = "../kinds/vm"
  for_each   = local.vm_cfg
  cfg        = each.value
  project_id = var.project_id
  region     = var.region
  subnetwork = local.svc_subnetwork
  labels     = local.labels
  secret_ids = merge({ for n, x in google_secret_manager_secret.svc : n => x.secret_id }, { for n in local.db_writer_external : n => n })
  depends_on = [google_project_service.required]
}

# JOBMOD: Cloud Run job + Cloud Scheduler (잡이 있을 때만)
module "job" {
  source     = "../kinds/job"
  for_each   = local.job_cfg
  cfg        = each.value
  project_id = var.project_id
  region     = var.region
  network    = var.network_id
  subnetwork = local.svc_subnetwork
  labels     = local.labels
  depends_on = [google_project_service.required]
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

# --- 출력 1: link_outputs = { "<IR id>": { host, port, url, user } } (IR LINK_OUTPUTS.postgres 와 같은 이름)
output "link_outputs" {
  value = merge(
    { for id, m in module.postgres : id => m.link },
    { for id, m in module.cache : id => m.link },
    { for id, m in module.object_store : id => m.link },
    { for id, m in module.queue_dl : id => m.link },
    { for id, m in module.queue : id => m.link },
  )
}

# --- 출력 2: v1 평평한 이름 (복제 대상 postgres 1개). 없으면 빈 값
output "db_private_ip" { value = local.repl_key != "" ? module.postgres[local.repl_key].private_ip : "" }
output "db_public_ip" { value = local.repl_key != "" ? module.postgres[local.repl_key].public_ip : "" }
output "db_outgoing_ip" { value = local.repl_key != "" ? module.postgres[local.repl_key].outgoing_ip : "" }
output "db_server_ca_cert" { value = local.repl_key != "" ? module.postgres[local.repl_key].server_ca_cert : "" }
output "db_connection_name" { value = local.repl_key != "" ? module.postgres[local.repl_key].connection_name : "" }
# E10-2: 도착 DB 앱 계정 이름 (= 모듈 user = 링크 user). GCP 비밀은 비밀번호 글자뿐이라 계정 이름은 이 출력에서 읽어야 함
output "db_username" { value = local.repl_key != "" ? module.postgres[local.repl_key].user : "" }
output "db_name" { value = local.repl_key != "" ? module.postgres[local.repl_key].db_name : "" }
output "db_password_secret_id" { value = local.repl_key != "" ? module.postgres[local.repl_key].password_secret : "" }
# 워커 관리자 계정 (앱 계정 db_username 과 다른 이름·다른 비밀). 실행기가 비밀번호를 db-secret.json 의 db_admin_password 로 꺼낸다
output "db_admin_username" { value = local.repl_key != "" ? module.postgres[local.repl_key].admin_user : "" }
output "db_admin_password_secret_id" { value = local.repl_key != "" ? module.postgres[local.repl_key].admin_password_secret : "" }
# 대표 신원의 IAM 주체 (보안 실측 iam.app_identity). 예전 app_gsa_email 대신 (#317 가: GSA 없음)
output "app_principal" { value = local.first_identity != "" ? module.identity[local.first_identity].principal : "" }
output "namespace" { value = length(module.namespace) > 0 ? try(module.namespace[var.k8s_namespace].name, values(module.namespace)[0].name) : "" }
# 허브 cluster Secret 재료 (apps/worker/src/gitops/bundle.ts gkeClusterSecret). GKE 없으면 빈 값
output "cluster_endpoint" { value = try(data.google_container_cluster.this[0].endpoint, "") }
output "cluster_ca_certificate" { value = try(data.google_container_cluster.this[0].master_auth[0].cluster_ca_certificate, "") }

# 신원별 IAM 주체 principal://…/subject/ns/<구역>/sa/<KSA> (워커가 identity.<id>.principal 로 펼침)
output "identity_principals" {
  value = { for id, m in module.identity : id => m.principal }
}

# TA13: 관리형 서비스 (IR id → Cloud Run 이름·주소). 없으면 빈 값
output "service_names" {
  value = { for id, m in module.service : id => m.service_name }
}
output "service_urls" {
  value = { for id, m in module.service : id => m.uri }
}

# RUNTIMEMAP v2: VM (IR id → 인스턴스 이름 목록 / 사설 IP 목록 / 머신 종류). 없으면 빈 값
output "vm_instance_names" {
  value = { for id, m in module.vm : id => m.instance_names }
}
output "vm_private_ips" {
  value = { for id, m in module.vm : id => m.private_ips }
}
output "vm_machine_types" {
  value = { for id, m in module.vm : id => m.machine_type }
}

# JOBMOD: 예약 잡 (IR id → Cloud Run job 이름 / Cloud Run 이 못 옮긴 칸). 없으면 빈 값
output "job_names" {
  value = { for id, m in module.job : id => m.job_name }
}
output "job_unmapped_fields" {
  value = { for id, m in module.job : id => m.unmapped_fields }
}
