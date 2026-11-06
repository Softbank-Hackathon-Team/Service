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
  assert {
    condition     = length(google_compute_address.nat) == 1 && google_compute_router_nat.nat[0].nat_ip_allocate_option == "MANUAL_ONLY" && google_compute_address.nat[0].address_type == "EXTERNAL"
    error_message = "APP-22: NAT 는 고정 외부 주소 1개(MANUAL_ONLY)로 나간다"
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
    condition     = length(google_compute_address.nat) == 0 && length(output.nat_egress_ips) == 0
    error_message = "GKE 없으면 고정 출구 IP 도 없음(빈 목록)"
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
# B-2: 노드 SA 를 주면 노드 풀과 (만들 때만 쓰는) 기본 풀이 그 SA 를 쓴다. 안 주면 예전처럼 기본 Compute SA (node_config 블록 없음)
run "node_sa_given" {
  command = plan
  variables {
    node_service_account = "svc-gke-node@demo-proj.iam.gserviceaccount.com"
  }
  assert {
    condition     = google_container_node_pool.default[0].node_config[0].service_account == "svc-gke-node@demo-proj.iam.gserviceaccount.com"
    error_message = "노드 풀은 svc-gke-node 로 돈다"
  }
  assert {
    condition     = length(google_container_cluster.this[0].node_config) == 1 && google_container_cluster.this[0].node_config[0].service_account == "svc-gke-node@demo-proj.iam.gserviceaccount.com"
    error_message = "기본 풀도 svc-gke-node (안 주면 기본 Compute SA 의 actAs 가 필요)"
  }
}
run "node_sa_default" {
  command = plan
  assert {
    condition     = length(google_container_cluster.this[0].node_config) == 0
    error_message = "노드 SA 를 안 주면 클러스터 node_config 블록이 없다 (이미 있는 up 스크립트 클러스터가 다시 만들어지지 않게)"
  }
}
