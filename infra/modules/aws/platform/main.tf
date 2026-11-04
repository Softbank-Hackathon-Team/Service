# 플랫폼(제어판) 자체: 네트워크(VPC) + EKS(노드 그룹 general·cred·sandbox) + 저장소(ECR·RDS Postgres·증거 S3)를 한 번의 apply 로 만든다. 사람이 한 번 돌린다.
# 플랫폼 DB 는 general·cred 노드에서만 들어온다 (sandbox 는 불가). state 는 aws/bootstrap 장부 버킷 (backend.tf)
# External Secrets(ESO) 권한(Pod Identity)과 비밀 그릇도 여기서: 플랫폼 비밀은 Secrets Manager → ESO → 클러스터 Secret. 앱 파드 권한(worker·api Pod Identity)은 pod-identity.tf
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
  default = "platform"
}
variable "db_engine_version" {
  type    = string
  default = "16" # 로컬 docker-compose 의 postgres:16 과 맞춤
}
variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro" # DRAFT(ai): 데모 비용 최소. 부하 보고 올린다
}
variable "db_allocated_storage" {
  type    = number
  default = 20
}
# 끄면 DB 마지막 스냅샷 없이, 버킷은 안의 버전째, ECR 은 이미지째 지운다 (그날 파기하는 데모용)
variable "deletion_protection" {
  type    = bool
  default = true
}
# aws/env(10.40.0.0/16)·gcp/env(10.50~10.56) 와 겹치지 않게. 같은 계정에 aws/env 와 같이 뜰 수 있다
variable "cidr" {
  type    = string
  default = "10.30.0.0/16"
}
# 설계 그림의 az-a / az-c. aws_availability_zones 앞 2개는 2a·2b 라 쓰지 않는다
variable "azs" {
  type    = list(string)
  default = ["ap-northeast-2a", "ap-northeast-2c"]
  validation {
    condition     = length(var.azs) == 2
    error_message = "azs 는 2개여야 한다 (서브넷 종류마다 AZ 하나씩)."
  }
}
# DRAFT(ai): 설계 문서의 1.33 은 2026-07-29 표준 지원 종료(연장 지원 요금). 1.35 는 2027-03 까지 표준 지원. 팀 확인 필요
# TODO(human): vCluster 는 설계 때 v0.30.2 로 확인했다. 호스트 1.35 호환은 아직 확인 안 함
variable "k8s_version" {
  type    = string
  default = "1.35"
}
# 사람(운영자)이 kubectl을 쓸 IAM 주체 ARN (aws/env 와 같음)
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
variable "team_admin_arns" {
  description = "팀원 kubectl admin. cluster creator와 admin_principal_arn에 들어간 ARN은 넣지 말 것(중복 에러)"
  type        = list(string)
  default = [
    "arn:aws:iam::725072160743:user/Jeong",
    "arn:aws:iam::725072160743:user/jeong-cli",
    "arn:aws:iam::725072160743:user/lee-jeong",
    "arn:aws:iam::725072160743:user/oh-chaegeon",
    "arn:aws:iam::725072160743:user/park-seungjun",
    "arn:aws:iam::725072160743:user/park-sojeong",
  ]
}
# 노드 그룹 3개. 바깥 입력을 받는 파드가 뚫려 노드가 털려도 고객 자격(cred)에 못 닿게 나눈다
# DRAFT(ai): 크기는 전부 최소값. 원래 기준은 "서버 2대(2vCPU/4GB) + 샌드박스 1대", 늘어난 비용은 팀 미결
# general: 웹 콘솔·API·cloudflared·Kyverno·ESO·Prometheus·Grafana·OTel·AI 워커.
# 파드 수 한도는 prefix delegation 으로 풀었다. 2단계 배포 후 메모리가 모자라면 desired 3 → t3.large 순으로 늘린다
variable "general_nodes" {
  type    = object({ instance_type = string, desired = number, min = number, max = number })
  default = { instance_type = "t3.medium", desired = 2, min = 1, max = 3 }
}
# cred: 워커 ×2, Argo CD 허브 (고객 자격을 쥔 파드만)
variable "cred_nodes" {
  type    = object({ instance_type = string, desired = number, min = number, max = number })
  default = { instance_type = "t3.medium", desired = 1, min = 1, max = 2 }
}
# sandbox: vCluster, 앱 파드
variable "sandbox_nodes" {
  type    = object({ instance_type = string, desired = number, min = number, max = number })
  default = { instance_type = "t3.medium", desired = 1, min = 1, max = 2 }
}
# sandbox 노드에 gVisor(runsc) 설치. 리허설은 runc 로 돌고 AI 에이전트 수정 고리만 RuntimeClass gvisor(handler runsc)를 쓴다 (ADR-006)
# DRAFT(ai): 기본 끔. 켜고 끌 때마다 launch template 새 버전이 생겨 sandbox 노드가 교체된다.
# 켤 때는 deploy/helm/platform 의 sandbox.gvisor.enabled 도 같이 켠다 (RuntimeClass 는 차트가 만든다)
variable "sandbox_gvisor_enabled" {
  type    = bool
  default = false
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.expected_account_id]
  default_tags {
    tags = { managed-by = "platform", stack = var.name }
  }
}

