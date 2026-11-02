# kind: namespace — k8s 네임스페이스 + (선택) ResourceQuota. for_each 키 = 네임스페이스 이름.
# Argo CD 울타리가 클러스터 범위 자원을 막으므로 Terraform이 만든다 (v1 app/ 모듈과 같은 이유).
# DRAFT(ai): 변수 모양은 packages/contracts/src/tf-kinds.ts NamespaceTfVars 와 같은 이름
terraform {
  required_version = ">= 1.11"
  required_providers {
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 2.38" }
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
variable "tenant_label" { type = string } # 라벨에 넣을 수 있게 root가 정리해서 넘김

resource "kubernetes_namespace_v1" "this" {
  metadata {
    name   = var.cfg.name
    labels = { "managed-by" = "platform", app = var.app_name, tenant = var.tenant_label }
  }
}

# 한도는 IR에 값이 있을 때만 (null 이면 안 만듦 = 출발과 같게 제한 없음)
resource "kubernetes_resource_quota_v1" "this" {
  count = var.cfg.quota_cpu_m != null || var.cfg.quota_memory_mi != null ? 1 : 0
  metadata {
    name      = "platform-quota"
    namespace = kubernetes_namespace_v1.this.metadata[0].name
  }
  spec {
    hard = merge(
      var.cfg.quota_cpu_m != null ? { "limits.cpu" = "${var.cfg.quota_cpu_m}m" } : {},
      var.cfg.quota_memory_mi != null ? { "limits.memory" = "${var.cfg.quota_memory_mi}Mi" } : {},
    )
  }
}

output "name" { value = kubernetes_namespace_v1.this.metadata[0].name }
