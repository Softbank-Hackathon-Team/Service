# GCP 도착 환경 부트스트랩 (테넌트 프로젝트마다 한 번): VPC + Cloud SQL 사설 연결 + GKE + Artifact Registry.
# DRAFT(ai): 데모 비용 최소 구성 — GKE Standard 영역(zonal) 클러스터, e2-standard-2 노드 2대
terraform {
  required_version = ">= 1.11"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
    # eso.tf: ESO·ClusterSecretStore 설치용 (helm v3 문법, kubernetes 는 레포 다른 모듈과 같은 줄)
    helm       = { source = "hashicorp/helm", version = "~> 3.0" }
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 2.38" }
  }
}

variable "project_id" { type = string }
variable "region" {
  type    = string
  default = "asia-northeast3"
}
variable "zone" {
  type    = string
  default = "asia-northeast3-a"
}
variable "name" {
  type    = string
  default = "platform-target"
}
# Z77: false 면 GKE·노드·Cloud NAT 없이 VPC·Cloud SQL 사설 연결(PSA)·레지스트리만 (Cloud SQL 실복제 데모용, 몇 분이면 끝난다)
variable "create_gke" {
  type    = bool
  default = true
}
variable "node_machine_type" {
  type    = string
  default = "e2-standard-2"
}
# B-2: GKE 노드 SA. 고객 gcp-connect.sh 가 만든 svc-gke-node(로그·지표 쓰기, Artifact Registry 읽기만). 기본 Compute SA(편집자) 대신 (CIS GKE)
#   만드는 쪽(worker 가 빌린 svc-env)은 이 SA 하나에만 actAs 가 있다
#   DRAFT(ai): 기본 null = 예전처럼 기본 Compute SA (사람 권한으로 이 모듈을 직접 올리는 up 스크립트). worker 는 늘 채운다 (envLayerVars)
variable "node_service_account" {
  type     = string
  default  = null
  nullable = true
}
# FM-CLD-21 DRAFT(ai): 시연 중 GKE 자동 업그레이드(제어부 몇 분 API 끊김·노드 재시작)를 막는다. 만든 때부터 이 시간 동안 NO_UPGRADES 제외 기간.
#   날짜는 레포에 안 적는다: 만들 때 시각(plantimestamp) 기준으로 정하고, 뒤 plan 에서 안 바뀌게 ignore_changes. 0 이면 끔. 최대 720시간(30일, GKE 한도)
#   기본 0(끔): 시작 시각이 apply 때 이미 지난 값이 되는데 GKE 가 받는지 실클라우드로 확인 못 함 【미확인】. 확인 뒤 -var upgrade_freeze_hours=48
variable "upgrade_freeze_hours" {
  type    = number
  default = 0
  validation {
    condition     = var.upgrade_freeze_hours >= 0 && var.upgrade_freeze_hours <= 720
    error_message = "upgrade_freeze_hours 는 0~720"
  }
}

# ESO·ClusterSecretStore 설치 여부. create_gke=false 면 클러스터가 없으니 함께 꺼진다
#   기본 false: tools/demo-day.sh·round11/jeong-up-11.sh·up-preflight.sh 가 이 모듈을 -auto-approve 로 apply 한다.
#   클러스터를 만드는 apply 에 helm 접속이 섞이면 그 up 흐름이 깨질 수 있다 → 클러스터가 뜬 뒤 -var create_eso=true 로 따로 apply
#   주의: create_eso=true 로 설치한 뒤 기본값(false)으로 다시 apply 하면 ESO·store 가 지워진다
variable "create_eso" {
  type    = bool
  default = false
}
# ESO 차트 2.14.0 (apps/agent-worker/vendor 의 ESO CRD v2.14.0 과 같은 판). 플랫폼·온프레 설치는 아직 버전 없음
variable "eso_chart_version" {
  type    = string
  default = "2.14.0"
  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.eso_chart_version))
    error_message = "eso_chart_version 은 x.y.z 로 고정 (범위·latest 금지)"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

data "google_client_config" "me" {}

# 프로젝트 번호: Secret Manager 자원 이름은 번호(projects/<번호>/secrets/...)로 온다
data "google_project" "this" {
  count      = local.eso ? 1 : 0
  project_id = var.project_id
}

