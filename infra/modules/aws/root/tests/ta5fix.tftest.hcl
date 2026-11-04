# TA5fix: cache·objectStore·queue 가 계약(tf-kinds.ts TfVars) 모양 그대로 받는지 + 죽은 편지 큐 + 종류별 거부. mock provider, plan 만
mock_provider "aws" {
  mock_data "aws_eks_cluster" {
    defaults = {
      endpoint              = "https://ABC.gr7.ap-northeast-2.eks.amazonaws.com"
      certificate_authority = [{ data = "bW9jaw==" }]
      vpc_config            = [{ cluster_security_group_id = "sg-0123456789abcdef0" }]
    }
  }
  mock_data "aws_eks_cluster_auth" {
    defaults = { token = "mock-token" }
  }
}
mock_provider "kubernetes" {}

variables {
  expected_account_id   = "123456789012"
  region                = "ap-northeast-2"
  app_name              = "shop"
  tenant_id             = "t-aaaa1111"
  cluster_name          = "platform-eks"
  vpc_id                = "vpc-0123456789abcdef0"
  db_subnet_ids_json    = "[\"subnet-a\",\"subnet-b\"]"
  k8s_namespace         = "app-shop"
  app_role_boundary_arn = "arn:aws:iam::123456789012:policy/platform-app-boundary"
  postgres_json         = "[]"
  namespace_json        = "[]"
  identity_json         = "[]"
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

# 정상: 계약 memory_mib → 노드 급, tls=false 면 redis:// , 클러스터 모드면 샤드 수
run "aws_cache_fields_mapped" {
  command = plan
  variables {
    cache_json = jsonencode([
      { id = "small", name = "shop-small", engine = "redis", version = null, memory_mib = 2048, cluster_mode = null, shards = null, tls = false, auth = null, ha = null, allow_from_json = "[]" },
      { id = "big", name = "shop-big", engine = "valkey", version = null, memory_mib = null, cluster_mode = true, shards = 3, tls = null, auth = null, ha = true, allow_from_json = "[]" },
    ])
  }
  assert {
    condition     = module.cache["small"].link.port == "6379" && startswith(module.cache["small"].link.url, "redis://")
    error_message = "tls=false 면 redis://"
  }
  assert {
    condition     = startswith(module.cache["big"].link.url, "rediss://")
    error_message = "tls=null 이면 상품 기본(켬) rediss://"
  }
}

# 거부: memcached 는 아직 없음 (루트 변수 검증)
run "aws_cache_memcached_rejected" {
  command = plan
  variables {
    cache_json = jsonencode([{ id = "mc", name = "shop-mc", engine = "memcached" }])
  }
  expect_failures = [var.cache_json]
}

# 정상: model topic = SNS, ordered 면 .fifo
run "aws_topic_model_sns" {
  command = plan
  variables {
    queue_json = jsonencode([{ id = "events", name = "shop-events", model = "topic", ordered = true }])
  }
  assert {
    condition     = module.queue["events"].name == "shop-events.fifo"
    error_message = "topic+ordered 는 FIFO SNS"
  }
}
