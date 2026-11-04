# 진짜 AWS 없이 plan만: 기본 구성 / DB 인그레스 / kubectl admin 세 갈래 / 데모 파기
# plan 에서는 계산값(SG ID, 클러스터 SG ID, OIDC 주소)이 정해지지 않으므로 override_during = plan 으로 고정값을 준다
mock_provider "aws" {
  override_during = plan
  mock_resource "aws_eks_cluster" {
    defaults = {
      vpc_config = { cluster_security_group_id = "sg-0cluster" }
      identity   = [{ oidc = [{ issuer = "https://oidc.eks.ap-northeast-2.amazonaws.com/id/MOCK" }] }]
    }
  }
  mock_resource "aws_security_group" {
    defaults = { id = "sg-0db" }
  }
  # 경로를 적지 않은 라우팅 테이블(사설 DB)은 경로가 비어 있다
  mock_resource "aws_route_table" {
    defaults = { route = [] }
  }
}
override_resource {
  target          = aws_subnet.private_db[0]
  override_during = plan
  values          = { id = "subnet-0db-a" }
}
override_resource {
  target          = aws_subnet.private_db[1]
  override_during = plan
  values          = { id = "subnet-0db-c" }
}
# 노드 SG 세 개는 서로 구분되게 각각 다른 id
override_resource {
  target          = aws_security_group.node["general"]
  override_during = plan
  values          = { id = "sg-0general" }
}
override_resource {
  target          = aws_security_group.node["cred"]
  override_during = plan
  values          = { id = "sg-0cred" }
}
override_resource {
  target          = aws_security_group.node["sandbox"]
  override_during = plan
  values          = { id = "sg-0sandbox" }
}
# worker·api 정책이 버킷 ARN 을 쓴다. mock 은 arn 을 plan 때 모르므로 고정값
override_resource {
  target          = aws_s3_bucket.evidence
  override_during = plan
  values          = { arn = "arn:aws:s3:::platform-evidence-123456789012" }
}
variables {
  expected_account_id = "123456789012"
}

run "storage_defaults" {
  command = plan
  assert {
    condition     = length(aws_ecr_repository.app) == 4 && alltrue([for r in aws_ecr_repository.app : r.image_tag_mutability == "IMMUTABLE" && r.image_scanning_configuration[0].scan_on_push])
    error_message = "ECR 4개 모두 태그 변경 금지 + 올릴 때 스캔이어야 함"
  }
  assert {
    condition     = aws_db_instance.db.publicly_accessible == false && aws_db_instance.db.storage_encrypted == true && aws_db_instance.db.manage_master_user_password == true
    error_message = "플랫폼 DB는 사설·암호화·RDS 관리 비밀번호여야 함"
  }
  assert {
    condition     = aws_s3_bucket_public_access_block.evidence.block_public_policy == true && aws_s3_bucket_public_access_block.evidence.restrict_public_buckets == true
    error_message = "증거 버킷은 퍼블릭 접근을 전부 막아야 함"
  }
  assert {
    condition     = aws_s3_bucket_versioning.evidence.versioning_configuration[0].status == "Enabled"
    error_message = "증거 버킷은 버전 관리가 켜져야 함"
  }
  assert {
    condition     = aws_s3_bucket.evidence.force_destroy == false && aws_db_instance.db.skip_final_snapshot == false && alltrue([for r in aws_ecr_repository.app : r.force_delete == false])
    error_message = "기본값(deletion_protection=true)이면 버킷·DB·ECR 을 그냥 지울 수 없어야 함"
  }
}

run "network" {
  command = plan
  assert {
    condition     = jsonencode([for s in concat(aws_subnet.public, aws_subnet.private_app, aws_subnet.private_db) : s.availability_zone]) == jsonencode(["ap-northeast-2a", "ap-northeast-2c", "ap-northeast-2a", "ap-northeast-2c", "ap-northeast-2a", "ap-northeast-2c"])
    error_message = "서브넷 세 종류 모두 2a·2c 에 하나씩이어야 함"
  }
  assert {
    condition     = jsonencode([for s in concat(aws_subnet.public, aws_subnet.private_app, aws_subnet.private_db) : s.cidr_block]) == jsonencode(["10.30.0.0/20", "10.30.16.0/20", "10.30.128.0/20", "10.30.144.0/20", "10.30.192.0/20", "10.30.208.0/20"])
    error_message = "서브넷 번호는 공개 0·1, 사설 앱 8·9, 사설 DB 12·13 이어야 함"
  }
  assert {
    condition     = length(aws_route_table.private_db.route) == 0 && aws_db_subnet_group.db.subnet_ids == toset(["subnet-0db-a", "subnet-0db-c"])
    error_message = "DB 서브넷 라우팅에는 인터넷 경로(0.0.0.0/0)가 없어야 하고, RDS 는 사설 DB 서브넷에 있어야 함"
  }
}