locals {
  eso       = var.create_gke && var.create_eso
  eso_ns    = "external-secrets" # 공식 차트 기본값. aws/platform 의 ESO Pod Identity 와 같은 이름
  eso_ksa   = "external-secrets" # 릴리스 이름 external-secrets → 차트 기본 SA 이름
  eso_store = "gcp-secret-manager"
  # GKE 없으면 빈 값: provider 설정만 읽히고 쓰는 자원이 0개라 plan 이 안 깨진다
  gke_host = try("https://${google_container_cluster.this[0].endpoint}", "")
  gke_ca   = try(base64decode(google_container_cluster.this[0].master_auth[0].cluster_ca_certificate), "")
}

provider "helm" {
  kubernetes = {
    host                   = local.gke_host
    token                  = data.google_client_config.me.access_token
    cluster_ca_certificate = local.gke_ca
  }
}

provider "kubernetes" {
  host                   = local.gke_host
  token                  = data.google_client_config.me.access_token
  cluster_ca_certificate = local.gke_ca
}

resource "google_project_service" "apis" {
  for_each = toset([
    "container.googleapis.com", "sqladmin.googleapis.com", "servicenetworking.googleapis.com",
    "artifactregistry.googleapis.com", "secretmanager.googleapis.com",
    # FM-CLD-14: 앱 층(gcp/root)이 쓰는 SA(iam)·플랫폼의 고객 SA 빌리기(iamcredentials) — 앱 층 apply 전 plan 단계부터 필요해서 env 층에서 켠다
    "iam.googleapis.com", "iamcredentials.googleapis.com", "compute.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

resource "google_compute_network" "vpc" {
  name                    = var.name
  auto_create_subnetworks = false
  depends_on              = [google_project_service.apis]
}

resource "google_compute_subnetwork" "nodes" {
  name          = "${var.name}-nodes"
  network       = google_compute_network.vpc.id
  region        = var.region
  ip_cidr_range = "10.50.0.0/20"
  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = "10.52.0.0/14"
  }
  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = "10.56.0.0/20"
  }
  private_ip_google_access = true
}

# Cloud SQL 사설 IP용 VPC 피어링 (Private Service Access)
resource "google_compute_global_address" "psa" {
  name          = "${var.name}-psa"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 20
  network       = google_compute_network.vpc.id
}

resource "google_service_networking_connection" "psa" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.psa.name]
  # UPREV: provider 5.x 부터 지우기가 deleteConnection 을 불러 Cloud SQL 이 없어도 "Producer services ... still using this connection"(code 9)
  #   로 실패한다 (terraform-provider-google #16275·#19908, 맥 11/2 jeong-down 782초 FAIL). 연결은 state 에서만 빼고(ABANDON),
  #   실제 피어링은 demo-day down 의 d_gke 가 destroy 전에 gcloud 로 지운다 → 그다음 주소·네트워크가 지워진다
  deletion_policy = "ABANDON"
  # GATE: 위처럼 피어링만 gcloud 로 지우고 연결 기록이 남은 채 같은 이름의 네트워크·범위로 다시 만들면 CreateConnection 이
  #   "Cannot modify allocated ranges" 로 거절될 수 있다 → 그때 provider 가 update(patch) 로 바꿔 넣는다 (provider ≥5.12, 6.x 문서 항목)
  update_on_creation_fail = true
}

# 노드가 외부 이미지를 받도록 Cloud NAT (노드는 사설 IP만)
resource "google_compute_router" "r" {
  count   = var.create_gke ? 1 : 0
  name    = "${var.name}-router"
  network = google_compute_network.vpc.id
  region  = var.region
}