locals {
  # .github/workflows/build.yml 의 이미지 이름(svc-<app>)과 같게
  images = toset(["svc-api", "svc-worker", "svc-agent-worker", "svc-web"])
  # taint 없는 general 에 coredns 처럼 toleration 없는 파드가 간다. 2단계 Helm nodeSelector 는 라벨 pool 을 쓴다
  node_groups = {
    general = merge(var.general_nodes, { taint = null, role_arn = aws_iam_role.node.arn })
    cred    = merge(var.cred_nodes, { taint = "cred", role_arn = aws_iam_role.node.arn })
    sandbox = merge(var.sandbox_nodes, { taint = "sandbox", role_arn = aws_iam_role.sandbox_node.arn })
  }

  # DRAFT(ai): 20261026.0 판 고정 (바로 다음 판 20261102.0 은 나온 지 이틀이라 한 주 앞 판). 노드 AMI 가 x86_64 라 x86_64 묶음만.
  # 해시는 버킷의 .sha512 파일이 아니라 여기 적은 값과 맞춘다: 버킷 쪽 파일이 바뀌어도 다른 바이너리가 깔리지 않게
  gvisor = {
    url    = "https://storage.googleapis.com/gvisor/releases/release/20261026.0/x86_64/gvisor.tar.bz2"
    sha512 = "26e4a327565f5da0f73261a6387e2c20f4695a232e330095a3111b70efd604fdf09d734e8cc8f714dbb5c5607ce8c87ea80b26df549d83a146f2efd5a1af448a"
  }
  # 관리형 노드 그룹이 이 MIME 에 자기 NodeConfig(클러스터 정보)를 덧붙이고, nodeadm 이 NodeConfig 들을 합친다.
  # 순서: nodeadm-config(containerd 설정 쓰기) → cloud-init 셸 스크립트(바이너리 설치) → nodeadm-run(containerd·kubelet 시작)
  # containerd 설정은 v2 경로(io.containerd.grpc.v1.cri)로만 쓴다. containerd 판은 nodeadm 이 보고 고른다:
  #   1.x 면 그대로 합치고, 2.x(AL2023 저장소는 2.3) 면 v2 틀로 합친 뒤 `containerd config migrate` 로 io.containerd.cri.v1.runtime 경로로 옮긴다.
  #   v3 경로가 문자열로라도 들어가면 nodeadm 은 v3 설정으로 보고 1.x 에서 부팅을 멈춘다. 두 경로를 같이 쓰면 2.x 에서 v2 키가 남는다
  #   (amazon-eks-ami nodeadm/internal/containerd/config.go getConfigTemplateVersion)
  # runsc.toml systemd-cgroup: AL2023 kubelet·runc 가 systemd cgroup 드라이버라 runsc 도 맞춘다
  # 내려받기나 해시 확인이 실패해도 노드는 runc 로 뜬다. 그때 gvisor 파드는 shim 이 없어 시작하지 못한다 (닫힌 쪽)
  sandbox_gvisor_user_data = <<-EOT
    MIME-Version: 1.0
    Content-Type: multipart/mixed; boundary="==SBXGVISOR=="

    --==SBXGVISOR==
    Content-Type: application/node.eks.aws

    ---
    apiVersion: node.eks.aws/v1alpha1
    kind: NodeConfig
    spec:
      containerd:
        config: |
          [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc]
          runtime_type = "io.containerd.runsc.v1"
          [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc.options]
          TypeUrl = "io.containerd.runsc.v1.options"
          ConfigPath = "/etc/containerd/runsc.toml"

    --==SBXGVISOR==
    Content-Type: text/x-shellscript; charset="us-ascii"

    #!/bin/bash
    set -euo pipefail
    work=$(mktemp -d)
    curl -fsSL --retry 5 -o "$work/gvisor.tar.bz2" "${local.gvisor.url}"
    echo "${local.gvisor.sha512}  $work/gvisor.tar.bz2" | sha512sum -c -
    python3 -c 'import sys, tarfile; t = tarfile.open(sys.argv[1]); [t.extract(n, sys.argv[2]) for n in ("runsc", "containerd-shim-runsc-v1")]' "$work/gvisor.tar.bz2" "$work"
    install -m 0755 "$work/runsc" "$work/containerd-shim-runsc-v1" /usr/local/bin/
    mkdir -p /etc/containerd
    printf '[runsc_config]\n  systemd-cgroup = "true"\n' > /etc/containerd/runsc.toml
    rm -rf "$work"
    /usr/local/bin/runsc --version

    --==SBXGVISOR==--
  EOT
}

