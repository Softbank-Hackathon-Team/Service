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
# Argo CD 허브가 들어오는 회사 전용 플랫폼 SA. 빈 값이면 허브 권한을 만들지 않는다
variable "hub_principal" {
  type    = string
  default = ""
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

# 허브는 이 구역 안에서만 앱을 배포한다. 클러스터 전체 권한(ClusterRoleBinding)은 없다.
# 목록은 infra/permissions/eks-deploy-rbac.yaml 과 같다. 쓰기에 Secret 은 External Secrets 가 만들어서 없다. 읽기는 Argo 캐시 때문에 구역 안 전부
# DRAFT(ai): EKS 와 달리 고객이 kubectl 을 돌리지 않게 Role 도 Terraform 이 만든다. 그래서 실행 역할에 container.roles.escalate·bind 가 필요하다
resource "kubernetes_role_v1" "hub_deploy" {
  count = var.hub_principal != "" ? 1 : 0
  metadata {
    name      = "platform-deploy-app"
    namespace = kubernetes_namespace_v1.this.metadata[0].name
  }
  rule {
    api_groups = [""]
    resources  = ["services", "configmaps", "serviceaccounts", "persistentvolumeclaims"]
    verbs      = ["get", "list", "watch", "create", "update", "patch", "delete"]
  }
  rule {
    api_groups = [""]
    resources  = ["pods", "events"]
    verbs      = ["get", "list", "watch"]
  }
  rule {
    api_groups = ["apps"]
    resources  = ["deployments", "statefulsets", "replicasets"]
    verbs      = ["get", "list", "watch", "create", "update", "patch", "delete"]
  }
  rule {
    api_groups = ["batch"]
    resources  = ["jobs", "cronjobs"]
    verbs      = ["get", "list", "watch", "create", "update", "patch", "delete"]
  }
  rule {
    api_groups = ["networking.k8s.io"]
    resources  = ["ingresses"]
    verbs      = ["get", "list", "watch", "create", "update", "patch", "delete"]
  }
  rule {
    api_groups = ["autoscaling"]
    resources  = ["horizontalpodautoscalers"]
    verbs      = ["get", "list", "watch", "create", "update", "patch", "delete"]
  }
  rule {
    api_groups = ["external-secrets.io"]
    resources  = ["externalsecrets"]
    verbs      = ["get", "list", "watch", "create", "update", "patch", "delete"]
  }
  # Argo CD 클러스터 캐시는 이 구역의 네임스페이스 종류를 전부 list·watch 한다 (replicationcontrollers·CRD 포함).
  # 하나라도 막히면 캐시가 안 서서 동기화가 멈추므로 읽기만 전부 연다. 쓰기는 위 목록 그대로. Secret 도 읽힌다 (이 구역 안만)
  rule {
    api_groups = ["*"]
    resources  = ["*"]
    verbs      = ["get", "list", "watch"]
  }
}

resource "kubernetes_role_binding_v1" "hub_deploy" {
  count = var.hub_principal != "" ? 1 : 0
  metadata {
    name      = "platform-deploy-app"
    namespace = kubernetes_namespace_v1.this.metadata[0].name
  }
  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "Role"
    name      = kubernetes_role_v1.hub_deploy[0].metadata[0].name
  }
  # GKE 는 구글 서비스 계정 이메일을 사용자 이름으로 본다
  subject {
    api_group = "rbac.authorization.k8s.io"
    kind      = "User"
    name      = var.hub_principal
  }
}

output "name" { value = kubernetes_namespace_v1.this.metadata[0].name }
output "hub_subject" { value = one(kubernetes_role_binding_v1.hub_deploy[*].subject[0].name) }
output "hub_role_resources" { value = flatten(kubernetes_role_v1.hub_deploy[*].rule[*].resources) }
# 모든 종류(*)에 걸린 동사. 읽기(get·list·watch)만이어야 한다
output "hub_role_wildcard_verbs" { value = flatten([for role in kubernetes_role_v1.hub_deploy : [for r in role.rule : r.verbs if contains(r.resources, "*")]]) }