run "eks_cluster" {
  command = plan
  assert {
    condition     = aws_eks_cluster.this.version == "1.35" && aws_eks_cluster.this.bootstrap_self_managed_addons == false
    error_message = "기본 k8s_version 은 1.35, EKS 자체 애드온 설치는 꺼야 함"
  }
  assert {
    condition     = contains(aws_eks_cluster.this.enabled_cluster_log_types, "audit") && aws_cloudwatch_log_group.eks.name == "/aws/eks/platform/cluster"
    error_message = "감사 로그(audit)를 켜고, 로그 그룹을 EKS 이름 규칙으로 먼저 만들어야 함"
  }
  assert {
    condition     = output.cluster_oidc_issuer == "https://oidc.eks.ap-northeast-2.amazonaws.com/id/MOCK"
    error_message = "OIDC 발급자 주소를 출력해야 함 (3단계 GCP WIF)"
  }
}

run "node_groups" {
  command = plan
  assert {
    condition     = length(aws_eks_node_group.this) == 3 && alltrue([for k, g in aws_eks_node_group.this : g.ami_type == "AL2023_x86_64_STANDARD" && g.labels.pool == k])
    error_message = "노드 그룹 3개, AL2023, 라벨 pool=<그룹 이름>이어야 함"
  }
  assert {
    condition = (
      length(aws_eks_node_group.this["general"].taint) == 0 &&
      [for t in aws_eks_node_group.this["cred"].taint : "${t.key}=${t.value}:${t.effect}"] == ["dedicated=cred:NO_SCHEDULE"] &&
      [for t in aws_eks_node_group.this["sandbox"].taint : "${t.key}=${t.value}:${t.effect}"] == ["dedicated=sandbox:NO_SCHEDULE"]
    )
    error_message = "cred·sandbox 는 NO_SCHEDULE taint, general 은 taint 없음"
  }
  assert {
    condition     = alltrue([for k, lt in aws_launch_template.node : lt.metadata_options[0].http_tokens == "required" && lt.metadata_options[0].http_put_response_hop_limit == 1])
    error_message = "launch template 은 IMDSv2 필수, hop limit 1 이어야 함"
  }
  assert {
    condition     = alltrue([for k, lt in aws_launch_template.node : lt.vpc_security_group_ids == toset(["sg-0${k}", "sg-0cluster"])])
    error_message = "launch template 에 그룹 전용 SG 와 클러스터 SG 가 같이 붙어야 함"
  }
  assert {
    condition     = alltrue([for sg in aws_security_group.node : length(sg.ingress) == 0 && length(sg.egress) == 0])
    error_message = "노드 SG 3개에는 규칙이 없어야 함 (표식 전용)"
  }
  assert {
    condition     = aws_eks_node_group.this["sandbox"].scaling_config[0].min_size >= 1 && aws_eks_node_group.this["sandbox"].scaling_config[0].desired_size >= 1
    error_message = "sandbox 노드는 데모 전에 떠 있어야 함 (min·desired 1 이상)"
  }
  assert {
    condition     = alltrue([for lt in aws_launch_template.node : lt.user_data == null])
    error_message = "sandbox_gvisor_enabled 기본(끔)이면 어느 launch template 에도 user data(runsc 설치)가 없어야 함"
  }
}