# --- 네트워크: 공개(NAT·LB) 2 + 사설 앱(노드) 2 + 사설 DB 2. NAT 게이트웨이 1개 (DRAFT(ai): 데모 비용)
# 워커 → 고객 DB, Argo CD 허브 → 고객 클러스터 요청은 이 NAT 하나로 나간다 (출력 nat_public_ip)
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
  availability_zone       = var.azs[count.index]
  map_public_ip_on_launch = true
  tags                    = { Name = "${var.name}-public-${count.index}", "kubernetes.io/role/elb" = "1" }
}

resource "aws_subnet" "private_app" {
  count             = 2
  vpc_id            = aws_vpc.this.id
  cidr_block        = cidrsubnet(var.cidr, 4, count.index + 8)
  availability_zone = var.azs[count.index]
  tags              = { Name = "${var.name}-private-app-${count.index}", "kubernetes.io/role/internal-elb" = "1" }
}

resource "aws_subnet" "private_db" {
  count             = 2
  vpc_id            = aws_vpc.this.id
  cidr_block        = cidrsubnet(var.cidr, 4, count.index + 12)
  availability_zone = var.azs[count.index]
  tags              = { Name = "${var.name}-private-db-${count.index}" }
}

resource "aws_eip" "nat" { domain = "vpc" }

resource "aws_nat_gateway" "this" {
  allocation_id = aws_eip.nat.id
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

resource "aws_route_table" "private_app" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this.id
  }
}

# DB 서브넷은 인터넷 경로가 없다 (VPC 안 경로만)
resource "aws_route_table" "private_db" { vpc_id = aws_vpc.this.id }

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private_app" {
  count          = 2
  subnet_id      = aws_subnet.private_app[count.index].id
  route_table_id = aws_route_table.private_app.id
}

resource "aws_route_table_association" "private_db" {
  count          = 2
  subnet_id      = aws_subnet.private_db[count.index].id
  route_table_id = aws_route_table.private_db.id
}

