# kind: netpol (온프레) — 들어오는 길 막기. for_each 키 = IR id (보통 "default" 하나).
# 같은 네임스페이스 + allow_namespaces 만 들어옴 (기본 cnpg-system·cloudflared 쪽은 어댑터가 목록에 넣음).
# IR posture.network 가 allow-all 이면 어댑터가 목록 항목을 안 넘긴다 = 이 정책을 안 만든다 = 출발과 같게 열림(mirror).
# 본문 번역(as-declared)은 보안 명세 파트 → 아직 없음 (precheck 가 막음)
terraform {
  required_version = ">= 1.11"
  required_providers {
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 2.38" }
  }
}

variable "cfg" {
  type = object({
    id                    = string
    allow_namespaces_json = optional(string, "[]")
  })
}
variable "namespace" { type = string }

locals {
  allow = jsondecode(var.cfg.allow_namespaces_json)
}

resource "kubernetes_network_policy_v1" "default" {
  metadata {
    name      = "default-deny-ingress"
    namespace = var.namespace
  }
  spec {
    pod_selector {}
    policy_types = ["Ingress"]
    ingress {
      from {
        pod_selector {}
      }
      dynamic "from" {
        for_each = local.allow
        content {
          namespace_selector {
            match_labels = { "kubernetes.io/metadata.name" = from.value }
          }
        }
      }
    }
  }
}

output "name" { value = kubernetes_network_policy_v1.default.metadata[0].name }