# APP-22: 컷오버 전까지 도착 앱이 출발 DB 에 붙는다 → 출발 쪽 보안 그룹이 허용할 "고정" 출구 IP 가 있어야 한다.
#   노드는 사설(enable_private_nodes)이라 밖으로 나가는 길은 이 NAT 하나 → NAT 에 고정 외부 주소 1개를 붙이고 nat_egress_ips 로 내보낸다.
#   (예전 AUTO_ONLY 는 IP 가 바뀔 수 있어 허용 목록에 못 씀)
# DRAFT(ai): 주소 1개 (노드 2대·연결 수 작음. 포트 모자라면 늘림). 이름 <name>-nat-ip, 지역 = var.region
resource "google_compute_address" "nat" {
  count        = var.create_gke ? 1 : 0
  name         = "${var.name}-nat-ip"
  region       = var.region
  address_type = "EXTERNAL"
  network_tier = "PREMIUM"
  depends_on   = [google_project_service.apis]
}

resource "google_compute_router_nat" "nat" {
  count                              = var.create_gke ? 1 : 0
  name                               = "${var.name}-nat"
  router                             = google_compute_router.r[0].name
  region                             = var.region
  nat_ip_allocate_option             = "MANUAL_ONLY"
  nat_ips                            = [google_compute_address.nat[0].self_link]
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
}

resource "google_container_cluster" "this" {
  count                    = var.create_gke ? 1 : 0
  name                     = var.name
  location                 = var.zone
  network                  = google_compute_network.vpc.id
  subnetwork               = google_compute_subnetwork.nodes.id
  remove_default_node_pool = true
  initial_node_count       = 1
  deletion_protection      = false # DRAFT(ai): 데모 당일 destroy 전제

  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }
  # 만들 때 잠깐 생겼다 지워지는 기본 풀도 노드 SA 를 쓴다 (안 주면 기본 Compute SA 의 actAs 가 필요). 만든 뒤에는 보지 않는다 (아래 ignore_changes)
  dynamic "node_config" {
    for_each = var.node_service_account == null ? [] : [1]
    content {
      service_account = var.node_service_account
      oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]
    }
  }
  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }
  private_cluster_config {
    enable_private_nodes    = true
    enable_private_endpoint = false
    master_ipv4_cidr_block  = "172.16.0.0/28"
  }
  dynamic "maintenance_policy" {
    for_each = var.upgrade_freeze_hours > 0 ? [1] : []
    content {
      # DRAFT(ai): 제외 기간에는 창이 있어야 한다. UTC 19:00(한국 04:00) 매일 4시간 창 — 제외 기간 동안은 이 창에서도 업그레이드 안 함
      daily_maintenance_window {
        start_time = "19:00"
      }
      maintenance_exclusion {
        exclusion_name = "demo-freeze"
        start_time     = plantimestamp()
        end_time       = timeadd(plantimestamp(), "${var.upgrade_freeze_hours}h")
        exclusion_options {
          scope = "NO_UPGRADES"
        }
      }
    }
  }
  lifecycle {
    # 만들 때 정한 제외 기간을 뒤 plan 이 매번 바꾸지 않게. node_config 는 기본 풀(만든 뒤 지움)용이라 이미 있는 클러스터를 다시 만들지 않게
    ignore_changes = [maintenance_policy, node_config]
  }
}

resource "google_container_node_pool" "default" {
  count      = var.create_gke ? 1 : 0
  name       = "default"
  cluster    = google_container_cluster.this[0].id
  node_count = 2
  node_config {
    machine_type    = var.node_machine_type
    service_account = var.node_service_account
    oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]
    workload_metadata_config {
      mode = "GKE_METADATA"
    }
  }
}

# --- External Secrets (고객 클러스터): ESO + ClusterSecretStore "gcp-secret-manager".
#   gitops/charts/app 의 ExternalSecret 이 이 이름으로 Secret Manager 의 "app-" 비밀을 읽는다 (deploy/ci/values/gcp.json).
#   비밀 그릇·값은 여기서 만들지 않는다 (앱 층 kinds/identity·kinds/postgres 몫).
#   신원: ESO 컨트롤러 KSA external-secrets/external-secrets → Workload Identity → 아래 GSA. store 에 auth 칸 없음(ADC)
# TODO(human) B-2: 아래 신원 세 자원(GSA·프로젝트 secretAccessor·WI 바인딩)은 worker 가 빌리는 svc-env 권한 밖이다 (프로젝트 setIamPolicy·
#   svc-eso setIamPolicy 금지, 보안 조건 2). gcp-connect.sh 가 고객 svc-eso 에 WI 를 미리 묶는 안은 첫 WI 클러스터 전에는 GKE 풀이 없어
#   "Identity Pool does not exist"(400)로 막힌다 (serviceAccount:…svc.id.goog[…]·principal://… 둘 다). 어느 길로 갈지 정할 때까지
#   create_eso=true 단계는 svc-env 로 돌면 이 자원에서 403 → ENV_LAYER_APPLY_FAILED(failedPhase=eso). 사람 권한 up 스크립트는 예전 그대로
resource "google_service_account" "eso" {
  count        = local.eso ? 1 : 0
  account_id   = "${substr(var.name, 0, 24)}-eso" # account_id 30자 제한
  display_name = "External Secrets Operator (${var.name})"
  depends_on   = [google_project_service.apis]
}