# --- EKS: API 인증 = access entry, IRSA 대신 Pod Identity. 감사 로그 켬 (보안 표 AUD-01)
resource "aws_iam_role" "cluster" {
  name = "${var.name}-cluster"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "eks.amazonaws.com" }, Action = ["sts:AssumeRole", "sts:TagSession"] }]
  })
}

resource "aws_iam_role_policy_attachment" "cluster" {
  role       = aws_iam_role.cluster.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}

# EKS 가 이 이름으로 로그를 쓴다. 먼저 만들어야 보존 기간이 걸린다 (없으면 EKS 가 무기한으로 만든다)
# DRAFT(ai): 7일, 데모 비용. 보존 기간은 저장비만 줄인다. 수집량(GB) 요금은 따로이고 audit 이 대부분이다
resource "aws_cloudwatch_log_group" "eks" {
  name              = "/aws/eks/${var.name}/cluster"
  retention_in_days = 7
}

resource "aws_eks_cluster" "this" {
  name     = var.name
  version  = var.k8s_version
  role_arn = aws_iam_role.cluster.arn
  # EKS 가 따로 까는 vpc-cni·kube-proxy·coredns 가 아래 애드온과 충돌하지 않게
  bootstrap_self_managed_addons = false
  enabled_cluster_log_types     = ["audit", "authenticator"]

  access_config {
    authentication_mode = "API"
    # admin_principal_arn 이 비었을 때만 만든 사람에게 admin (만든 뒤에는 못 바꿈 → 바꾸면 클러스터 재생성)
    bootstrap_cluster_creator_admin_permissions = var.admin_principal_arn == ""
  }
  vpc_config {
    subnet_ids              = concat(aws_subnet.private_app[*].id, aws_subnet.public[*].id)
    endpoint_private_access = true
    # DRAFT(ai): 공개 주소 켬. TODO(human): 허용 대역(public_access_cidrs) 제한.
    # 2단계 배포 파이프라인(GitHub Actions + Helm)이 이 API 에 붙어야 하므로 그 경로를 같이 정한다
    endpoint_public_access = true
  }
  depends_on = [aws_iam_role_policy_attachment.cluster, aws_cloudwatch_log_group.eks]
}

# 노드 그룹별 보안 그룹. 규칙 0개: 플랫폼 RDS 인그레스가 출처로 가리키는 표식으로만 쓴다
# 노드끼리·컨트롤 플레인과의 통신은 같이 붙는 클러스터 SG(자기 참조 전부 허용)가 맡는다. 보안 그룹은 합집합이라 여기 규칙을 더하지 않는다.
# Terraform 이 새 SG 의 기본 나가는 규칙을 지우지만 나가는 길도 클러스터 SG 가 허용한다
# 그래서 sandbox 노드도 NAT 로 인터넷에 나간다. sandbox → RDS 는 db_from_nodes 가 막는다
# TODO(human): sandbox 인터넷 차단은 클러스터 SG 를 떼야 한다. 그 전에 ECR·S3·EC2·STS·EKS Auth VPC 엔드포인트와 ghcr.io 이미지 미러가 필요
resource "aws_security_group" "node" {
  for_each    = toset(["general", "cred", "sandbox"])
  name        = "${var.name}-node-${each.key}"
  description = "Marker for ${each.key} nodes (rules live on the cluster SG)"
  vpc_id      = aws_vpc.this.id
}