run "sandbox_gvisor_on" {
  command = plan
  variables {
    sandbox_gvisor_enabled = true
  }
  assert {
    condition     = aws_launch_template.node["general"].user_data == null && aws_launch_template.node["cred"].user_data == null
    error_message = "켜도 general·cred 에는 runsc 를 깔지 않아야 함"
  }
  assert {
    condition = strcontains(
      base64decode(aws_launch_template.node["sandbox"].user_data),
      "curl -fsSL --retry 5 -o \"$work/gvisor.tar.bz2\" \"https://storage.googleapis.com/gvisor/releases/release/20261026.0/x86_64/gvisor.tar.bz2\""
    )
    error_message = "sandbox user data 는 고정한 판(20261026.0)의 공식 gVisor 묶음을 받아야 함"
  }
  assert {
    condition = strcontains(
      base64decode(aws_launch_template.node["sandbox"].user_data),
      "echo \"26e4a327565f5da0f73261a6387e2c20f4695a232e330095a3111b70efd604fdf09d734e8cc8f714dbb5c5607ce8c87ea80b26df549d83a146f2efd5a1af448a  $work/gvisor.tar.bz2\" | sha512sum -c -"
    )
    error_message = "받은 묶음은 설치 전에 고정한 sha512 와 맞춰야 함"
  }
  assert {
    condition     = strcontains(base64decode(aws_launch_template.node["sandbox"].user_data), "install -m 0755 \"$work/runsc\" \"$work/containerd-shim-runsc-v1\" /usr/local/bin/")
    error_message = "runsc 와 containerd-shim-runsc-v1 을 containerd PATH(/usr/local/bin)에 깔아야 함"
  }
  # NodeConfig 문서가 YAML 로 읽혀야 nodeadm 이 받는다. 핸들러 이름 runsc 는 차트 RuntimeClass 의 handler 와 같아야 한다
  assert {
    condition = (
      yamldecode(split("\n---\n", split("--==SBXGVISOR==", base64decode(aws_launch_template.node["sandbox"].user_data))[1])[1]).kind == "NodeConfig" &&
      strcontains(
        yamldecode(split("\n---\n", split("--==SBXGVISOR==", base64decode(aws_launch_template.node["sandbox"].user_data))[1])[1]).spec.containerd.config,
        "[plugins.\"io.containerd.grpc.v1.cri\".containerd.runtimes.runsc]\nruntime_type = \"io.containerd.runsc.v1\""
      )
    )
    error_message = "NodeConfig containerd.config 에 runsc 런타임(io.containerd.runsc.v1)이 등록돼야 함"
  }
  assert {
    condition     = !strcontains(base64decode(aws_launch_template.node["sandbox"].user_data), "io.containerd.cri.v1")
    error_message = "v3 경로(io.containerd.cri.v1.*)가 있으면 nodeadm 이 containerd 1.x 에서 부팅을 멈춘다. v2 경로만 써야 함"
  }
}

run "cni_and_pod_identity" {
  command = plan
  assert {
    condition     = jsondecode(aws_eks_addon.vpc_cni.configuration_values).enableNetworkPolicy == "true" && jsondecode(aws_eks_addon.vpc_cni.configuration_values).env.ENABLE_PREFIX_DELEGATION == "true"
    error_message = "vpc-cni 는 네트워크 정책과 prefix delegation 을 켜야 함"
  }
  assert {
    condition     = [for a in aws_eks_addon.vpc_cni.pod_identity_association : a.service_account] == ["aws-node"]
    error_message = "CNI 권한은 aws-node 서비스 계정의 Pod Identity 로 줘야 함"
  }
  assert {
    condition     = alltrue([for a in concat(values(aws_iam_role_policy_attachment.node), values(aws_iam_role_policy_attachment.sandbox_node)) : !endswith(a.policy_arn, "AmazonEKS_CNI_Policy")])
    error_message = "노드 역할에는 CNI 권한이 없어야 함"
  }
  assert {
    condition     = jsondecode(aws_iam_role.vpc_cni.assume_role_policy).Statement[0].Principal.Service == "pods.eks.amazonaws.com"
    error_message = "CNI 역할은 Pod Identity(pods.eks.amazonaws.com)만 믿어야 함"
  }
}

run "db_ingress_from_general_and_cred_only" {
  command = plan
  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.db_from_nodes) == 2 && toset([for r in aws_vpc_security_group_ingress_rule.db_from_nodes : r.referenced_security_group_id]) == toset(["sg-0general", "sg-0cred"])
    error_message = "DB 인그레스는 정확히 2개, 출처는 general·cred 노드 SG 여야 함"
  }
  assert {
    condition     = alltrue([for r in aws_vpc_security_group_ingress_rule.db_from_nodes : r.referenced_security_group_id != "sg-0sandbox" && r.from_port == 5432 && r.to_port == 5432 && r.security_group_id == "sg-0db"])
    error_message = "sandbox 노드 SG 에서는 DB 로 못 들어와야 하고, 5432 만 열려야 함"
  }
}

run "no_admin_principal_bootstrap" {
  command = plan
  assert {
    condition     = aws_eks_cluster.this.access_config[0].bootstrap_cluster_creator_admin_permissions == true
    error_message = "비우면 만든 사람 admin(bootstrap)이 켜져야 함"
  }
  assert {
    condition     = length(aws_eks_access_entry.admin) == 0 && length(aws_eks_access_policy_association.admin) == 0
    error_message = "비우면 admin access entry를 만들지 않아야 함"
  }
}

run "with_admin_principal" {
  command = plan
  variables {
    admin_principal_arn = "arn:aws:iam::123456789012:role/PlatformAdmin"
  }
  assert {
    condition     = aws_eks_cluster.this.access_config[0].bootstrap_cluster_creator_admin_permissions == false
    error_message = "주면 bootstrap admin은 꺼야 함"
  }
  assert {
    condition     = aws_eks_access_policy_association.admin[0].policy_arn == "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy" && aws_eks_access_policy_association.admin[0].access_scope[0].type == "cluster"
    error_message = "ClusterAdminPolicy를 클러스터 범위로 연결해야 함"
  }
}

