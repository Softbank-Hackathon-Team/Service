# Z77: gcp env 기본은 GKE 포함, create_gke=false 면 VPC·PSA·레지스트리만
mock_provider "google" {}
variables {
  project_id = "demo-proj"
}
run "plan_default_with_gke" {
  command = plan
  assert {
    condition     = length(google_container_cluster.this) == 1 && length(google_container_node_pool.default) == 1 && length(google_compute_router_nat.nat) == 1
    error_message = "기본은 GKE·노드·NAT 를 만든다"
  }
}
run "plan_no_gke_z77" {
  command = plan
  variables {
    create_gke = false
  }
  assert {
    condition     = length(google_container_cluster.this) == 0 && length(google_container_node_pool.default) == 0 && length(google_compute_router_nat.nat) == 0 && length(google_compute_router.r) == 0
    error_message = "create_gke=false 면 GKE·노드·NAT 없음"
  }
  assert {
    condition     = google_service_networking_connection.psa.service == "servicenetworking.googleapis.com" && google_compute_network.vpc.name == "platform-target"
    error_message = "Cloud SQL 사설 연결(PSA)·VPC 는 남아야 함"
  }
  assert {
    condition     = output.cluster_name == "" && output.cluster_location == "asia-northeast3-a"
    error_message = "GKE 없으면 cluster_name 빈 값, cluster_location 은 영역"
  }
}