# 읽기 범위: "app-" 접두어 비밀만 (버전 이름 .../secrets/app-x/versions/N 도 같은 접두어)
resource "google_project_iam_member" "eso_secret_access" {
  count   = local.eso ? 1 : 0
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.eso[0].email}"
  condition {
    title       = "eso-app-secrets-only"
    description = "ESO 는 app- 접두어 비밀만 읽는다"
    expression  = "resource.name.startsWith(\"projects/${data.google_project.this[0].number}/secrets/app-\")"
  }
}

# KSA external-secrets/external-secrets 가 이 GSA 를 빌린다
resource "google_service_account_iam_member" "eso_wi" {
  count              = local.eso ? 1 : 0
  service_account_id = google_service_account.eso[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[${local.eso_ns}/${local.eso_ksa}]"
  depends_on         = [google_container_cluster.this] # WI 풀은 클러스터가 생겨야 있다
}

resource "helm_release" "eso" {
  count            = local.eso ? 1 : 0
  name             = "external-secrets"
  repository       = "https://charts.external-secrets.io"
  chart            = "external-secrets"
  version          = var.eso_chart_version
  namespace        = local.eso_ns
  create_namespace = true
  # webhook.port 는 기본 10250 그대로: private GKE 제어부 → 노드 기본 허용 포트(443·10250). 바꾸면 방화벽 규칙이 필요하다
  values = [yamlencode({
    installCRDs = true
    serviceAccount = {
      name        = local.eso_ksa
      annotations = { "iam.gke.io/gcp-service-account" = google_service_account.eso[0].email }
    }
  })]
  depends_on = [google_container_node_pool.default, google_service_account_iam_member.eso_wi]
}

# ClusterSecretStore 는 ESO CRD·webhook 이 뜬 뒤에 (helm_release 기본 wait=true)
resource "helm_release" "secret_store" {
  count     = local.eso ? 1 : 0
  name      = "cluster-secret-store"
  chart     = "${path.module}/../../../charts/cluster-secret-store"
  namespace = local.eso_ns
  values = [yamlencode({
    name     = local.eso_store
    provider = "gcpsm"
    gcpsm    = { projectID = var.project_id }
  })]
  depends_on = [helm_release.eso, google_project_iam_member.eso_secret_access]
}

resource "google_artifact_registry_repository" "platform" {
  repository_id = "platform"
  location      = var.region
  format        = "DOCKER"
  docker_config {
    immutable_tags = true
  }
  depends_on = [google_project_service.apis]
}

output "network_id" { value = google_compute_network.vpc.id }
# APP-22: 도착 GKE 가 밖으로 나갈 때 쓰는 고정 IP 목록 (/32 없이 IP 만). 출발 SG 허용은 워커가 /32 를 붙인다. GKE 없으면 빈 목록
output "nat_egress_ips" { value = var.create_gke ? [google_compute_address.nat[0].address] : [] }
output "cluster_name" { value = var.create_gke ? google_container_cluster.this[0].name : "" }
output "cluster_location" { value = var.create_gke ? google_container_cluster.this[0].location : var.zone }
output "cluster_endpoint" { value = var.create_gke ? google_container_cluster.this[0].endpoint : "" }
output "registry_host" { value = "${var.region}-docker.pkg.dev/${var.project_id}/platform" }
output "eso_service_account_email" { value = local.eso ? google_service_account.eso[0].email : "" }
output "secret_store_name" { value = local.eso ? local.eso_store : "" }
