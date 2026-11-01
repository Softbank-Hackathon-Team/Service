# 온프레(k3s) 도착 "앱 한 개" 모듈: 클라우드 API가 없으므로 k8s 바닥만 만든다.
#   네임스페이스 + 할당량 + 기본 차단 네트워크 정책.
# 앱·CloudNativePG Cluster는 같은 Helm 차트(gitops/charts/app, database.mode=cnpg)가 Argo CD로 만든다.
# CNPG 오퍼레이터·ESO·cloudflared 설치는 infra/onprem/bootstrap 몫.
terraform {
  required_version = ">= 1.11"
  required_providers {
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 2.38" }
    time       = { source = "hashicorp/time", version = "~> 0.13" }
  }
}

variable "kube_context" { type = string }
variable "kubeconfig_path" {
  type    = string
  default = "~/.kube/config"
}
variable "app_name" { type = string }
variable "tenant_id" { type = string }
variable "k8s_namespace" { type = string }
variable "quota_cpu_m" { type = number }
variable "quota_memory_mi" { type = number }
variable "db_enabled" { type = bool }
variable "db_storage_gb" { type = number }

provider "kubernetes" {
  config_path    = var.kubeconfig_path
  config_context = var.kube_context
}

resource "kubernetes_namespace_v1" "app" {
  metadata {
    name   = var.k8s_namespace
    labels = { "managed-by" = "platform", app = var.app_name }
  }
}

# 실행 신원은 클러스터 전체에선 네임스페이스만 만들 수 있다. 이 안의 권한(RoleBinding)은 Kyverno가
# 네임스페이스 생성 직후 만들어 준다 (infra/permissions/onprem-kyverno-platform.yaml) → 잠깐 기다린다
# DRAFT(ai): 15초. Kyverno 백그라운드 처리 지연을 실측해 줄일 것
resource "time_sleep" "wait_rolebinding" {
  depends_on      = [kubernetes_namespace_v1.app]
  create_duration = "15s"
}

resource "kubernetes_resource_quota_v1" "app" {
  depends_on = [time_sleep.wait_rolebinding]
  metadata {
    name      = "platform-quota"
    namespace = kubernetes_namespace_v1.app.metadata[0].name
  }
  spec {
    hard = {
      "requests.cpu"           = "${var.quota_cpu_m}m"
      "requests.memory"        = "${var.quota_memory_mi}Mi"
      "requests.storage"       = "${max(var.db_storage_gb, 1) * 2}Gi"
      "persistentvolumeclaims" = var.db_enabled ? "4" : "0"
    }
  }
}

# 기본: 같은 네임스페이스 + cloudflared + CNPG 오퍼레이터만 들어옴
resource "kubernetes_network_policy_v1" "default" {
  depends_on = [time_sleep.wait_rolebinding]
  metadata {
    name      = "default-deny-ingress"
    namespace = kubernetes_namespace_v1.app.metadata[0].name
  }
  spec {
    pod_selector {}
    policy_types = ["Ingress"]
    ingress {
      from {
        pod_selector {}
      }
      from {
        namespace_selector {
          match_labels = { "kubernetes.io/metadata.name" = "cnpg-system" }
        }
      }
    }
  }
}

output "namespace" { value = kubernetes_namespace_v1.app.metadata[0].name }
