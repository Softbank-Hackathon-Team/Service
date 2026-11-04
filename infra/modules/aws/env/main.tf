# AWS 도착 환경 부트스트랩 (테넌트 계정마다 한 번): VPC + EKS + ECR.
# 앱마다 도는 ../app 모듈이 이 출력(vpc_id, db_subnet_ids, cluster_name)을 받는다.
# DRAFT(ai): 데모 비용 최소 구성 — AZ 2개, NAT 게이트웨이 1개, 노드 t3.medium 2대
terraform {
  required_version = ">= 1.11"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "expected_account_id" { type = string }
variable "region" {
  type    = string
  default = "ap-northeast-2"
}
variable "name" {
  type    = string
  default = "platform-target"
}
variable "cidr" {
  type    = string
  default = "10.40.0.0/16"
}
# PF02 FM-CLD-11 DRAFT(ai): 1.33 은 2026-07-29 표준 지원이 끝나 연장 지원 요금(제어부 시간당 $0.10→$0.60)이었다 (11/4 실측 supportType=EXTENDED).
#   aws/platform 모듈과 같은 1.35 (2027-03 까지 표준 지원). 이미 있는 클러스터는 아래 lifecycle 로 안 건드린다
variable "k8s_version" {
  type    = string
  default = "1.35"
}
# 워커의 실행 역할 ARN. 주면 EKS access entry를 만들어 k8s 그룹 platform:operate에 묶는다 (넓은 정책 연결 없음)
variable "operate_role_arn" {
  type    = string
  default = ""
}
# 사람(운영자)이 kubectl을 쓸 IAM 주체 ARN (DRAFT(ai), 맥 실측 401 대응).
#   주면: 그 주체에 access entry + AmazonEKSClusterAdminPolicy(클러스터 전체) 연결, 만든 사람 자동 admin은 끔
#   비우면: bootstrap_cluster_creator_admin_permissions = true → terraform을 돌린 주체가 admin (데모용)
# 예: arn:aws:iam::<계정>:role/<SSO 역할> 또는 arn:aws:iam::<계정>:user/<이름>. assumed-role ARN(sts)은 안 됨
variable "admin_principal_arn" {
  type    = string
  default = ""
  validation {
    condition     = var.admin_principal_arn == "" || can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:(role|user)/", var.admin_principal_arn))
    error_message = "admin_principal_arn 은 비우거나 IAM role/user ARN 이어야 한다 (arn:aws:sts::…:assumed-role/… 은 안 됨)."
  }
}
# Z77 DRAFT(ai): false 면 EKS·노드 그룹·애드온·access entry·NAT 를 안 만든다 (VPC·서브넷·IGW·경계 정책·ECR 만).
# 맥 B 회차(RDS 만 만들어 복제 재기)용. EKS 생성·파기 20분대 → 몇 분【추정】. 출력 cluster_* 는 빈 문자열
variable "create_eks" {
  type    = bool
  default = true
}
variable "node_instance_type" {
  type    = string
  default = "t3.medium"
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.expected_account_id]
  default_tags {
    tags = { managed-by = "platform", stack = var.name }
  }
}

data "aws_availability_zones" "az" { state = "available" }
locals {
  azs = slice(data.aws_availability_zones.az.names, 0, 2)
  eks = var.create_eks ? 1 : 0 # Z77
}

# --- 네트워크: 공개 서브넷(NAT·LB) 2 + 사설 서브넷(노드·DB) 2
resource "aws_vpc" "this" {
  cidr_block           = var.cidr
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags                 = { Name = var.name }
}

resource "aws_internet_gateway" "this" { vpc_id = aws_vpc.this.id }

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.this.id
  cidr_block              = cidrsubnet(var.cidr, 4, count.index)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = true
  tags                    = { Name = "${var.name}-public-${count.index}", "kubernetes.io/role/elb" = "1" }
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.this.id
  cidr_block        = cidrsubnet(var.cidr, 4, count.index + 8)
  availability_zone = local.azs[count.index]
  tags              = { Name = "${var.name}-private-${count.index}", "kubernetes.io/role/internal-elb" = "1" }
}

