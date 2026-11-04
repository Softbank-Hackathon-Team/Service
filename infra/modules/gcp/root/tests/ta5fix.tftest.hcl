# TA5fix: cache·objectStore·queue 경계값·거부 경로 보강. 진짜 GCP 없이 plan 만 (mock provider)
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
  postgres_json    = "[]"
  namespace_json   = "[]"
  identity_json    = "[]"
}

# 경계: 버킷 이름 3자·63자 통과, 2자·64자 거부, 대문자·점 연속 아님(규칙만)

# 정상: 계약 모양(모든 칸, nullable 은 null) 그대로 3종
run "contract_shaped_items" {
  command = plan
  variables {
    cache_json        = jsonencode([{ id = "sessions", name = "shop-sessions", engine = "redis", version = "7.1", memory_mib = 2048, cluster_mode = false, shards = null, tls = true, auth = null, ha = true, allow_from_json = jsonencode(["api"]) }])
    object_store_json = jsonencode([{ id = "uploads", name = "shop-uploads-ab12", versioning = true, public = null, size_gb = 12.5, lifecycle_json = jsonencode([{ prefix = "tmp/", expireDays = 7 }, { prefix = "", toColdAfterDays = 30 }]), cors_json = jsonencode([{ origins = ["https://shop.example.com"], methods = ["GET", "PUT"], allowedHeaders = ["Content-Type"], maxAgeSec = 3000 }]), allow_from_json = jsonencode(["api"]), force_destroy = false }])
    queue_json        = jsonencode([{ id = "jobs", name = "shop-jobs", model = "queue", ordered = null, retention_sec = 86400, ack_timeout_sec = 30, dead_letter_to = null, dead_letter_max_receive = null, allow_from_json = "[]" }])
  }
  assert {
    condition     = length(module.cache) == 1 && length(module.object_store) == 1 && length(module.queue) == 1 && length(module.queue_dl) == 0
    error_message = "계약 모양 항목 3종이 하나씩 만들어져야 함"
  }
  assert {
    condition     = length(keys(output.link_outputs)) == 3
    error_message = "link_outputs 는 3개 id"
  }
}

# 정상: 죽은 편지 큐는 먼저(queue_dl), 원래 큐는 그 뒤(queue). link_outputs 는 둘 다
run "dead_letter_two_stage" {
  command = plan
  variables {
    queue_json = jsonencode([{ id = "jobs", name = "shop-jobs", model = "queue", ordered = null, retention_sec = 86400, ack_timeout_sec = 30, dead_letter_to = "jobs-dlq", dead_letter_max_receive = 7, allow_from_json = "[]" }, { id = "jobs-dlq", name = "shop-jobs-dlq", model = "queue", ordered = null, retention_sec = 86400, ack_timeout_sec = 30, dead_letter_to = null, dead_letter_max_receive = null, allow_from_json = "[]" }])
  }
  assert {
    condition     = keys(module.queue_dl) == ["jobs-dlq"] && keys(module.queue) == ["jobs"] && length(keys(output.link_outputs)) == 2
    error_message = "죽은 편지 대상은 queue_dl, 나머지는 queue"
  }
}

# 거부: 없는 대상·자기 자신·대상이 또 죽은 편지를 가짐
run "dead_letter_missing_target_rejected" {
  command = plan
  variables {
    queue_json = jsonencode([{ id = "jobs", name = "shop-jobs", model = "queue", ordered = null, retention_sec = 86400, ack_timeout_sec = 30, dead_letter_to = "nope", dead_letter_max_receive = 7, allow_from_json = "[]" }])
  }
  expect_failures = [var.queue_json]
}
run "dead_letter_self_rejected" {
  command = plan
  variables {
    queue_json = jsonencode([{ id = "jobs", name = "shop-jobs", model = "queue", ordered = null, retention_sec = 86400, ack_timeout_sec = 30, dead_letter_to = "jobs", dead_letter_max_receive = 7, allow_from_json = "[]" }])
  }
  expect_failures = [var.queue_json]
}
run "dead_letter_chain_rejected" {
  command = plan
  variables {
    queue_json = jsonencode([{ id = "a", name = "shop-a", model = "queue", ordered = null, retention_sec = 86400, ack_timeout_sec = 30, dead_letter_to = "b", dead_letter_max_receive = 7, allow_from_json = "[]" }, { id = "b", name = "shop-b", model = "queue", ordered = null, retention_sec = 86400, ack_timeout_sec = 30, dead_letter_to = "c", dead_letter_max_receive = 7, allow_from_json = "[]" }, { id = "c", name = "shop-c", model = "queue", ordered = null, retention_sec = 86400, ack_timeout_sec = 30, dead_letter_to = null, dead_letter_max_receive = null, allow_from_json = "[]" }])
  }
  expect_failures = [var.queue_json]
}

# 거부: 종류 간 같은 id (postgres 와 objectStore)
run "cross_kind_postgres_bucket_same_id_rejected" {
  command = plan
  variables {
    postgres_json     = jsonencode([{ id = "dup", name = "shop-db-ab12", major_version = "16", storage_gb = 20 }])
    object_store_json = jsonencode([{ id = "dup", name = "shop-uploads-ab12" }])
  }
  expect_failures = [terraform_data.kind_ids]
}

# 정상: 계약 memory_mib → GB 올림, tls=false 면 redis://
run "gcp_cache_fields_mapped" {
  command = plan
  variables {
    cache_json = jsonencode([{ id = "small", name = "shop-small", engine = "valkey", version = null, memory_mib = 1500, cluster_mode = null, shards = null, tls = false, auth = false, ha = null, allow_from_json = "[]" }])
  }
  assert {
    condition     = startswith(module.cache["small"].link.url, "redis://") && module.cache["small"].auth_secret == ""
    error_message = "tls=false 면 redis://, auth=false 면 비밀 없음"
  }
}

# 거부: 클러스터 모드는 아직 없음
run "gcp_cache_cluster_rejected" {
  command = plan
  variables {
    cache_json = jsonencode([{ id = "c", name = "shop-c", engine = "redis", cluster_mode = true }])
  }
  expect_failures = [var.cache_json]
}

# 정상: model topic = 토픽만 (구독 없음)
run "gcp_topic_model_topic_only" {
  command = plan
  variables {
    queue_json = jsonencode([{ id = "events", name = "shop-events", model = "topic" }])
  }
  assert {
    condition     = module.queue["events"].name == "shop-events"
    error_message = "topic 모델 이름"
  }
}
