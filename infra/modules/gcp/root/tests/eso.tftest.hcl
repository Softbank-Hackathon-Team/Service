# B-2 (나): ESO(external-secrets/external-secrets KSA)가 읽는 그릇마다 읽기 바인딩 1개. 프로젝트 번호는 그릇 이름에서 읽는다
mock_provider "google" {
  override_during = plan # 그릇 이름(projects/<번호>/secrets/…)을 plan 에서 바로 본다
  mock_resource "google_secret_manager_secret" {
    defaults = { name = "projects/123456789012/secrets/app-shop-x" }
  }
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
    { id = "shop-db", name = "shop-db-ab12", major_version = "16", storage_gb = 20, storage_max_gb = null, instance_class = null, ha = null, read_replicas = null, parameters_json = "{}", logical_replication = true, allow_from_json = "[\"api\"]", public = false, peer_cidrs_json = "[]", public_subnet_ids_json = null, deletion_protection = true },
  ])
  namespace_json = jsonencode([{ name = "app-shop", quota_cpu_m = null, quota_memory_mi = null }])
  identity_json = jsonencode([
    { id = "api", name = "app-shop-api", service_account = "api", secret_names_json = "[\"JWT_SECRET\",\"SHARED\"]" },
    { id = "web", name = "app-shop-web", service_account = "web", secret_names_json = "[\"SHARED\"]" },
  ])
}

run "k8s_binds_each_secret_eso_reads" {
  command = plan
  assert {
    condition     = toset(keys(google_secret_manager_secret_iam_member.eso)) == toset(["postgres/shop-db", "identity/api/JWT_SECRET", "identity/api/SHARED"])
    error_message = "ESO 읽기 = DB 비밀번호 + 신원이 만든 그릇마다 하나 (공유 그릇은 한 번)"
  }
  assert {
    condition = alltrue([for b in google_secret_manager_secret_iam_member.eso : b.role == "roles/secretmanager.secretAccessor" &&
    b.member == "principal://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/demo-project.svc.id.goog/subject/ns/external-secrets/sa/external-secrets"])
    error_message = "주체는 ESO KSA(external-secrets/external-secrets)의 principal://, 프로젝트 번호는 그릇 이름에서"
  }
  assert {
    condition     = google_secret_manager_secret_iam_member.eso["postgres/shop-db"].secret_id == "projects/123456789012/secrets/app-shop-x"
    error_message = "바인딩은 그릇 하나 단위 (프로젝트 단위 아님)"
  }
}

run "cluster_less_no_eso" {
  command = plan
  variables {
    cluster_name = ""
  }
  assert {
    condition     = length(google_secret_manager_secret_iam_member.eso) == 0
    error_message = "클러스터 없으면 ESO 도 WI 풀도 없다 → 바인딩 0"
  }
}

# 관리형·VM 도착은 앱 구역(namespace_json)이 비어 있다 → ESO 가 읽지 않는다
run "no_namespace_no_eso" {
  command = plan
  variables {
    namespace_json = "[]"
    identity_json  = "[]"
  }
  assert {
    condition     = length(module.postgres) == 1 && length(google_secret_manager_secret_iam_member.eso) == 0
    error_message = "k8s 앱 구역이 없으면 DB 비밀번호에도 ESO 바인딩 없음"
  }
}

# 입구 파드 비밀(터널·지표 토큰): 루트가 값 없는 그릇을 만들고 ESO 에 그릇마다 읽기를 준다
run "ingress_secrets_made_and_bound" {
  command = plan
  variables {
    ingress_secret_names_json = jsonencode(["cloudflared-token", "svc-metric-token"])
  }
  assert {
    condition     = { for n, s in google_secret_manager_secret.ingress : n => s.secret_id } == { "cloudflared-token" = "app-shop-cloudflared-token", "svc-metric-token" = "app-shop-svc-metric-token" }
    error_message = "그릇 이름 = Builder remoteKey 규칙 app-<앱>-<k8s 이름> (svc-operate 의 app- 조건 안)"
  }
  assert {
    condition     = contains(keys(google_secret_manager_secret_iam_member.eso), "ingress/cloudflared-token") && contains(keys(google_secret_manager_secret_iam_member.eso), "ingress/svc-metric-token")
    error_message = "ESO 가 두 입구 그릇을 그릇 단위로 읽는다"
  }
}

# 앱 신원이 같은 이름 비밀을 이미 만들면 루트는 또 만들지 않는다 (같은 secret_id 두 번 = 409)
run "ingress_secret_owned_by_app_not_duplicated" {
  command = plan
  variables {
    ingress_secret_names_json = jsonencode(["cloudflared-token", "svc-metric-token"])
    identity_json = jsonencode([
      { id = "api", name = "app-shop-api", service_account = "api", secret_names_json = "[\"cloudflared-token\"]" },
    ])
  }
  assert {
    condition     = keys(google_secret_manager_secret.ingress) == ["svc-metric-token"] && contains(keys(google_secret_manager_secret_iam_member.eso), "identity/api/cloudflared-token")
    error_message = "신원이 만든 그릇은 신원 쪽으로 한 번만"
  }
}

run "ingress_secrets_need_namespace" {
  command = plan
  variables {
    ingress_secret_names_json = jsonencode(["cloudflared-token"])
    namespace_json            = "[]"
    identity_json             = "[]"
  }
  assert {
    condition     = length(google_secret_manager_secret.ingress) == 0
    error_message = "k8s 앱 구역이 없으면 입구 파드도 없다"
  }
}