# NAT 는 사설 서브넷의 노드가 이미지를 받을 때만 필요하다 → EKS 를 안 만들면 같이 뺀다 (Z77)
resource "aws_eip" "nat" {
  count  = local.eks
  domain = "vpc"
}

resource "aws_nat_gateway" "this" {
  count         = local.eks
  allocation_id = aws_eip.nat[0].id
  subnet_id     = aws_subnet.public[0].id
  depends_on    = [aws_internet_gateway.this]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id
  dynamic "route" {
    for_each = aws_nat_gateway.this
    content {
      cidr_block     = "0.0.0.0/0"
      nat_gateway_id = route.value.id
    }
  }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# --- EKS: API 인증 = access entry, Pod Identity 에이전트 애드온 (앱 모듈의 association이 이걸 씀)
resource "aws_iam_role" "cluster" {
  count = local.eks
  name  = "${var.name}-cluster"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "eks.amazonaws.com" }, Action = ["sts:AssumeRole", "sts:TagSession"] }]
  })
}

resource "aws_iam_role_policy_attachment" "cluster" {
  count      = local.eks
  role       = aws_iam_role.cluster[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}

resource "aws_eks_cluster" "this" {
  count    = local.eks
  name     = var.name
  version  = var.k8s_version
  role_arn = aws_iam_role.cluster[0].arn

  access_config {
    authentication_mode = "API"
    # admin_principal_arn 이 비었을 때만 만든 사람에게 admin (만든 뒤에는 못 바꿈 → 바꾸면 클러스터 재생성)
    bootstrap_cluster_creator_admin_permissions = var.admin_principal_arn == ""
  }
  vpc_config {
    subnet_ids              = concat(aws_subnet.private[*].id, aws_subnet.public[*].id)
    endpoint_private_access = true
    endpoint_public_access  = true # DRAFT(ai): 데모용. Argo CD 허브 IP로 제한하는 건 TODO(human)
  }
  # PF02 FM-CLD-11: 표준 지원이 끝나면 연장 지원으로 넘어가지 않고 자동 업그레이드 (연장 요금 방지). 새로 만들 때만 적용
  upgrade_policy {
    support_type = "STANDARD"
  }
  # 이미 있는 클러스터(예: 1.33 으로 만든 실측 중 클러스터)는 버전·지원 정책을 바꾸지 않는다.
  #   기본값을 올려도 다음 apply 가 1.33→1.35 업그레이드(한 번에 두 단계는 EKS 가 거절)나 STANDARD 전환(곧바로 강제 업그레이드)을 하지 않게
  lifecycle {
    ignore_changes = [version, upgrade_policy]
  }
  depends_on = [aws_iam_role_policy_attachment.cluster]
}

resource "aws_iam_role" "node" {
  count = local.eks
  name  = "${var.name}-node"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "node" {
  for_each = var.create_eks ? toset([
    "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
  ]) : toset([])
  role       = aws_iam_role.node[0].name
  policy_arn = each.value
}

resource "aws_eks_node_group" "default" {
  count           = local.eks
  cluster_name    = aws_eks_cluster.this[0].name
  node_group_name = "default"
  node_role_arn   = aws_iam_role.node[0].arn
  subnet_ids      = aws_subnet.private[*].id
  instance_types  = [var.node_instance_type]
  scaling_config {
    desired_size = 2
    min_size     = 1
    max_size     = 3
  }
  depends_on = [aws_iam_role_policy_attachment.node]
}

resource "aws_eks_addon" "pod_identity" {
  count        = local.eks
  cluster_name = aws_eks_cluster.this[0].name
  addon_name   = "eks-pod-identity-agent"
}

# --- 실행 역할의 k8s 접근: 좁게 (DRAFT(ai)). 그룹 권한은 infra/permissions/eks-operate-namespace-rbac.yaml 을
# 부트스트랩 때 kubectl apply. 넓게(AmazonEKSAdminPolicy 연결)는 비상용 대안으로만
resource "aws_eks_access_entry" "operate" {
  count             = var.create_eks && var.operate_role_arn != "" ? 1 : 0
  cluster_name      = aws_eks_cluster.this[0].name
  principal_arn     = var.operate_role_arn
  kubernetes_groups = ["platform:operate"]
  type              = "STANDARD"
}

# --- 사람 운영자 kubectl 접근 (DRAFT(ai)): 값이 있을 때만. 클러스터 전체 admin
resource "aws_eks_access_entry" "admin" {
  count         = var.create_eks && var.admin_principal_arn != "" ? 1 : 0
  cluster_name  = aws_eks_cluster.this[0].name
  principal_arn = var.admin_principal_arn
  type          = "STANDARD"
}

resource "aws_eks_access_policy_association" "admin" {
  count         = var.create_eks && var.admin_principal_arn != "" ? 1 : 0
  cluster_name  = aws_eks_cluster.this[0].name
  principal_arn = aws_eks_access_entry.admin[0].principal_arn
  policy_arn    = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"
  access_scope {
    type = "cluster"
  }
}

# --- 앱 역할 권한 경계: 앱 역할이 가질 수 있는 최대치 (플랫폼 시크릿 읽기만).
# 실행 역할은 이 경계를 붙여야만 app-* 역할을 만들거나 인라인 정책을 넣을 수 있다 (위협 모델 A-4)
# 본문 원본: infra/permissions/aws-app-role-boundary.json (packages/adapters 에서 자동 생성)
# Z77 B': EKS 없이(create_eks=false) 만들면 앱 역할을 안 만드므로 경계 정책도 뺀다
resource "aws_iam_policy" "app_boundary" {
  count  = local.eks
  name   = "platform-app-boundary"
  policy = file("${path.module}/../../../permissions/aws-app-role-boundary.json")
}

# --- 이미지 저장소: 원본 digest 그대로 복사해 둘 곳 (platform/<tenant>/<app>)
resource "aws_ecr_repository" "platform" {
  name                 = "platform"
  image_tag_mutability = "IMMUTABLE"
  # GATE DRAFT(ai): 데모 저장소. 이미지가 하나라도 남으면 destroy 가 RepositoryNotEmpty 로 막혀 자원 0 이 안 된다 → 같이 지운다
  force_delete = true
  image_scanning_configuration {
    scan_on_push = true
  }
}

output "vpc_id" { value = aws_vpc.this.id }
output "app_role_boundary_arn" { value = var.create_eks ? aws_iam_policy.app_boundary[0].arn : "" }
output "db_subnet_ids" { value = aws_subnet.private[*].id }
# Z77: 데모 공개 DB(DB_PUBLIC=1)·중계기가 쓰는 공개 서브넷 → TF_FACT_DB_PUBLIC_SUBNET_IDS_JSON
output "public_subnet_ids" { value = aws_subnet.public[*].id }
# Z77: create_eks=false 면 빈 문자열 → TF_FACT_CLUSTER_NAME="" → worker 가 배포 단계를 STUB 로 넘긴다
output "cluster_name" { value = var.create_eks ? aws_eks_cluster.this[0].name : "" }
output "cluster_endpoint" { value = var.create_eks ? aws_eks_cluster.this[0].endpoint : "" }
output "cluster_oidc_issuer" { value = var.create_eks ? aws_eks_cluster.this[0].identity[0].oidc[0].issuer : "" }
output "kubectl_admin" {
  value = !var.create_eks ? "" : var.admin_principal_arn == "" ? "cluster-creator (bootstrap)" : var.admin_principal_arn
}
output "ecr_registry" { value = split("/", aws_ecr_repository.platform.repository_url)[0] }
