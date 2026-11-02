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

provider "google" {
  project = var.project_id
  region  = var.region
}

resource "google_project_service" "apis" {
  for_each = toset([
    "container.googleapis.com", "sqladmin.googleapis.com", "servicenetworking.googleapis.com",
    "artifactregistry.googleapis.com", "secretmanager.googleapis.com",
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
}

# 노드가 외부 이미지를 받도록 Cloud NAT (노드는 사설 IP만)
resource "google_compute_router" "r" {
  count   = var.create_gke ? 1 : 0
  name    = "${var.name}-router"
  network = google_compute_network.vpc.id
  region  = var.region
}

resource "google_compute_router_nat" "nat" {
  count                              = var.create_gke ? 1 : 0
  name                               = "${var.name}-nat"
  router                             = google_compute_router.r[0].name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
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
output "cluster_name" { value = var.create_gke ? google_container_cluster.this[0].name : "" }
output "cluster_location" { value = var.create_gke ? google_container_cluster.this[0].location : var.zone }
output "cluster_endpoint" { value = var.create_gke ? google_container_cluster.this[0].endpoint : "" }
output "registry_host" { value = "${var.region}-docker.pkg.dev/${var.project_id}/platform" }
