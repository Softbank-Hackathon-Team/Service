# 중계기 이전 복제 길(repl_public): Cloud SQL 에 공개 주소와 허용 주소를 주되, 앱이 붙는 주소(link.host)는 사설 IP 그대로.
#   app_login_sql 이면 앱 계정을 Cloud SQL API 사용자로 만들지 않는다 (관리자는 따로)
mock_provider "google" {
  mock_data "google_container_cluster" {
    defaults = {
      endpoint    = "10.0.0.2"
      master_auth = [{ cluster_ca_certificate = "bW9jaw==" }]
    }
  }
  mock_data "google_client_config" {
    defaults = { access_token = "mock-token" }
  }
  mock_resource "google_sql_database_instance" {
    defaults = {
      public_ip_address  = "34.64.10.20"
      private_ip_address = "10.1.0.5"
      ip_address         = [{ ip_address = "34.64.10.20", type = "PRIMARY" }, { ip_address = "34.64.10.99", type = "OUTGOING" }]
      server_ca_cert     = [{ cert = "-----BEGIN CERTIFICATE-----\nmock\n-----END CERTIFICATE-----" }]
    }
  }
  mock_resource "google_secret_manager_secret" {
    defaults = { name = "projects/123/secrets/mock" }
  }
}
mock_provider "kubernetes" {}
mock_provider "random" {}

variables {
  project_id       = "demo-project"
  region           = "asia-northeast3"
  app_name         = "shop"
  tenant_id        = "t-aaaa1111"
  k8s_namespace    = "app-shop"
  network_id       = "projects/demo-project/global/networks/platform"
  cluster_name     = "platform-gke"
  cluster_location = "asia-northeast3-a"
  namespace_json   = "[]"
  identity_json    = "[]"
}

run "repl_public_keeps_app_private" {
  command = apply
  variables {
    postgres_json = jsonencode([
      { id = "shop-db", name = "shop-db-ab12", major_version = "16", storage_gb = 20, logical_replication = true, allow_from_json = "[]", public = false, peer_cidrs_json = "[]", repl_public = true, repl_peer_cidrs_json = "[\"198.51.100.7/32\",\"203.0.113.50/32\"]", app_login_sql = true },
    ])
  }
  assert {
    condition     = output.db_public_ip == "34.64.10.20" && output.db_outgoing_ip == "34.64.10.99"
    error_message = "복제 길이 켜지면 공개·나가는 IP 출력이 있어야 한다"
  }
  assert {
    condition     = module.postgres["shop-db"].link.host == "10.1.0.5"
    error_message = "앱 주소는 사설 IP 그대로여야 한다 (복제 길 때문에 공개 IP 로 바뀌면 GKE 앱이 못 붙는다)"
  }
  assert {
    condition     = output.db_username == "app" && startswith(output.db_admin_username, "svc_admin_")
    error_message = "앱 계정 이름 출력은 그대로, 관리자는 따로"
  }
}

run "private_by_default" {
  command = apply
  variables {
    postgres_json = jsonencode([
      { id = "shop-db", name = "shop-db-ab12", major_version = "16", storage_gb = 20, logical_replication = true, allow_from_json = "[]", public = false, peer_cidrs_json = "[]" },
    ])
  }
  assert {
    condition     = output.db_public_ip == "" && output.db_outgoing_ip == "" && module.postgres["shop-db"].link.host == "10.1.0.5"
    error_message = "복제 길이 없으면 공개 주소 출력 없음, 앱은 사설 IP"
  }
}
