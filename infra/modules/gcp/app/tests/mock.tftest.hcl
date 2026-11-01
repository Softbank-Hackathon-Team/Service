mock_provider "google" {
  mock_data "google_container_cluster" {
    defaults = { endpoint = "10.0.0.2", master_auth = [{ cluster_ca_certificate = "bW9jaw==" }] }
  }
}
mock_provider "kubernetes" {}
mock_provider "random" {}
run "plan_with_db" {
  command = plan
  assert {
    condition     = google_sql_database_instance.db[0].settings[0].ip_configuration[0].ipv4_enabled == false
    error_message = "Cloud SQL은 사설 IP만"
  }
  assert {
    condition     = google_sql_database_instance.db[0].settings[0].edition == "ENTERPRISE"
    error_message = "db-f1-micro 는 ENTERPRISE 에디션만 받는다 (PG16 기본 ENTERPRISE_PLUS)"
  }
  assert {
    condition     = kubernetes_namespace_v1.app[0].metadata[0].name == var.k8s_namespace
    error_message = "앱 네임스페이스를 만들어야 함"
  }
  assert {
    condition     = length(google_secret_manager_secret.s) == length(jsondecode(var.secret_ids_json))
    error_message = "시크릿 그릇 수가 명세와 다름"
  }
}
# Z77: 데모 공개 DB. 공인 IP + authorized_networks 허용 목록 + 평문 거절
run "plan_public_demo_z77" {
  command = plan
  variables {
    db_public              = true
    db_peer_cidrs_json     = "[\"203.0.113.7/32\"]"
    db_deletion_protection = false
  }
  assert {
    condition     = google_sql_database_instance.db[0].settings[0].ip_configuration[0].ipv4_enabled == true && google_sql_database_instance.db[0].settings[0].ip_configuration[0].ssl_mode == "ENCRYPTED_ONLY"
    error_message = "데모 DB 는 공인 IP + 암호화만"
  }
  assert {
    condition     = [for n in google_sql_database_instance.db[0].settings[0].ip_configuration[0].authorized_networks : n.value] == ["203.0.113.7/32"]
    error_message = "authorized_networks 는 허용 목록만"
  }
  assert {
    condition     = google_sql_database_instance.db[0].deletion_protection == false
    error_message = "데모 DB 는 삭제 보호 끔"
  }
}
run "plan_public_rejects_wide_cidr_z77" {
  command = plan
  variables {
    db_public          = true
    db_peer_cidrs_json = "[\"10.0.0.0/8\"]"
  }
  expect_failures = [var.db_peer_cidrs_json]
}
# Z77 B': 앱 신원 끔 → GSA·Workload Identity·시크릿 읽기 바인딩 0개, DB 는 그대로
run "plan_no_identity_z77" {
  command = plan
  variables {
    app_identity           = false
    db_public              = true
    db_peer_cidrs_json     = "[\"203.0.113.7/32\"]"
    db_deletion_protection = false
  }
  assert {
    condition     = length(google_service_account.app) == 0 && length(google_service_account_iam_member.wi) == 0 && length(google_secret_manager_secret_iam_member.read) == 0
    error_message = "앱 신원을 끄면 IAM 부여가 없어야 함"
  }
  assert {
    condition     = length(google_sql_database_instance.db) == 1 && output.app_gsa_email == ""
    error_message = "Cloud SQL 은 그대로, GSA 출력은 빈 문자열"
  }
}
# Z77: GKE 없이 Cloud SQL 만 (cluster_name ""). 네임스페이스·앱 신원 0, DB·시크릿은 그대로
run "plan_no_gke_z77" {
  command = plan
  variables {
    cluster_name           = ""
    db_public              = true
    db_peer_cidrs_json     = "[\"203.0.113.7/32\"]"
    db_deletion_protection = false
  }
  assert {
    condition     = length(kubernetes_namespace_v1.app) == 0 && length(google_service_account.app) == 0 && length(google_service_account_iam_member.wi) == 0 && length(google_secret_manager_secret_iam_member.read) == 0
    error_message = "GKE 없으면 네임스페이스·앱 신원을 만들지 않아야 함"
  }
  assert {
    condition     = length(google_sql_database_instance.db) == 1 && google_sql_database_instance.db[0].settings[0].ip_configuration[0].ipv4_enabled == true
    error_message = "GKE 없어도 Cloud SQL 은 만들어야 함"
  }
  assert {
    condition     = output.namespace == "" && output.app_gsa_email == ""
    error_message = "GKE 없으면 namespace·app_gsa_email 출력은 빈 값"
  }
}