# 노드 역할: general·cred 가 같이 쓴다. CNI 권한(AmazonEKS_CNI_Policy)은 노드가 아니라 vpc-cni 애드온의 Pod Identity 로 준다
resource "aws_iam_role" "node" {
  name = "${var.name}-node"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "node" {
  for_each = toset([
    "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
  ])
  role       = aws_iam_role.node.name
  policy_arn = each.value
}

# sandbox 전용 역할: 노드 동작 + 이미지 읽기만. 다른 그룹과 역할을 나눠 나중에 따로 좁힐 수 있게
resource "aws_iam_role" "sandbox_node" {
  name = "${var.name}-sandbox-node"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "sandbox_node" {
  for_each = toset([
    "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
  ])
  role       = aws_iam_role.sandbox_node.name
  policy_arn = each.value
}

# vpc-cni(aws-node 서비스 계정) 역할. 신뢰는 aws/app 앱 역할과 같은 모양
# 이 연결이 잘못되면 모든 노드가 NotReady 가 된다. 첫 apply 에서 노드가 안 올라오면 여기부터 확인
resource "aws_iam_role" "vpc_cni" {
  name = "${var.name}-vpc-cni"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "pods.eks.amazonaws.com" }
      Action    = ["sts:AssumeRole", "sts:TagSession"]
    }]
  })
}

resource "aws_iam_role_policy_attachment" "vpc_cni" {
  role       = aws_iam_role.vpc_cni.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy"
}

# launch template 에 SG 를 주면 EKS 가 클러스터 SG 를 자동으로 안 붙인다 → 빼면 컨트롤 플레인 통신이 끊긴다
# AMI 는 지정하지 않는다: 그래야 관리형 노드 그룹이 max-pods 를 계산해 넣는다 (prefix delegation 이면 110)
# TODO(human): 노드의 max-pods 가 110 으로 올라갔는지 첫 apply 뒤 확인 (kubectl describe node | grep pods:). 17 이면 방법을 정한다
resource "aws_launch_template" "node" {
  for_each               = local.node_groups
  name                   = "${var.name}-${each.key}"
  vpc_security_group_ids = [aws_security_group.node[each.key].id, aws_eks_cluster.this.vpc_config[0].cluster_security_group_id]
  # IMDSv2 필수 + hop limit 1: 파드(hostNetwork 아님)가 노드 역할 자격을 못 가져간다.
  # Pod Identity 에이전트(169.254.170.23)는 IMDS 가 아니라 영향 없다. 2단계에서 IMDS 로 리전·VPC 를 찾는 파드는 값으로 넘긴다
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
  # DRAFT(ai): sandbox 만, sandbox_gvisor_enabled 일 때만 runsc 설치 + containerd 등록 (local.sandbox_gvisor_user_data). RuntimeClass 는 deploy/helm/platform
  # TODO(human): 첫 apply 뒤 실제 노드에서 runsc 등록·gvisor 파드 기동 확인. 바이너리를 인터넷(storage.googleapis.com)에서 받을지 미러에서 받을지
  user_data = each.key == "sandbox" && var.sandbox_gvisor_enabled ? base64encode(local.sandbox_gvisor_user_data) : null
}

# vpc-cni·kube-proxy·eks-pod-identity-agent DaemonSet 은 모든 taint 를 견디므로 세 그룹 모두에 뜬다
resource "aws_eks_node_group" "this" {
  for_each        = local.node_groups
  cluster_name    = aws_eks_cluster.this.name
  node_group_name = each.key
  node_role_arn   = each.value.role_arn
  subnet_ids      = aws_subnet.private_app[*].id
  ami_type        = "AL2023_x86_64_STANDARD"
  instance_types  = [each.value.instance_type]
  labels          = { pool = each.key }
  launch_template {
    id      = aws_launch_template.node[each.key].id
    version = aws_launch_template.node[each.key].latest_version
  }
  scaling_config {
    desired_size = each.value.desired
    min_size     = each.value.min
    max_size     = each.value.max
  }
  # cred: 워커·Argo CD 허브만, sandbox: vCluster·앱 파드만 (toleration 은 2단계 Helm 값에서 준다)
  dynamic "taint" {
    for_each = each.value.taint == null ? [] : [each.value.taint]
    content {
      key    = "dedicated"
      value  = taint.value
      effect = "NO_SCHEDULE"
    }
  }
  # 노드가 Ready 되려면 CNI 가 먼저 있어야 하고, CNI 권한을 Pod Identity 로 받으므로 agent 도 먼저
  depends_on = [
    aws_iam_role_policy_attachment.node,
    aws_iam_role_policy_attachment.sandbox_node,
    aws_eks_addon.vpc_cni,
    aws_eks_addon.kube_proxy,
    aws_eks_addon.pod_identity,
  ]
}

