# VTA5h: cache·objectStore·queue 경계값·거부 경로 보강. 진짜 AWS 없이 plan 만 (mock provider)
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
run "bucket_name_3_ok" {
  command = plan
  variables {
    object_store_json = jsonencode([{ id = "u", name = "abc" }])
  }
  assert {
    condition     = length(module.object_store) == 1
    error_message = "3자 버킷 이름은 통과"
  }
}
run "bucket_name_63_ok" {
  command = plan
  variables {
    object_store_json = jsonencode([{ id = "u", name = join("", [for i in range(63) : "a"]) }])
  }
  assert {
    condition     = length(module.object_store) == 1
    error_message = "63자 버킷 이름은 통과"
  }
}
run "reject_bucket_name_2" {
  command = plan
  variables {
    object_store_json = jsonencode([{ id = "u", name = "ab" }])
  }
  expect_failures = [var.object_store_json]
}
run "reject_bucket_name_64" {
  command = plan
  variables {
    object_store_json = jsonencode([{ id = "u", name = join("", [for i in range(64) : "a"]) }])
  }
  expect_failures = [var.object_store_json]
}
run "reject_bucket_name_trailing_dash" {
  command = plan
  variables {
    object_store_json = jsonencode([{ id = "u", name = "my-bucket-" }])
  }
  expect_failures = [var.object_store_json]
}

# 거부: JSON 이 아닌 입력 3종, id 중복 3종
run "reject_cache_not_json" {
  command = plan
  variables {
    cache_json = "not json"
  }
  expect_failures = [var.cache_json]
}
run "reject_object_store_not_json" {
  command = plan
  variables {
    object_store_json = "{"
  }
  expect_failures = [var.object_store_json]
}
run "reject_queue_not_json" {
  command = plan
  variables {
    queue_json = "[1,"
  }
  expect_failures = [var.queue_json]
}
run "reject_cache_duplicate_id" {
  command = plan
  variables {
    cache_json = jsonencode([{ id = "c", name = "a-cache" }, { id = "c", name = "b-cache" }])
  }
  expect_failures = [var.cache_json]
}
run "reject_object_store_duplicate_id" {
  command = plan
  variables {
    object_store_json = jsonencode([{ id = "u", name = "aaa-bucket" }, { id = "u", name = "bbb-bucket" }])
  }
  expect_failures = [var.object_store_json]
}

# 경계: 클러스터가 없어도 cache·objectStore·queue 는 만든다 (k8s 에 안 기댐)
run "cluster_less_still_creates_a5" {
  command = plan
  variables {
    cluster_name      = ""
    cache_json        = jsonencode([{ id = "sessions", name = "shop-sessions" }])
    object_store_json = jsonencode([{ id = "uploads", name = "shop-uploads-ab12" }])
    queue_json        = jsonencode([{ id = "jobs", name = "shop-jobs" }])
  }
  assert {
    condition     = length(module.cache) == 1 && length(module.object_store) == 1 && length(module.queue) == 1
    error_message = "클러스터 없어도 A5 종류는 만들어야 함"
  }
}

# 경계: 3종이 postgres 와 함께 있을 때 link_outputs 는 id 별로 모두 (postgres 1 + 3종)
run "link_outputs_merges_all_kinds" {
  command = plan
  variables {
    postgres_json     = jsonencode([{ id = "shop-db", name = "shop-db-ab12", major_version = "16", storage_gb = 20 }])
    cache_json        = jsonencode([{ id = "sessions", name = "shop-sessions" }])
    object_store_json = jsonencode([{ id = "uploads", name = "shop-uploads-ab12" }])
    queue_json        = jsonencode([{ id = "jobs", name = "shop-jobs" }])
  }
  assert {
    condition     = length(keys(output.link_outputs)) == 4
    error_message = "link_outputs 는 4개 id 모두"
  }
}

# TA5fix: 서로 다른 종류가 같은 IR id 를 쓰면 계획 단계에서 거부 (예전엔 link_outputs merge 가 한쪽을 조용히 덮어씀)
run "cross_kind_same_id_rejected" {
  command = plan
  variables {
    cache_json = jsonencode([{ id = "dup", name = "shop-sessions" }])
    queue_json = jsonencode([{ id = "dup", name = "shop-jobs" }])
  }
  expect_failures = [terraform_data.kind_ids]
}

# 경계: FIFO 큐는 이름에 .fifo 가 붙는다 (표준 큐는 그대로). TA5fix: 칸 이름 fifo → 계약 ordered
run "fifo_queue_name_suffix" {
  command = plan
  variables {
    queue_json = jsonencode([{ id = "ordered", name = "shop-ordered", ordered = true }, { id = "plain", name = "shop-plain", ordered = false }])
  }
  assert {
    condition     = module.queue["ordered"].name == "shop-ordered.fifo" && module.queue["plain"].name == "shop-plain"
    error_message = "ordered=true 일 때만 .fifo"
  }
}
