# GCP 도착 환경 부트스트랩 (테넌트 프로젝트마다 한 번): VPC + Cloud SQL 사설 연결 + GKE + Artifact Registry.
# DRAFT(ai): 데모 비용 최소 구성 — GKE Standard 영역(zonal) 클러스터, e2-standard-2 노드 2대
terraform {
  required_version = ">= 1.11"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
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

provider "google" {
  project = var.project_id
  region  = var.region
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
    # 만들 때 정한 제외 기간을 뒤 plan 이 매번 바꾸지 않게
    ignore_changes = [maintenance_policy]
  }
}

resource "google_container_node_pool" "default" {
  count      = var.create_gke ? 1 : 0
  name       = "default"
  cluster    = google_container_cluster.this[0].id
  node_count = 2
  node_config {
    machine_type = var.node_machine_type
    oauth_scopes = ["https://www.googleapis.com/auth/cloud-platform"]
    workload_metadata_config {
      mode = "GKE_METADATA"
    }
  }
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
