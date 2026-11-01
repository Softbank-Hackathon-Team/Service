mock_provider "kubernetes" {}
mock_provider "time" {}
run "plan" {
  command = plan
  assert {
    condition     = kubernetes_namespace_v1.app.metadata[0].name == var.k8s_namespace
    error_message = "네임스페이스 이름이 다름"
  }
  assert {
    condition     = kubernetes_resource_quota_v1.app.spec[0].hard["requests.cpu"] == "${var.quota_cpu_m}m"
    error_message = "할당량이 어댑터 값과 다름"
  }
}
