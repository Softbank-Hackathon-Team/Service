# Argo CD 허브가 고객 EKS 에 들어가는 신원 (Pod Identity). 허브 파드는 이 역할로 고객 계정의 svc-deploy 를 빌려 EKS 토큰을 만든다
#   (Argo CD cluster Secret 의 awsAuthConfig.roleARN, apps/worker/src/gitops/bundle.ts clusterSecret).
#   고객 템플릿 ArgoHubRoleArn = 출력 argocd_hub_role_arn. 차트 argocd.hubRoleArn → api·worker ARGO_HUB_ROLE_ARN (deploy/helm/platform/README.md)
#   권한은 고객 svc-deploy 빌리기 하나뿐. 클라우드 자원 권한은 없다 (svc-deploy 도 IAM 권한 0, k8s 그룹 platform:deploy 만)
# 서비스 계정 = 공식 argo-cd 차트 기본 이름. 클러스터에 붙는 둘만: 동기화(application-controller)·화면 실시간 보기(server)

locals {
  # 고객 배포 역할 이름: packages/adapters/scripts/aws-connect-template.ts DEPLOY_ROLE_NAME 과 같아야 한다. 고객 계정 번호는 미리 모른다
  #   한 계정에 환경 여럿 (0056): 새 연결은 svc-deploy-<16진 8자> (템플릿 RoleSuffix) → 바탕-* 도 같이
  customer_deploy_role_arns   = ["arn:aws:iam::*:role/svc-deploy", "arn:aws:iam::*:role/svc-deploy-*"]
  argocd_hub_service_accounts = toset(["argocd-application-controller", "argocd-server"])
}

# 이름 고정: worker 와 같은 이유 (var.name 을 바꿔도 고객 템플릿 값이 안 바뀌게)
resource "aws_iam_role" "argocd_hub" {
  name               = "platform-argocd-hub"
  assume_role_policy = local.pod_trust
}

resource "aws_iam_role_policy" "argocd_hub" {
  name = "assume-customer-deploy"
  role = aws_iam_role.argocd_hub.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "AssumeCustomerDeployRole"
      Effect = "Allow"
      # DRAFT(ai) 【추정】 Pod Identity 세션 태그가 다음 빌리기로 넘어가서 TagSession 도 같이 둔다 (고객 svc-deploy 신뢰도 같은 두 동작)
      Action   = ["sts:AssumeRole", "sts:TagSession"]
      Resource = local.customer_deploy_role_arns
    }]
  })
}

resource "aws_eks_pod_identity_association" "argocd_hub" {
  for_each        = local.argocd_hub_service_accounts
  cluster_name    = aws_eks_cluster.this.name
  namespace       = "argocd"
  service_account = each.key
  role_arn        = aws_iam_role.argocd_hub.arn
}

output "argocd_hub_role_arn" { value = aws_iam_role.argocd_hub.arn }