# --- 애드온. DRAFT(ai): 버전은 고정하지 않는다 (EKS 가 k8s_version 에 주는 기본 버전, 리허설마다 기본 버전이 바뀔 수 있음)
resource "aws_eks_addon" "pod_identity" {
  cluster_name                = aws_eks_cluster.this.name
  addon_name                  = "eks-pod-identity-agent"
  resolve_conflicts_on_create = "OVERWRITE"
}

# enableNetworkPolicy: 클러스터 NetworkPolicy(sandbox → DB 차단 두 번째 겹)를 쓰려고 켠다. 정책 YAML 은 2단계
# prefix delegation: t3.medium 노드당 파드 17개 한도를 푼다
resource "aws_eks_addon" "vpc_cni" {
  cluster_name                = aws_eks_cluster.this.name
  addon_name                  = "vpc-cni"
  resolve_conflicts_on_create = "OVERWRITE"
  configuration_values = jsonencode({
    enableNetworkPolicy = "true"
    env                 = { ENABLE_PREFIX_DELEGATION = "true", WARM_PREFIX_TARGET = "1" }
  })
  pod_identity_association {
    role_arn        = aws_iam_role.vpc_cni.arn
    service_account = "aws-node"
  }
  depends_on = [aws_iam_role_policy_attachment.vpc_cni, aws_eks_addon.pod_identity]
}

resource "aws_eks_addon" "kube_proxy" {
  cluster_name                = aws_eks_cluster.this.name
  addon_name                  = "kube-proxy"
  resolve_conflicts_on_create = "OVERWRITE"
}

# Deployment 라 노드가 없으면 DEGRADED 로 apply 가 멈춘다 → 노드 그룹 뒤
resource "aws_eks_addon" "coredns" {
  cluster_name                = aws_eks_cluster.this.name
  addon_name                  = "coredns"
  resolve_conflicts_on_create = "OVERWRITE"
  depends_on                  = [aws_eks_node_group.this]
}

# --- 사람 운영자 kubectl 접근 (DRAFT(ai)): 값이 있을 때만. 클러스터 전체 admin
resource "aws_eks_access_entry" "admin" {
  count         = var.admin_principal_arn != "" ? 1 : 0
  cluster_name  = aws_eks_cluster.this.name
  principal_arn = var.admin_principal_arn
  type          = "STANDARD"
}

resource "aws_eks_access_policy_association" "admin" {
  count         = var.admin_principal_arn != "" ? 1 : 0
  cluster_name  = aws_eks_cluster.this.name
  principal_arn = aws_eks_access_entry.admin[0].principal_arn
  policy_arn    = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"
  access_scope {
    type = "cluster"
  }
}

# --- 팀원 kubectl 접근: 전원 클러스터 admin
resource "aws_eks_access_entry" "team" {
  for_each      = toset(var.team_admin_arns)
  cluster_name  = aws_eks_cluster.this.name
  principal_arn = each.value
  type          = "STANDARD"
}

resource "aws_eks_access_policy_association" "team" {
  for_each      = aws_eks_access_entry.team
  cluster_name  = aws_eks_cluster.this.name
  principal_arn = each.value.principal_arn
  policy_arn    = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"
  access_scope {
    type = "cluster"
  }
}