run "reject_assumed_role_arn" {
  command = plan
  variables {
    admin_principal_arn = "arn:aws:sts::123456789012:assumed-role/PlatformAdmin/me"
  }
  expect_failures = [var.admin_principal_arn]
}

run "demo_teardown" {
  command = plan
  variables {
    deletion_protection = false
  }
  assert {
    condition     = aws_s3_bucket.evidence.force_destroy == true && aws_db_instance.db.skip_final_snapshot == true && aws_db_instance.db.deletion_protection == false && alltrue([for r in aws_ecr_repository.app : r.force_delete == true])
    error_message = "deletion_protection=false 면 그날 지울 수 있어야 함"
  }
}

run "eso_secrets" {
  command = plan
  assert {
    condition     = aws_eks_pod_identity_association.eso.namespace == "external-secrets" && aws_eks_pod_identity_association.eso.service_account == "external-secrets"
    error_message = "ESO 역할은 external-secrets/external-secrets 에 묶여야 함 (공식 차트 기본값)"
  }
  assert {
    condition     = jsondecode(aws_iam_role.eso.assume_role_policy).Statement[0].Principal.Service == "pods.eks.amazonaws.com"
    error_message = "ESO 역할은 Pod Identity(pods.eks.amazonaws.com)만 믿어야 함"
  }
  assert {
    condition     = toset([for s in aws_secretsmanager_secret.platform : s.name]) == toset(["platform/app", "platform/cloudflared"]) && alltrue([for s in aws_secretsmanager_secret.platform : s.recovery_window_in_days == 7])
    error_message = "비밀 그릇 2개(platform/app, platform/cloudflared), 기본은 7일 복구 창"
  }
}

# worker·api Pod Identity (pod-identity.tf)
run "pod_identity" {
  command = plan
  assert {
    condition = (
      aws_eks_pod_identity_association.worker.namespace == "platform" && aws_eks_pod_identity_association.worker.service_account == "worker" &&
      aws_eks_pod_identity_association.api.namespace == "platform" && aws_eks_pod_identity_association.api.service_account == "api"
    )
    error_message = "worker 는 platform/worker, api 는 platform/api 서비스 계정에 묶여야 함"
  }
  assert {
    condition     = alltrue([for r in [aws_iam_role.worker, aws_iam_role.api] : [for st in jsondecode(r.assume_role_policy).Statement : st.Principal] == [{ Service = "pods.eks.amazonaws.com" }]])
    error_message = "worker·api 역할은 Pod Identity(pods.eks.amazonaws.com)만 믿어야 함"
  }
  assert {
    condition     = aws_iam_role.worker.name == "platform-worker" && aws_iam_role.api.name == "platform-api"
    error_message = "역할 이름은 platform-worker·platform-api (고객 템플릿 시험 예시와 같음)"
  }
  assert {
    condition = (
      toset(flatten([for st in jsondecode(aws_iam_role_policy.worker.policy).Statement : st.Resource if contains(st.Action, "sts:AssumeRole")])) == toset(["arn:aws:iam::*:role/svc-observe", "arn:aws:iam::*:role/svc-operate"]) &&
      !anytrue([for st in jsondecode(aws_iam_role_policy.worker.policy).Statement : anytrue([for r in st.Resource : r == "*" || endswith(r, ":role/*")])])
    )
    error_message = "worker AssumeRole 대상은 svc-observe·svc-operate 만, role/* 나 * 는 없어야 함"
  }
  assert {
    condition     = !anytrue([for st in jsondecode(aws_iam_role_policy.worker.policy).Statement : anytrue([for r in st.Resource : strcontains(r, "tf-state")])])
    error_message = "worker 에는 tf-state 역할 권한이 없어야 함 (고객 이전 state 위치 미정)"
  }
  assert {
    condition     = [for st in jsondecode(aws_iam_role_policy.worker.policy).Statement : st.Resource if contains(st.Action, "s3:PutObject")] == [["arn:aws:s3:::platform-evidence-123456789012/*"]]
    error_message = "worker 는 증거 버킷 객체에만 쓸 수 있어야 함"
  }
  assert {
    condition     = !anytrue([for st in jsondecode(aws_iam_role_policy.api.policy).Statement : contains(st.Action, "s3:PutObject") || contains(st.Action, "s3:DeleteObject")])
    error_message = "api 는 증거 버킷을 읽기만 해야 함 (PutObject 없음)"
  }
  assert {
    condition     = toset(flatten([for st in jsondecode(aws_iam_role_policy.api.policy).Statement : st.Action])) == toset(["s3:GetObject", "s3:ListBucket"])
    error_message = "api 권한은 s3:GetObject·s3:ListBucket 둘뿐이어야 함"
  }
}
