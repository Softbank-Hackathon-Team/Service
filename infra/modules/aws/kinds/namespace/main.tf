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
# Argo CD 허브가 이 구역에 앱을 배포하게 할지. 허브를 켠 플랫폼(ARGO_HUB_ROLE_ARN)에서 워커가 apply 때 켠다
variable "hub_deploy" {
  type    = bool
  default = false
}

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

# 허브(고객 svc-deploy → 접근 항목 그룹 platform:deploy)는 이 구역 안에서만 앱을 배포한다. 클러스터 전체 묶음은 없다.
# ClusterRole platform-deploy-app 은 고객이 부트스트랩 때 한 번 적용한다 (infra/permissions/eks-deploy-rbac.yaml).
# 실행 그룹 platform:operate 가 만들 수 있는 묶음은 이 모양 하나뿐이다 (eks-operate-namespace-rbac.yaml 의 bind 와 VAP)
resource "kubernetes_role_binding_v1" "hub_deploy" {
  count = var.hub_deploy ? 1 : 0
  metadata {
    name      = "platform-deploy-app"
    namespace = kubernetes_namespace_v1.this.metadata[0].name
  }
  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "ClusterRole"
    name      = "platform-deploy-app"
  }
  subject {
    api_group = "rbac.authorization.k8s.io"
    kind      = "Group"
    name      = "platform:deploy"
  }
}

output "name" { value = kubernetes_namespace_v1.this.metadata[0].name }
output "hub_subject" { value = one(kubernetes_role_binding_v1.hub_deploy[*].subject[0].name) }
output "hub_role_ref" { value = one(kubernetes_role_binding_v1.hub_deploy[*].role_ref[0]) }