# --- 이미지 저장소: 플랫폼 앱 4개. 태그는 못 바꾸고(커밋 SHA), 올릴 때 스캔
# (고객 이미지 복사용 ECR "platform" 은 ../env 에 따로 있다)
resource "aws_ecr_repository" "app" {
  for_each             = local.images
  name                 = each.key
  image_tag_mutability = "IMMUTABLE"
  force_delete         = !var.deletion_protection
  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  for_each   = aws_ecr_repository.app
  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep last 10 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 10 }
      action       = { type = "expire" }
    }]
  })
}

# --- 플랫폼 DB: 표 + 작업 큐(pg-boss). 마스터 사용자 = 마이그레이션을 돌리는 표 주인(platform_owner)
resource "aws_db_subnet_group" "db" {
  name       = "${var.name}-db"
  subnet_ids = aws_subnet.private_db[*].id
}

resource "aws_security_group" "db" {
  name        = "${var.name}-db-sg"
  description = "Platform Postgres from general and cred node groups only"
  vpc_id      = aws_vpc.this.id
}

# 규칙을 SG 안 블록 대신 따로 둔다: 출처를 바꿔도 규칙이 남거나 꼬이지 않는다
# sandbox → DB 차단 첫 번째 겹: general·cred 노드 SG 에서만 5432 (두 번째 겹은 클러스터 NetworkPolicy, 2단계)
resource "aws_vpc_security_group_ingress_rule" "db_from_nodes" {
  for_each                     = toset(["general", "cred"])
  security_group_id            = aws_security_group.db.id
  description                  = "Postgres from ${each.key} nodes"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.node[each.key].id
}

# 파라미터 그룹 없음: RDS Postgres 15+ 는 기본값이 rds.force_ssl=1 (평문 접속 거절)
resource "aws_db_instance" "db" {
  identifier                  = "${var.name}-db"
  engine                      = "postgres"
  engine_version              = var.db_engine_version
  instance_class              = var.db_instance_class
  allocated_storage           = var.db_allocated_storage
  storage_encrypted           = true
  db_name                     = "platform"
  username                    = "platform_owner"
  manage_master_user_password = true # 비밀번호는 RDS 가 Secrets Manager 에 둔다 (state 에 비밀 0). 클러스터로는 ESO 가 가져온다
  db_subnet_group_name        = aws_db_subnet_group.db.name
  vpc_security_group_ids      = [aws_security_group.db.id]
  publicly_accessible         = false
  ca_cert_identifier          = "rds-ca-rsa2048-g1"
  backup_retention_period     = 1
  deletion_protection         = var.deletion_protection
  skip_final_snapshot         = !var.deletion_protection
  final_snapshot_identifier   = var.deletion_protection ? "${var.name}-db-final" : null
}

# --- 증거 버킷: 이전 회차마다 남기는 파일 (<회사>/<이전 id>/...). 버전 관리로 덮어써도 이전 판이 남는다
# Terraform 장부(state) 버킷과 따로 둔다: 증거 쓰기 권한으로 장부를 못 건드리게
# DRAFT(ai): Object Lock 은 안 켠다 (버킷 만들 때만 켤 수 있고, 켜면 데모 뒤 정리가 막힌다)
resource "aws_s3_bucket" "evidence" {
  bucket        = "${var.name}-evidence-${var.expected_account_id}" # 버킷 이름은 전 세계 하나라 계정 번호를 붙인다
  force_destroy = !var.deletion_protection
}

resource "aws_s3_bucket_public_access_block" "evidence" {
  bucket                  = aws_s3_bucket.evidence.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "evidence" {
  bucket = aws_s3_bucket.evidence.id
  versioning_configuration {
    status = "Enabled"
  }
}

# 암호화는 S3 기본(SSE-S3)을 그대로 쓴다. 여기서는 TLS 없는 요청만 막는다
resource "aws_s3_bucket_policy" "evidence" {
  bucket = aws_s3_bucket.evidence.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.evidence.arn, "${aws_s3_bucket.evidence.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
  depends_on = [aws_s3_bucket_public_access_block.evidence]
}

# --- 비밀 연동 (External Secrets). Pod Identity 는 서비스 계정 하나에 역할 하나
# 차트(deploy/helm/platform)의 SecretStore 가 이 역할로 읽는다
locals {
  pod_trust = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "pods.eks.amazonaws.com" }
      Action    = ["sts:AssumeRole", "sts:TagSession"]
    }]
  })
}

