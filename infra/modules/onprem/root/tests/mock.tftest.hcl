# 진짜 클러스터 없이 plan 만 (mock provider). 정상 + 거부
mock_provider "kubernetes" {}
mock_provider "time" {}

variables {
  kube_context   = "k3s-demo"
  app_name       = "shop"
  tenant_id      = "t-aaaa1111"
  k8s_namespace  = "app-shop"
  namespace_json = jsonencode([{ name = "app-shop", quota_cpu_m = 2000, quota_memory_mi = 4096 }])
  netpol_json    = jsonencode([{ id = "default", allow_namespaces_json = "[\"cnpg-system\",\"cloudflared\"]" }])
}

run "plan_namespace_and_netpol" {
  command = plan
  assert {
    condition     = length(module.namespace) == 1 && length(module.netpol) == 1
    error_message = "네임스페이스·정책이 하나씩이어야 함"
  }
  assert {
    condition     = module.namespace["app-shop"].name == "app-shop"
    error_message = "네임스페이스 이름이 다름"
  }
}

# allow-all(mirror): 정책 항목을 안 넘기면 정책을 안 만든다
run "plan_no_netpol_mirror" {
  command = plan
  variables {
    netpol_json = "[]"
  }
  assert {
    condition     = length(module.netpol) == 0
    error_message = "정책이 없어야 함 (열린 채 그대로)"
  }
}

# 거부: netpol id 중복
run "reject_duplicate_netpol_id" {
  command = plan
  variables {
    netpol_json = jsonencode([{ id = "default" }, { id = "default" }])
  }
  expect_failures = [var.netpol_json]
}

# 거부: 잘못된 JSON
run "reject_bad_json" {
  command = plan
  variables {
    namespace_json = "not-json"
  }
  expect_failures = [var.namespace_json]
}

# --- V: 경계·거부 추가
# 경계: 한도가 CPU 만 있어도 통과 (메모리 한도 키는 안 생김)
run "plan_quota_cpu_only" {
  command = plan
  variables {
    namespace_json = jsonencode([{ name = "app-shop", quota_cpu_m = 500 }])
  }
  assert {
    condition     = length(module.namespace) == 1
    error_message = "CPU 한도만 있어도 네임스페이스 하나"
  }
}

# 경계: 네임스페이스 여러 개 (키 = 이름)
run "plan_two_namespaces" {
  command = plan
  variables {
    namespace_json = jsonencode([{ name = "app-shop" }, { name = "app-shop-jobs" }])
  }
  assert {
    condition     = length(module.namespace) == 2 && contains(keys(module.namespace), "app-shop-jobs")
    error_message = "네임스페이스 2개, 키는 이름"
  }
}

# 경계: 허용 목록이 비어도 정책은 만든다 (같은 네임스페이스만)
run "plan_netpol_empty_allow" {
  command = plan
  variables {
    netpol_json = jsonencode([{ id = "default" }])
  }
  assert {
    condition     = length(module.netpol) == 1
    error_message = "허용 목록이 없어도 정책 1개"
  }
}

# 경계: id 63자는 통과
run "plan_netpol_id_63" {
  command = plan
  variables {
    netpol_json = jsonencode([{ id = join("", [for i in range(63) : "a"]) }])
  }
  assert {
    condition     = length(module.netpol) == 1
    error_message = "63자 id 는 통과"
  }
}

# 거부: id 64자
run "reject_netpol_id_64" {
  command = plan
  variables {
    netpol_json = jsonencode([{ id = join("", [for i in range(64) : "a"]) }])
  }
  expect_failures = [var.netpol_json]
}

# 거부: id 대문자
run "reject_netpol_id_upper" {
  command = plan
  variables {
    netpol_json = jsonencode([{ id = "Default" }])
  }
  expect_failures = [var.netpol_json]
}
