# FM-CLD-14: IR 종류로 켤 GCP API 가 정해지는지 (진짜 GCP 없이 plan 만). 짝: packages/adapters gcpRequiredApis
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
  mock_data "google_project" {
    defaults = { number = "123456789012" }
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
  postgres_json = jsonencode([
    { id = "shop-db", name = "shop-db-ab12", major_version = "16", storage_gb = 20, storage_max_gb = null, instance_class = null, ha = null, read_replicas = null, parameters_json = "{}", logical_replication = true, allow_from_json = "[\"api\"]", public = false, peer_cidrs_json = "[]", public_subnet_ids_json = null, deletion_protection = false },
  ])
  namespace_json = jsonencode([{ name = "app-shop", quota_cpu_m = null, quota_memory_mi = null }])
  identity_json  = jsonencode([{ id = "api", name = "app-shop-api", service_account = "api", secret_names_json = "[]" }])
}

run "three_tier_apis" {
  command = plan
  assert {
    condition     = toset(keys(google_project_service.required)) == toset(["iam.googleapis.com", "secretmanager.googleapis.com", "sqladmin.googleapis.com"])
    error_message = "3티어(postgres·identity) 는 iam·secretmanager·sqladmin 만 켜야 함"
  }
  assert {
    condition     = alltrue([for s in google_project_service.required : s.disable_on_destroy == false])
    error_message = "지울 때 API 를 끄면 안 됨"
  }
}

run "nothing_no_apis" {
  command = plan
  variables {
    postgres_json  = "[]"
    identity_json  = "[]"
    namespace_json = "[]"
  }
  assert {
    condition     = length(google_project_service.required) == 0
    error_message = "종류가 없으면 아무 API 도 안 켬"
  }
}