# 비밀 그릇: 값은 사람이 콘솔·CLI 로 넣는다 (state 에 비밀 0). ESO 가 클러스터 Secret 으로 가져온다
#   app: api·worker·agent-worker 환경변수 JSON (DATABASE_URL, JWT_SECRET, ANTHROPIC_API_KEY ...)
#   cloudflared: Cloudflare Tunnel 토큰 하나 (키 TUNNEL_TOKEN)
resource "aws_secretsmanager_secret" "platform" {
  for_each                = toset(["app", "cloudflared"])
  name                    = "${var.name}/${each.key}"
  recovery_window_in_days = var.deletion_protection ? 7 : 0
}

# External Secrets 컨트롤러 (공식 차트 기본: 네임스페이스·서비스 계정 external-secrets). 플랫폼 비밀 2개 + RDS 마스터 비밀만 읽는다
resource "aws_iam_role" "eso" {
  name               = "${var.name}-external-secrets"
  assume_role_policy = local.pod_trust
}

resource "aws_iam_role_policy" "eso" {
  name = "read-platform-secrets"
  role = aws_iam_role.eso.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
      Resource = concat([for s in aws_secretsmanager_secret.platform : s.arn], [aws_db_instance.db.master_user_secret[0].secret_arn])
    }]
  })
}

resource "aws_eks_pod_identity_association" "eso" {
  cluster_name    = aws_eks_cluster.this.name
  namespace       = "external-secrets"
  service_account = "external-secrets"
  role_arn        = aws_iam_role.eso.arn
}

output "vpc_id" { value = aws_vpc.this.id }
output "private_app_subnet_ids" { value = aws_subnet.private_app[*].id }
output "cluster_name" { value = aws_eks_cluster.this.name }
output "cluster_endpoint" { value = aws_eks_cluster.this.endpoint }
# 3단계 GCP WIF(Argo CD → GKE)가 이 발급자의 서비스 계정 토큰을 믿게 한다
output "cluster_oidc_issuer" { value = aws_eks_cluster.this.identity[0].oidc[0].issuer }
output "kubectl_admin" { value = var.admin_principal_arn == "" ? "cluster-creator (bootstrap)" : var.admin_principal_arn }
output "node_security_group_ids" { value = { for k, sg in aws_security_group.node : k => sg.id } }
# 고객 쪽 /32 임시 예외·클러스터 API 허용 대역에 넣을 플랫폼의 나가는 IP
output "nat_public_ip" { value = aws_eip.nat.public_ip }
output "ecr_repository_urls" { value = { for k, r in aws_ecr_repository.app : k => r.repository_url } }
output "db_address" { value = aws_db_instance.db.address }
output "db_master_secret_arn" { value = aws_db_instance.db.master_user_secret[0].secret_arn }
output "evidence_bucket" { value = aws_s3_bucket.evidence.id }
# 워커 역할에 붙일 권한의 대상: s3:PutObject·GetObject 는 "<arn>/*", ListBucket 은 "<arn>"
output "evidence_bucket_arn" { value = aws_s3_bucket.evidence.arn }
output "platform_secret_names" { value = { for k, s in aws_secretsmanager_secret.platform : k => s.name } }
# api .env 의 PLATFORM_PRINCIPAL_ARN, 고객 연결 템플릿의 PlatformPrincipalArn 에 들어가는 값 (고객 계정이 믿는 플랫폼 주체는 이것 하나)
output "worker_role_arn" { value = aws_iam_role.worker.arn }
output "api_role_arn" { value = aws_iam_role.api.arn }
