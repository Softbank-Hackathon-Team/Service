# kind: namespace (온프레 k3s) — 네임스페이스 + (선택) ResourceQuota. for_each 키 = 네임스페이스 이름.
# 클라우드 API 가 없으므로 k8s 바닥만. 앱·CNPG Cluster 는 같은 Helm 차트가 Argo CD 로 만든다 (DB = Terraform 없음).
# 변수 모양 = tf-kinds.ts NamespaceTfVars (+ 온프레 전용 DB 저장소 한도 칸은 root 가 따로 안 받음: DRAFT(ai) 아래 참고)
terraform {
  required_version = ">= 1.11"
  required_providers {
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 2.38" }
    time       = { source = "hashicorp/time", version = "~> 0.13" }
  }
}

variable "cfg" {
  type = object({
    name            = string
    quota_cpu_m     = optional(number)
    quota_memory_mi = optional(number)
  })
}
variable "app_name" { type = string }
variable "tenant_label" { type = string }

resource "kubernetes_namespace_v1" "this" {
  metadata {
    name   = var.cfg.name
    labels = { "managed-by" = "platform", app = var.app_name, tenant = var.tenant_label }
  }
}

# 실행 신원은 네임스페이스만 만들 수 있고, 안의 권한(RoleBinding)은 Kyverno 가 생성 직후 만들어 준다 → 잠깐 기다린다
# DRAFT(ai): 15초 (v1 app/ 과 같은 값). Kyverno 지연을 실측해 줄일 것
resource "time_sleep" "wait_rolebinding" {
  depends_on      = [kubernetes_namespace_v1.this]
  create_duration = "15s"
}

# 한도는 IR 에 값이 있을 때만 (null 이면 안 만듦 = 출발과 같게 제한 없음)
resource "kubernetes_resource_quota_v1" "this" {
  count      = var.cfg.quota_cpu_m != null || var.cfg.quota_memory_mi != null ? 1 : 0
  depends_on = [time_sleep.wait_rolebinding]
  metadata {
    name      = "platform-quota"
    namespace = kubernetes_namespace_v1.this.metadata[0].name
  }
  spec {
    hard = merge(
      var.cfg.quota_cpu_m != null ? { "requests.cpu" = "${var.cfg.quota_cpu_m}m" } : {},
      var.cfg.quota_memory_mi != null ? { "requests.memory" = "${var.cfg.quota_memory_mi}Mi" } : {},
    )
  }
}

# 권한이 붙은 뒤에야 다른 kind 가 이 이름을 쓰게 (netpol 등이 의존)
output "name" {
  value      = kubernetes_namespace_v1.this.metadata[0].name
  depends_on = [time_sleep.wait_rolebinding]
}
